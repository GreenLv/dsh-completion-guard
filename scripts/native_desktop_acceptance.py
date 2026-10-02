"""Exact-artifact Desktop backend acceptance with an owned isolated profile.

The graphical shell and real-model requests are separate required release
gates. This entrypoint never launches either or mutates a daily profile.
"""
from __future__ import annotations

import json
import os
import platform
import secrets
import signal
import shutil
import socket
import subprocess
from pathlib import Path
from typing import Any

import importlib.util
_spec = importlib.util.spec_from_file_location("native_desktop_host_helpers", Path(__file__).with_name("native_host_acceptance.py"))
assert _spec and _spec.loader
host = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(host)

DESKTOP_GATES = {
    "package_inventory", "manifest_identity", "package_parity", "isolated_install",
    "strict_second_noop", "installed_syntax", "desktop_carrier_and_graph",
    "desktop_package_parity", "single_package_strict_noop", "multi_package_semantic_noop", "desktop_installed_inspect", "desktop_host_lock",
    "desktop_host_lock_readback", "desktop_probe_composition", "desktop_loaded_backend",
    "desktop_graceful_stop", "desktop_uninstall", "desktop_cleanup",
    *("desktop_" + case for case in host.PROBE_V070_CASES),
}


# Diagnostic capture is bounded and private; it never relaxes the hash gate.
NOOP_CAPTURE_LIMIT = 4 * 1024 * 1024
NOOP_FIELDS = frozenset(("hoistPattern", "included", "layoutVersion", "nodeLinker", "packageManager",
                        "pendingBuilds", "prunedAt", "publicHoistPattern", "registries", "skipped",
                        "storeDir", "virtualStoreDir", "virtualStoreDirMaxLength", "hoistedDependencies",
                        "injectedDeps", "hoistedLocations"))


class StrictNoopFailure(RuntimeError):
    diagnostic_code = "STRICT_SECOND_NOOP_MISMATCH"

    def __init__(self, receipt: dict[str, Any]):
        super().__init__("Desktop second install was not a strict no-op")
        self.receipt = receipt


class SemanticNoopFailure(StrictNoopFailure):
    diagnostic_code = "SEMANTIC_SECOND_NOOP_MISMATCH"

    def __init__(self, receipt: dict[str, Any]):
        super().__init__(receipt)
        self.args = ("Desktop multi-package install was not a semantic no-op",)


def noop_snapshot(paths: list[Path], profile: Path) -> dict[str, bytes | None]:
    captured = {}
    for path in paths:
        relative = path.relative_to(profile)
        try:
            # The explicitly selected profile is the trust boundary. System
            # aliases above it (macOS /var, for example) are not redirects
            # inside the fixture. Refuse every redirected descendant and escape.
            descendants = (profile.joinpath(*relative.parts[:i]) for i in range(1, len(relative.parts) + 1))
            safe = path.resolve().is_relative_to(profile.resolve()) and not any(
                descendant.is_symlink() for descendant in descendants)
            data = path.read_bytes() if safe and path.is_file() and path.stat().st_size <= NOOP_CAPTURE_LIMIT else None
        except (OSError, RuntimeError):
            data = None
        captured[relative.as_posix()] = data
    return captured


def noop_difference(before: bytes, after: bytes, modules: bool = False) -> dict[str, Any]:
    count, first, last = 0, None, None
    for i, (left, right) in enumerate(zip(before, after)):
        if left != right:
            count += 1
            first = i if first is None else first
            last = i
    tail = abs(len(before) - len(after))
    receipt: dict[str, Any] = {"before_size": len(before), "after_size": len(after),
        "different_byte_count": count + tail}
    if count or tail:
        receipt["first_difference_offset"] = first if first is not None else min(len(before), len(after))
        receipt["last_difference_offset"] = max(last if last is not None else -1,
                                                 max(len(before), len(after)) - 1 if tail else -1)
    if modules:
        import re
        def blocks(data: bytes) -> dict[str, bytes]:
            matches = list(re.finditer(rb'(?m)^(?:([A-Za-z][A-Za-z0-9]*):|  "([A-Za-z][A-Za-z0-9]*)":)', data))
            return {(match.group(1) or match.group(2)).decode("ascii"): data[match.start():matches[i + 1].start() if i + 1 < len(matches) else len(data)]
                    for i, match in enumerate(matches)}
        left, right = blocks(before), blocks(after)
        changed = {key for key in left.keys() | right.keys() if left.get(key) != right.get(key)}
        receipt["changed_top_level_fields"] = sorted(changed & NOOP_FIELDS)
        receipt["other_changed_field_count"] = len(changed - NOOP_FIELDS)
    return receipt


def strict_noop_receipt(before: dict[str, str], after: dict[str, str],
                        before_bytes: dict[str, bytes | None], after_bytes: dict[str, bytes | None],
                        tree_before: str, tree_after: str, diagnostic: Path) -> dict[str, Any]:
    rows = []
    private = diagnostic.with_name(diagnostic.name + ".strict-noop-private")
    changed = [name for name in before_bytes if before.get(Path(name).name) != after.get(Path(name).name)]
    capture_status = "not_needed"
    if changed:
        try:
            private.parent.mkdir(parents=True, exist_ok=True)
            private.mkdir(mode=0o700, parents=False, exist_ok=False)
            for index, name in enumerate(changed):
                for phase, snapshots in (("before", before_bytes), ("after", after_bytes)):
                    data = snapshots[name]
                    if data is not None:
                        fd = os.open(private / f"{index}-{phase}.bin", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                        with os.fdopen(fd, "wb") as output:
                            # Local raw context is redacted before persistence; exact hashes
                            # and offsets above still describe the original in-memory bytes.
                            import re
                            redacted = re.sub(rb"(?im)^([^\r\n]*(?:token|password|secret|_auth|credential)[^:\r\n]*:).*?$",
                                              rb"\1 <redacted>", data)
                            redacted = re.sub(rb"(https?://)[^/\s\"']+@", rb"\1<redacted>@", redacted)
                            output.write(redacted)
            capture_status = "private_local_redacted"
        except OSError:
            capture_status = "unavailable"
    for name in changed:
        row: dict[str, Any] = {"file": name, "before_sha256": before.get(Path(name).name),
                               "after_sha256": after.get(Path(name).name)}
        left, right = before_bytes[name], after_bytes[name]
        row["bounded_bytes_available"] = left is not None and right is not None
        if left is not None and right is not None:
            row.update(noop_difference(left, right, name == "node_modules/.modules.yaml"))
        rows.append(row)
    return {"schema": "dsh-strict-noop-difference/v1", "files": rows,
            "package_tree_changed": tree_before != tree_after, "package_tree_before": tree_before,
            "package_tree_after": tree_after, "raw_capture": capture_status}


def check_strict_noop(before: dict[str, str], after: dict[str, str], before_bytes: dict[str, bytes | None],
                      tracked: list[Path], profile: Path, tree_before: str, tree_after: str,
                      diagnostic: Path) -> None:
    if before != after or tree_before != tree_after:
        raise StrictNoopFailure(strict_noop_receipt(before, after, before_bytes,
            noop_snapshot(tracked, profile), tree_before, tree_after, diagnostic))


def modules_json_value(data: bytes | None) -> dict[str, Any]:
    """Only the observed pnpm JSON format; duplicate keys and YAML fail closed."""
    if data is None or len(data) > NOOP_CAPTURE_LIMIT:
        raise ValueError("modules JSON unavailable")
    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate modules JSON key")
            result[key] = value
        return result
    def invalid_constant(value: str) -> None:
        raise ValueError("non-finite modules JSON constant")
    value = json.loads(data.decode("utf-8"), object_pairs_hook=unique_object, parse_constant=invalid_constant)
    if not isinstance(value, dict):
        raise ValueError("modules JSON must be an object")
    # Permit object-key order only, rather than treating arbitrary formatting
    # changes as no-op. pnpm 11.7 emits JSON.stringify(..., null, 2), no newline.
    if json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8") != data:
        raise ValueError("unsupported modules JSON serialization")
    return value


def strict_json_value_equal(left: Any, right: Any) -> bool:
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(strict_json_value_equal(left[key], right[key]) for key in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(strict_json_value_equal(a, b) for a, b in zip(left, right))
    return left == right


def check_multi_package_semantic_noop(before: dict[str, str], after: dict[str, str],
                                     before_bytes: dict[str, bytes | None], tracked: list[Path], profile: Path,
                                     tree_before: str, tree_after: str, diagnostic: Path) -> None:
    after_bytes = noop_snapshot(tracked, profile)
    reason = None
    try:
        left = modules_json_value(before_bytes.get("node_modules/.modules.yaml"))
        right = modules_json_value(after_bytes.get("node_modules/.modules.yaml"))
        if not strict_json_value_equal(left, right):
            reason = "modules_json_value_changed"
    except (ValueError, UnicodeError, RecursionError):
        reason = "modules_json_invalid_or_unavailable"
    if ({key: value for key, value in before.items() if key != ".modules.yaml"}
            != {key: value for key, value in after.items() if key != ".modules.yaml"}):
        reason = "other_tracked_bytes_changed"
    if tree_before != tree_after:
        reason = "package_tree_changed"
    if reason:
        receipt = strict_noop_receipt(before, after, before_bytes, after_bytes, tree_before, tree_after, diagnostic)
        receipt.update({"contract": "multi_package_semantic_noop", "failure_reason": reason})
        raise SemanticNoopFailure(receipt)


def desktop_driver_digest(root: Path) -> str:
    import hashlib
    files = [root / "scripts" / name for name in (
        "native_acceptance.py", "native_host_acceptance.py",
        "native_desktop_acceptance.py", "native_desktop_tools.mjs",
        *host.PROBE_V070_DRIVER_FILES)]
    return hashlib.sha256(b"".join(path.name.encode() + b"\0" + path.read_bytes() + b"\0"
                                   for path in files)).hexdigest()


def carrier(archive: Path) -> Path:
    if platform.system() == "Darwin":
        return archive.parent.parent / "MacOS" / "DeepSeek Harness"
    if platform.system() == "Windows":
        return archive.parent.parent / "DeepSeek Harness.exe"
    raise RuntimeError("Desktop native acceptance requires macOS or Windows")


def assert_slot_available() -> None:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 19387))


def electron_command(archive: Path, script: Path, *args: str) -> list[str]:
    return [str(carrier(archive)), "--expose-internals", str(script), *args]


def preflight_desktop_inputs(root: Path, archive: Path, version: str) -> None:
    """No packages installed, no host booted, same-invocation child checks."""
    if archive.name != "app.asar" or not archive.is_file() or not carrier(archive).is_file():
        raise RuntimeError("Desktop signed carrier inputs missing")
    assert_slot_available()
    host.preflight_execution_access()
    host.preflight_link_access()
    temporary = host.host_temporary_root()
    try:
        environment = host.isolated_environment(temporary)
        environment["ELECTRON_RUN_AS_NODE"] = "1"
        command = lambda *args: host.run_host_command(root, environment, *args)
        command(str(carrier(archive)), "--version")
        profile = temporary / "dsh" / "profiles" / "desktop"
        command(*electron_command(archive, root / "scripts" / "native_desktop_tools.mjs",
                                  "init", str(archive), str(profile)))
        graph = json.loads(command("node", str(root / "bin" / "dsh-completion-guard-host-lock.mjs"),
                                   "inspect-graph", "--profile", "desktop", "--runtime-root", str(archive),
                                   "--profile-root", str(profile)))
        if graph["status"] != "supported" or graph["host_version"]["version"] != version:
            raise RuntimeError("Desktop declared cohort does not match its audited archive")
    finally:
        shutil.rmtree(temporary)


def desktop_acceptance(api: Any, root: Path, artifact: Path, digest: str,
                       archive: Path, result: dict[str, Any], version: str,
                       diagnostics_output: Path) -> dict[str, Any]:
    result["gate_profile"] = "dsh-desktop-bound/v2"
    result["desktop_noop_contract"] = {"schema": "dsh-desktop-noop/v2",
        "single_package": "all_tracked_bytes_and_package_tree",
        "multi_package": "only_modules_json_object_key_order",
        "modules_format": "pnpm_json_indent_2_no_duplicate_keys"}
    result["capability_skips"] = ["real_model_request", "graphical_shell"]
    result["host_lock_policy"] = "dsh-core/v1"
    result["host_driver_sha256"] = desktop_driver_digest(root)
    if result["status"] != "passed":
        return result
    temporary = host.host_temporary_root()
    process = None
    stage = "desktop_prepare"
    passed = lambda name: result["gates"].append(api.gate(name, digest, passed=True))
    try:
        assert_slot_available()
        environment = host.isolated_environment(temporary)
        node_env = {**environment, "ELECTRON_RUN_AS_NODE": "1"}
        work = temporary / "work"
        work.mkdir()
        host.write_test_fixture(work)
        command = lambda *args: host.run_host_command(work, node_env, *args)
        result["platform"]["toolchain"]["dsh"] = version
        result["platform"]["toolchain"]["desktop_node"] = command(str(carrier(archive)), "--version").strip()
        helper = root / "scripts" / "native_desktop_tools.mjs"
        profile = temporary / "dsh" / "profiles" / "desktop"
        command(*electron_command(archive, helper, "init", str(archive), str(profile)))
        lock_args = ["--profile", "desktop", "--runtime-root", str(archive), "--profile-root", str(profile)]
        graph = json.loads(command("node", str(root / "bin" / "dsh-completion-guard-host-lock.mjs"),
                                   "inspect-graph", *lock_args))
        if graph["host_version"]["version"] != version or graph["status"] != "supported":
            raise RuntimeError("Desktop preinstall graph mismatch")
        passed("desktop_carrier_and_graph")
        cli = archive / "dsh" / "node_modules" / "@deepseek-ai" / "dsh-desktop-host" / "lib" / "cli.js"
        fixture_old = host.package_fixture(temporary, "1.0.0")
        fixture_new = host.package_fixture(temporary, "1.0.1")
        install = electron_command(archive, cli, "plugin", "--profile", "desktop", "add",
                                   "--ignore-scripts", "--config.auto-install-peers=false", str(artifact))
        stage = "desktop_install"
        command(*install)
        installed = profile / "node_modules" / "dsh-completion-guard"
        extracted = temporary / "extracted"
        extracted.mkdir()
        command("tar", "-xf", str(artifact), "-C", str(extracted))
        tree = api.tree_digest(extracted / "package")
        if api.tree_digest(installed) != tree:
            raise RuntimeError("Desktop installed package differs from the frozen tgz")
        passed("desktop_package_parity")
        tracked = [profile / name for name in ("package.json", "pnpm-lock.yaml", "cordis.patch.yml", "node_modules/.package-map.json", "node_modules/.modules.yaml")]
        before = {path.name: api.sha256(path) for path in tracked if path.is_file()}
        before_bytes = noop_snapshot(tracked, profile)
        stage = "single_package_strict_noop"
        command(*install)
        after = {path.name: api.sha256(path) for path in tracked if path.is_file()}
        after_tree = api.tree_digest(installed)
        check_strict_noop(before, after, before_bytes, tracked, profile, tree, after_tree, diagnostics_output)
        passed("single_package_strict_noop")
        # Add the inert update fixture only after Guard's unchanged strict gate.
        multi_install = [*install, str(fixture_old)]
        stage = "desktop_fixture_install"
        command(*multi_install)
        if api.tree_digest(installed) != tree:
            raise RuntimeError("Adding the fixture changed the frozen Guard package")
        before = {path.name: api.sha256(path) for path in tracked if path.is_file()}
        before_bytes = noop_snapshot(tracked, profile)
        stage = "multi_package_semantic_noop"
        command(*multi_install)
        after = {path.name: api.sha256(path) for path in tracked if path.is_file()}
        check_multi_package_semantic_noop(before, after, before_bytes, tracked, profile,
                                         tree, api.tree_digest(installed), diagnostics_output)
        passed("multi_package_semantic_noop")
        locker = installed / "bin" / "dsh-completion-guard-host-lock.mjs"
        stage = "desktop_installed_inspect"
        inspected = json.loads(command("node", str(locker), "inspect", *lock_args))
        if inspected["status"] != "supported" or inspected.get("inspection_scope") != "active_profile":
            raise RuntimeError("Desktop installed inspection did not audit the active importer")
        passed("desktop_installed_inspect")
        stage = "desktop_host_lock"
        readback = json.loads(command("node", str(locker), "inject", *lock_args))
        if readback["status"] != "supported" or readback["host_lock_digest"] != inspected["host_lock_digest"]:
            raise RuntimeError("Desktop injected lock unavailable")
        result["host_lock_digests"] = {"desktop": readback["host_lock_digest"]}
        result["desktop_runtime"] = {key: value for key, value in graph["desktop_runtime"].items() if key != "asar_realpath"}
        passed("desktop_host_lock")
        composed = temporary / "desktop-composed.yml"
        composed.write_text(command("node", str(locker), "dump-desktop", *lock_args), encoding="utf-8")
        command("node", str(locker), "verify-dump", *lock_args, "--dump-config", str(composed))
        passed("desktop_host_lock_readback")
        output = temporary / "desktop"
        nonce = secrets.token_hex(12)
        config = {"runtimeRoot": str(archive / "dsh"), "workRoot": str(work), "nonce": nonce,
                  "output": str(output) + ".probe", "profile": "desktop", "profileRoot": str(profile),
                  "hostPackages": graph["packages"], "fixtureTgz": str(fixture_new),
                  "sourceCommit": result["repository"]["commit"], "artifactSha256": digest}
        # Guard roots use the physical archive, whereas runtimeRequire uses
        # the actual ASAR-contained dsh namespace. Bind both explicitly.
        config["desktopArchive"] = str(archive)
        probe_patch = temporary / "probe-patch.json"
        probe_patch.write_text(json.dumps(host.native_probe_patch(root / "scripts" / "native_host_probe_v070.mjs", config)))
        command(*electron_command(archive, helper, "probe", str(archive), str(profile), str(probe_patch)))
        stage = "desktop_probe_composition"
        composed.write_text(command("node", str(locker), "dump-desktop", *lock_args), encoding="utf-8")
        command("node", str(locker), "verify-dump", *lock_args, "--dump-config", str(composed))
        passed("desktop_probe_composition")
        stage = "desktop_host_start_and_probe"
        process = subprocess.Popen(["node", str(helper), "host", str(archive), str(profile), str(output)],
                                   cwd=work, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   start_new_session=platform.system() != "Windows")
        process.wait(timeout=520)
        receipt_paths = list(temporary.glob("desktop.probe.*.json"))
        if process.returncode or len(receipt_paths) != 1:
            raise RuntimeError("Desktop owned backend did not complete its probe")
        probe = json.loads(receipt_paths[0].read_text())
        if not host.validate_probe(probe, nonce, host.probe_driver_digest(root, "v070"), protocol="v070"):
            raise host.HostProbeFailure(probe)
        driver = json.loads(Path(str(output) + ".driver.json").read_text())
        if not driver["ready"] or not driver["shutdown_acknowledged"] or driver["exit_code"] != 0:
            raise RuntimeError("Desktop backend did not stop gracefully")
        passed("desktop_loaded_backend")
        for row in probe["cases"]:
            passed("desktop_" + row["id"])
        passed("desktop_graceful_stop")
        assert_slot_available()
        stage = "desktop_uninstall"
        command(*electron_command(archive, cli, "plugin", "--profile", "desktop", "remove", "dsh-completion-guard", "guard-acceptance-fixture"))
        manifest = json.loads((profile / "package.json").read_text())
        if installed.exists() or "dsh-completion-guard" in manifest.get("dependencies", {}):
            raise RuntimeError("Desktop uninstall retained the plugin")
        passed("desktop_uninstall")
    except (OSError, ValueError, KeyError, StopIteration, RuntimeError, subprocess.SubprocessError) as error:
        result["gates"].append(api.gate("desktop_acceptance", digest, passed=False,
                                      note=host.failure_note(stage, error)))
        host.write_host_diagnostic(diagnostics_output, stage, error, digest, result["repository"]["commit"],
                                   progress={"strict_second_noop": error.receipt} if isinstance(error, StrictNoopFailure) else None)
    finally:
        if process is not None and process.poll() is None:
            if platform.system() == "Windows":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, timeout=15, check=False)
            else:
                os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                if platform.system() != "Windows":
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
                process.wait(timeout=10)
        try:
            assert_slot_available()
        except OSError:
            result["cleanup"] = {"status": "failed", "remaining_ids": ["desktop_listener"]}
        shutil.rmtree(temporary, ignore_errors=True)
        if temporary.exists():
            result["cleanup"] = {"status": "failed", "remaining_ids": ["desktop_temporary_root"]}
        elif result["cleanup"]["status"] == "passed":
            passed("desktop_cleanup")
    complete = len(result["gates"]) == len(DESKTOP_GATES) and {row["id"] for row in result["gates"]} == DESKTOP_GATES
    result["status"] = "passed" if complete and all(row["status"] == "passed" for row in result["gates"]) and result["cleanup"]["status"] == "passed" else "failed"
    result["run"]["finished_at"] = api.timestamp()
    return result
