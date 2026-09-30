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
    "desktop_package_parity", "desktop_strict_second_noop", "desktop_host_lock",
    "desktop_host_lock_readback", "desktop_probe_composition", "desktop_loaded_backend",
    "desktop_graceful_stop", "desktop_uninstall", "desktop_cleanup",
    *("desktop_" + case for case in host.PROBE_V070_CASES),
}


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
    result["gate_profile"] = "dsh-desktop-bound/v1"
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
                                   "--ignore-scripts", "--config.auto-install-peers=false", str(artifact), str(fixture_old))
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
        tracked = [profile / name for name in ("package.json", "pnpm-lock.yaml", "cordis.patch.yml", "node_modules/.package-map.json")]
        before = {path.name: api.sha256(path) for path in tracked if path.is_file()}
        stage = "desktop_second_install"
        command(*install)
        after = {path.name: api.sha256(path) for path in tracked if path.is_file()}
        if before != after or api.tree_digest(installed) != tree:
            raise RuntimeError("Desktop second install was not a strict no-op")
        passed("desktop_strict_second_noop")
        locker = installed / "bin" / "dsh-completion-guard-host-lock.mjs"
        stage = "desktop_host_lock"
        readback = json.loads(command("node", str(locker), "inject", *lock_args))
        if readback["status"] != "supported":
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
        host.write_host_diagnostic(diagnostics_output, stage, error, digest, result["repository"]["commit"])
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
