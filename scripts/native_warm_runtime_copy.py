"""Copy a caller-selected runtime into a new, disjoint fixture.

Internal symlinks/junctions are materialized, never linked back to the source.
This byte-copy witness alone does not prove host graph or route equivalence.
Failed copies are retained for diagnosis; this module never deletes a fixture.
"""
from __future__ import annotations
import hashlib
import os
import shutil
from pathlib import Path

BLOCK = 1024 * 1024

def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        while data := stream.read(BLOCK):
            h.update(data)
    return h.hexdigest()

def inside(root: Path, target: Path) -> bool:
    return target == root or target.is_relative_to(root)

def copy_runtime(source: Path, destination: Path, *, max_files=250_000, max_bytes=8_000_000_000) -> dict:
    src = source.resolve(strict=True)
    if not source.is_absolute() or not destination.is_absolute() or not src.is_dir() or source.is_symlink() or (hasattr(source,"is_junction") and source.is_junction()):
        raise ValueError("source must be a physical directory")
    dst = destination.resolve(strict=False)
    if inside(src,dst) or inside(dst,src) or destination.exists() or destination.is_symlink():
        raise ValueError("fixture must be new and disjoint")
    # Require a pre-existing physical parent; caller owns the parent directory.
    parent = destination.parent.resolve(strict=True)
    if destination.parent.is_symlink() or dst.parent != parent:
        raise ValueError("fixture parent must be physical")
    with os.scandir(src) as iterator:
        root_names={entry.name for entry in iterator}
    allowed={"node_modules","package.json","pnpm-lock.yaml","pnpm-workspace.yaml"}
    if not {"node_modules","package.json","pnpm-lock.yaml"}.issubset(root_names) or root_names-allowed:
        raise ValueError("runtime root is not an isolated program tree")
    destination.mkdir()
    count=0; total=0; links=0; entries=[]
    def visit(origin: Path, target: Path, ancestry: frozenset[Path]) -> None:
        nonlocal count,total,links
        name=origin.name.lower()
        if name in {".npmrc",".env","auth.json","credentials.json","id_rsa","id_ed25519"} or name.startswith(".env."):
            raise ValueError("sensitive runtime file name refused")
        real=origin.resolve(strict=True)
        if not inside(src,real):
            raise ValueError("runtime link escapes source")
        linked=origin.is_symlink() or (hasattr(origin,"is_junction") and origin.is_junction())
        if linked: links += 1
        if real.is_dir():
            if real in ancestry:
                raise ValueError("runtime directory cycle")
            target.mkdir(exist_ok=False)
            with os.scandir(real) as iterator:
                children=sorted((entry.name for entry in iterator))
            for name in children:
                visit(real / name, target / name, ancestry | {real})
        elif real.is_file():
            size=real.stat().st_size
            count+=1; total+=size
            if count>max_files or total>max_bytes:
                raise ValueError("copy budget exceeded")
            # Copy byte-by-byte into an exclusively created regular file.
            before=file_sha256(real)
            with real.open("rb") as source_stream, target.open("xb") as target_stream:
                shutil.copyfileobj(source_stream,target_stream,BLOCK)
            shutil.copymode(real,target)
            if file_sha256(target)!=before or file_sha256(real)!=before:
                raise ValueError("source or destination bytes changed during copy")
            entries.append((target.relative_to(destination).as_posix(),before))
        else:
            raise ValueError("unsupported runtime entry")
    # Root already exists; traverse its children without recreating it.
    with os.scandir(src) as iterator:
        children=sorted(entry.name for entry in iterator)
    for name in children:
        visit(src/name,destination/name,frozenset({src}))
    digest=hashlib.sha256(b"dsh.warm-runtime-copy/v1\n")
    for path,sha in sorted(entries):
        digest.update(path.encode("utf-8")+b"\0"+sha.encode("ascii")+b"\n")
    return {"schema":"dsh-warm-runtime-copy/v1","files":count,"bytes":total,
            "materialized_links":links,"inventory_sha256":digest.hexdigest(),
            "graph_equivalence":"unverified"}
