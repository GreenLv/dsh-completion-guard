"""Copy an isolated runtime once, relocating its internal links.

The witness binds physical directories, file bytes and the remapped link graph.
It does not prove host graph or route equivalence. Failed copies are retained.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import tempfile
from collections import deque
from pathlib import Path

BLOCK = 1024 * 1024
SENSITIVE = {".npmrc", ".env", "auth.json", "credentials.json", "id_rsa", "id_ed25519"}


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        while data := stream.read(BLOCK):
            h.update(data)
    return h.hexdigest()


def inside(root: Path, target: Path) -> bool:
    return target == root or target.is_relative_to(root)


def is_link(path: Path) -> bool:
    return path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction())


def identity(info: os.stat_result) -> tuple:
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns)


def sensitive(name: str) -> bool:
    lowered = name.lower()
    return lowered in SENSITIVE or lowered.startswith(".env.")


def _native_target(raw: str) -> str:
    # readlink on Windows junctions can return a Windows extended-length path.
    if os.name == "nt":
        if raw.startswith("\\\\?\\UNC\\"):
            return "\\\\" + raw[8:]
        if raw.startswith("\\\\?\\"):
            return raw[4:]
    return raw


def _resolve_internal(root: Path, path: Path, steps: list[int], max_steps: int, max_hops: int) -> Path:
    """Resolve link components without entering an external path, with bounded work."""
    if not inside(root, path):
        raise ValueError("runtime link escapes source")
    pending = deque(path.relative_to(root).parts)
    current = root
    seen: set[Path] = set()
    hops = 0
    while pending:
        steps[0] += 1
        if steps[0] > max_steps:
            raise ValueError("link resolution budget exceeded")
        part = pending.popleft()
        if part == '..':
            if current == root:
                raise ValueError("runtime link escapes source")
            current = current.parent
            continue
        if sensitive(part):
            raise ValueError("sensitive runtime file name refused")
        child = current / part
        try:
            info = child.lstat()
        except (OSError, RuntimeError) as error:
            raise ValueError("runtime link target unavailable") from error
        if is_link(child):
            hops += 1
            if hops > max_hops or child in seen:
                raise ValueError("runtime link cycle or hop budget exceeded")
            seen.add(child)
            raw = _native_target(os.readlink(child))
            target = Path(raw)
            if target.is_absolute():
                if not inside(root, target):
                    raise ValueError("runtime link escapes source")
                pending = deque((*target.relative_to(root).parts, *pending))
                current = root
            else:
                # Keep '..' until preceding link components have resolved;
                # normalizing the text first changes filesystem semantics.
                pending = deque((*target.parts, *pending))
        else:
            if pending and not stat.S_ISDIR(info.st_mode):
                raise ValueError("runtime link target unavailable")
            current = child
    return current


def _check_no_directory_cycles(graph: dict[Path, list[Path]]) -> None:
    """Reject cycles while visiting each physical directory and edge once."""
    color: dict[Path, int] = {}
    for start in graph:
        if color.get(start, 0):
            continue
        color[start] = 1
        stack = [(start, iter(graph[start]))]
        while stack:
            current, children = stack[-1]
            try:
                child = next(children)
            except StopIteration:
                color[current] = 2
                stack.pop()
                continue
            if child not in graph:
                raise ValueError("runtime directory target unavailable")
            state = color.get(child, 0)
            if state == 1:
                raise ValueError("runtime directory cycle")
            if state == 0:
                color[child] = 1
                stack.append((child, iter(graph[child])))


def _checked_link_target(root: Path, link: Path, steps: list[int], max_steps: int, max_hops: int) -> Path:
    resolved = _resolve_internal(root, link, steps, max_steps, max_hops)
    try:
        observed = link.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise ValueError("runtime link target unavailable") from error
    if resolved != observed or not inside(root, observed):
        raise ValueError("runtime link resolution mismatch")
    return resolved


class LinkBatchError(OSError):
    """Bounded non-sensitive partial-progress record; fixture stays owned."""
    def __init__(self, reason: str, completed: int | None, planned: int):
        if (reason not in {'node_unavailable', 'process_unavailable_or_timeout', 'invalid_process_result',
                           'payload_budget_exceeded', 'creation_failed'} or
                type(planned) is not int or not 1 <= planned <= 250_000 or
                (completed is not None and (type(completed) is not int or not 0 <= completed <= planned))):
            raise ValueError('invalid link batch outcome')
        super().__init__("directory junction batch failed")
        self.reason = reason
        self.completed = completed
        self.planned = planned


def _uses_junctions() -> bool:
    return os.name == 'nt'


def _create_windows_junctions(pairs: list[tuple[Path, Path]]) -> None:
    """Create an already-validated batch in one non-shell Node process."""
    if not pairs:
        return
    node = shutil.which('node')
    if not node:
        raise LinkBatchError('node_unavailable', 0, len(pairs))
    # Worst-case JSON escaping is bounded before constructing the input blob.
    estimated_bytes = sum(6 * (len(os.fsencode(path)) + len(os.fsencode(target))) + 16
                          for path, target in pairs)
    if estimated_bytes > 64 * 1024 * 1024:
        raise LinkBatchError('payload_budget_exceeded', 0, len(pairs))
    script = (
        'const fs=require("node:fs");let n=0;try{'
        'const rows=JSON.parse(fs.readFileSync(0,"utf8"));'
        'for(const [target,path] of rows){fs.symlinkSync(target,path,"junction");n++}'
        'process.stdout.write(JSON.stringify({status:"passed",completed:n}))'
        '}catch(e){process.stdout.write(JSON.stringify({status:"failed",completed:n}));process.exitCode=1}'
    )
    payload = json.dumps([[str(target), str(path)] for path, target in pairs], ensure_ascii=False).encode('utf-8')
    try:
        result = subprocess.run([str(Path(node).resolve(strict=True)), '-e', script], input=payload,
                                capture_output=True, timeout=120, check=False)
    except (OSError, subprocess.SubprocessError) as error:
        raise LinkBatchError('process_unavailable_or_timeout', None, len(pairs)) from error
    try:
        response = json.loads(result.stdout)
        completed = response['completed']
        if type(completed) is not int or not 0 <= completed <= len(pairs):
            raise ValueError('invalid count')
    except (ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
        raise LinkBatchError('invalid_process_result', None, len(pairs)) from error
    if result.returncode or response.get('status') != 'passed' or completed != len(pairs):
        raise LinkBatchError('creation_failed', completed, len(pairs))


def _create_relocated_link(path: Path, target: Path, is_directory: bool) -> None:
    if _uses_junctions() and is_directory:
        # Windows junctions require an absolute target, always inside the copy.
        _create_windows_junctions([(path, target)])
    else:
        os.symlink(os.path.relpath(target, path.parent), path, target_is_directory=is_directory)


def _probe_link_capability(root: Path, *, need_directories: bool, need_files: bool) -> None:
    """Check the required link kinds before copying file contents."""
    if not need_directories and not need_files:
        return
    probe = Path(tempfile.mkdtemp(prefix='.dsh-copy-capability-', dir=root))
    if need_directories:
        target = probe / 'directory'
        target.mkdir()
        link = probe / 'directory-link'
        _create_relocated_link(link, target, True)
        if not is_link(link) or link.resolve(strict=True) != target or not inside(root, link.resolve(strict=True)):
            raise ValueError("directory link capability is unsafe")
    if need_files:
        target = probe / 'file'
        target.write_bytes(b'')
        link = probe / 'file-link'
        _create_relocated_link(link, target, False)
        if not is_link(link) or link.resolve(strict=True) != target or not inside(root, link.resolve(strict=True)):
            raise ValueError("file link capability is unsafe")
    # This owned probe contains only just-created internal links; rmtree must
    # remove links, never follow them into a source or outside the fixture.
    shutil.rmtree(probe)
    if probe.exists() or is_link(probe):
        raise OSError("link capability probe cleanup failed")


def _stream_digest(stream) -> str:
    h = hashlib.sha256()
    while data := stream.read(BLOCK):
        h.update(data)
    return h.hexdigest()


def _open_source_file(path: Path, expected: tuple, root: Path):
    if identity(path.lstat()) != expected or is_link(path):
        raise ValueError("source entry changed during copy")
    if path.resolve(strict=True) != path or not inside(root, path):
        raise ValueError("runtime source path changed")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        if identity(os.fstat(fd)) != expected:
            raise ValueError("source entry changed during copy")
        return os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise


def copy_runtime(source: Path, destination: Path, *, max_files=250_000, max_bytes=8_000_000_000,
                 max_directories=250_000, max_links=250_000, max_resolution_steps=1_000_000,
                 max_link_hops=64) -> dict:
    if not source.is_absolute() or not destination.is_absolute():
        raise ValueError("source and destination must be absolute")
    src = source.resolve(strict=True)
    if not src.is_dir() or is_link(source):
        raise ValueError("source must be a physical directory")
    dst = destination.resolve(strict=False)
    if inside(src, dst) or inside(dst, src) or destination.exists() or is_link(destination):
        raise ValueError("fixture must be new and disjoint")
    parent = destination.parent.resolve(strict=True)
    if is_link(destination.parent) or dst.parent != parent:
        raise ValueError("fixture parent must be physical")
    for value in (max_files, max_bytes, max_directories, max_links, max_resolution_steps, max_link_hops):
        if type(value) is not int or value < 0:
            raise ValueError("invalid copy budget")
    with os.scandir(src) as iterator:
        root_names = {entry.name for entry in iterator}
    allowed = {"node_modules", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"}
    if not {"node_modules", "package.json", "pnpm-lock.yaml"}.issubset(root_names) or root_names - allowed:
        raise ValueError("runtime root is not an isolated program tree")

    destination.mkdir()
    if destination.resolve(strict=True) != dst:
        raise ValueError("fixture identity changed")
    directories: dict[Path, tuple[tuple, tuple[str, ...]]] = {}
    planned_files: dict[Path, tuple] = {}
    raw_links: dict[Path, tuple[tuple, str]] = {}
    graph: dict[Path, list[Path]] = {}
    total = 0
    queued = {src: identity(src.lstat())}
    if len(queued) > max_directories:
        raise ValueError("directory copy budget exceeded")
    pending = [src]
    # Plan using metadata only. Reject unsafe graphs and missing link
    # capability before copying any file contents into the owned fixture.
    while pending:
        origin = pending.pop()
        info = origin.lstat()
        if (identity(info) != queued[origin] or is_link(origin) or
                not stat.S_ISDIR(info.st_mode) or origin.resolve(strict=True) != origin):
            raise ValueError("source directory changed during copy")
        with os.scandir(origin) as iterator:
            children = sorted(entry.name for entry in iterator)
        directories[origin] = (identity(info), tuple(children))
        graph[origin] = []
        for name in children:
            if sensitive(name):
                raise ValueError("sensitive runtime file name refused")
            child = origin / name
            info = child.lstat()
            if is_link(child):
                if len(raw_links) >= max_links:
                    raise ValueError("link copy budget exceeded")
                raw_links[child] = (identity(info), os.readlink(child))
            elif stat.S_ISDIR(info.st_mode):
                if len(queued) >= max_directories:
                    raise ValueError("directory copy budget exceeded")
                queued[child] = identity(info)
                graph[origin].append(child)
                pending.append(child)
            elif stat.S_ISREG(info.st_mode):
                if len(planned_files) >= max_files or total + info.st_size > max_bytes:
                    raise ValueError("copy budget exceeded")
                total += info.st_size
                planned_files[child] = identity(info)
            else:
                raise ValueError("unsupported runtime entry")

    steps = [0]
    relocated: dict[Path, Path] = {}
    for link, (expected, raw) in sorted(raw_links.items()):
        if identity(link.lstat()) != expected or not is_link(link) or os.readlink(link) != raw:
            raise ValueError("source link changed during copy")
        resolved = _checked_link_target(src, link, steps, max_resolution_steps, max_link_hops)
        if resolved not in directories and resolved not in planned_files:
            raise ValueError("runtime link target unavailable")
        if resolved in directories:
            graph[link.parent].append(resolved)
        relocated[link] = resolved
    _check_no_directory_cycles(graph)

    _probe_link_capability(dst, need_directories=any(t in directories for t in relocated.values()),
                           need_files=any(t in planned_files for t in relocated.values()))
    for origin in sorted(directories, key=lambda p: (len(p.parts), p)):
        if origin != src:
            output = dst / origin.relative_to(src)
            if output.parent.resolve(strict=True) != output.parent or not inside(dst, output.parent):
                raise ValueError("fixture directory changed during copy")
            output.mkdir()
    files: dict[Path, tuple[tuple, tuple, str]] = {}
    for child, expected in sorted(planned_files.items()):
        out = dst / child.relative_to(src)
        if out.parent.resolve(strict=True) != out.parent or not inside(dst, out.parent):
            raise ValueError("fixture directory changed during copy")
        with _open_source_file(child, expected, src) as source_stream:
            before = _stream_digest(source_stream)
            source_stream.seek(0)
            with out.open("xb") as target_stream:
                shutil.copyfileobj(source_stream, target_stream, BLOCK)
            source_stream.seek(0)
            if _stream_digest(source_stream) != before or identity(os.fstat(source_stream.fileno())) != expected:
                raise ValueError("source or destination bytes changed during copy")
        shutil.copymode(child, out, follow_symlinks=False)
        if file_sha256(out) != before or identity(child.lstat()) != expected:
            raise ValueError("source or destination bytes changed during copy")
        files[child] = (expected, identity(out.lstat()), before)

    directory_batch: list[tuple[Path, Path]] = []
    for link, resolved in relocated.items():
        out, mapped = dst / link.relative_to(src), dst / resolved.relative_to(src)
        expected, raw = raw_links[link]
        if identity(link.lstat()) != expected or not is_link(link) or os.readlink(link) != raw:
            raise ValueError("source link changed during copy")
        if _checked_link_target(src, link, steps, max_resolution_steps, max_link_hops) != resolved:
            raise ValueError("source link changed during copy")
        if (not inside(dst, mapped) or is_link(mapped) or mapped.resolve(strict=True) != mapped or
                out.parent.resolve(strict=True) != out.parent or not inside(dst, out.parent)):
            raise ValueError("relocated target is not a physical fixture entry")
        if _uses_junctions() and resolved in directories:
            directory_batch.append((out, mapped))
        else:
            _create_relocated_link(out, mapped, resolved in directories)
    _create_windows_junctions(directory_batch)
    for link, resolved in relocated.items():
        out, mapped = dst / link.relative_to(src), dst / resolved.relative_to(src)
        if not is_link(out) or out.resolve(strict=True) != mapped or not inside(dst, out.resolve(strict=True)):
            raise ValueError("relocated link escapes fixture")

    # Bind a stable source inventory and ensure no output link resolves back
    # into the source, including after all links have been created.
    for directory, (expected, children) in directories.items():
        if identity(directory.lstat()) != expected or is_link(directory) or directory.resolve(strict=True) != directory:
            raise ValueError("source directory changed during copy")
        with os.scandir(directory) as iterator:
            if tuple(sorted(entry.name for entry in iterator)) != children:
                raise ValueError("source directory changed during copy")
    for path, (expected, output_identity, digest) in files.items():
        with _open_source_file(path, expected, src) as stream:
            if _stream_digest(stream) != digest or identity(os.fstat(stream.fileno())) != expected:
                raise ValueError("source or destination bytes changed during copy")
        out = dst / path.relative_to(src)
        with _open_source_file(out, output_identity, dst) as stream:
            if _stream_digest(stream) != digest or identity(os.fstat(stream.fileno())) != output_identity:
                raise ValueError("source or destination bytes changed during copy")
    for link, resolved in relocated.items():
        expected, raw = raw_links[link]
        out, mapped = dst / link.relative_to(src), dst / resolved.relative_to(src)
        if identity(link.lstat()) != expected or not is_link(link) or os.readlink(link) != raw:
            raise ValueError("source link changed during copy")
        if _checked_link_target(src, link, steps, max_resolution_steps, max_link_hops) != resolved:
            raise ValueError("source link changed during copy")
        if not is_link(out) or out.resolve(strict=True) != mapped or not inside(dst, mapped):
            raise ValueError("relocated link escapes fixture")
    if destination.resolve(strict=True) != dst or is_link(destination):
        raise ValueError("fixture identity changed")
    digest = hashlib.sha256(b"dsh.warm-runtime-copy/v2\n")
    records = ([('directory', p.relative_to(src).as_posix()) for p in directories]
               + [('file', p.relative_to(src).as_posix(), sha) for p, (_, _, sha) in files.items()]
               + [('link', p.relative_to(src).as_posix(), t.relative_to(src).as_posix(),
                   'directory' if t in directories else 'file',
                   hashlib.sha256(os.fsencode(raw_links[p][1])).hexdigest()) for p, t in relocated.items()])
    for record in sorted(records):
        digest.update(json.dumps(record, ensure_ascii=False, separators=(',', ':')).encode('utf-8') + b'\n')
    return {"schema": "dsh-warm-runtime-copy/v2", "files": len(files), "bytes": total,
            "directories": len(directories), "relocated_links": len(relocated),
            "inventory_sha256": digest.hexdigest(), "graph_equivalence": "unverified"}
