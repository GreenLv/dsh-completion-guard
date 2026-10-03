#!/usr/bin/env python3
"""Real-market Desktop coexistence acceptance against the exact frozen tgz.

Complements, never replaces, the ``dsh-desktop-bound/v2`` gate: the layered
no-op contract stays in ``native_desktop_acceptance.py``. This entrypoint
installs the real ``dshmarket`` cohort through the official plugin CLI into an
owned isolated Desktop profile and verifies pre-install graph, Guard-only
lock, lock drift on install/remove, coexistence rebind, and a loaded backend
probe in the final coexistence state. The graphical shell (including the
market GUI) and real-model requests remain separate required gates.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import secrets
import shutil
import signal
import subprocess
import tarfile
import urllib.error
import urllib.request
from collections.abc import Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import importlib.util


def _load(name: str, path: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(path))
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


host = _load("native_market_host_helpers", "native_host_acceptance.py")
desktop = _load("native_market_desktop_helpers", "native_desktop_acceptance.py")
NATIVE = _load("native_market_portable_helpers", "native_acceptance.py")

HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
SEMVER = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")
MARKET_PACKAGE = "dshmarket"
REGISTRY_URL = "https://registry.npmjs.org"

PROBE_CASE_GATES = tuple("desktop_market_" + case for case in host.PROBE_V070_CASES)
BASE_GATES = {
    "package_inventory", "manifest_identity", "package_parity", "isolated_install",
    "strict_second_noop", "installed_syntax",
}
MARKET_GATES = BASE_GATES | {
    "desktop_market_preinstall_graph", "desktop_market_registry_identity",
    "desktop_market_guard_install", "desktop_market_guard_lock",
    "desktop_market_install", "desktop_market_lock_drift",
    "desktop_market_coexistence_lock", "desktop_market_remove_restore",
    "desktop_market_final_coexistence", "desktop_market_probe_composition",
    "desktop_market_loaded_backend", "desktop_market_graceful_stop",
    "desktop_market_uninstall", "desktop_market_cleanup",
    *PROBE_CASE_GATES,
}
LOCK_SLOTS = ("desktop_pre_market", "desktop_coexistence", "desktop_final")
CAPABILITY_SKIPS = ["real_model_request", "graphical_shell", "market_gui"]


def market_driver_digest(root: Path) -> str:
    import hashlib
    files = [root / "scripts" / name for name in (
        "native_acceptance.py", "native_host_acceptance.py",
        "native_desktop_acceptance.py", "native_desktop_market_acceptance.py",
        "native_desktop_tools.mjs", *host.PROBE_V070_DRIVER_FILES)]
    return hashlib.sha256(b"".join(path.name.encode() + b"\0" + path.read_bytes() + b"\0"
                                   for path in files)).hexdigest()


def registry_market_identity(version: str, timeout: int = 30) -> dict[str, str]:
    """Acquire the exact published market identity without installing it.

    The integrity recorded here is the acquired registry fact the install gate
    compares the installed manifest against; it never attests loaded bytes.
    """
    request = urllib.request.Request(
        f"{REGISTRY_URL}/{MARKET_PACKAGE}/{version}",
        headers={"User-Agent": "dsh-completion-guard-native-acceptance"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f"registry returned HTTP {response.status} for {MARKET_PACKAGE}@{version}")
        metadata = json.load(response)
    integrity = (metadata.get("dist") or {}).get("integrity")
    if metadata.get("name") != MARKET_PACKAGE or metadata.get("version") != version or not isinstance(integrity, str):
        raise RuntimeError(f"registry identity for {MARKET_PACKAGE}@{version} is incomplete")
    return {"name": MARKET_PACKAGE, "version": version, "registry_integrity": integrity}


def plugin_command(archive: Path, *args: str) -> list[str]:
    cli = archive / "dsh" / "node_modules" / "@deepseek-ai" / "dsh-desktop-host" / "lib" / "cli.js"
    return desktop.electron_command(archive, cli, *args)


def market_acceptance(api: Any, root: Path, artifact: Path, digest: str,
                      archive: Path, result: dict[str, Any], version: str,
                      market_version: str, diagnostics_output: Path) -> dict[str, Any]:
    result["gate_profile"] = "desktop-market-coexistence/v1"
    result["market_coexistence_contract"] = {
        "schema": "dsh-desktop-market-coexistence/v1",
        "market_install_entry": "official_plugin_cli_registry_spec",
        "lock_drift": "old_dump_verify_fails_after_market_change",
        "final_state": "market_installed_with_rebound_lock",
    }
    result["capability_skips"] = list(CAPABILITY_SKIPS)
    result["host_lock_policy"] = "dsh-core/v1"
    result["host_driver_sha256"] = market_driver_digest(root)
    result["market"] = {"package": MARKET_PACKAGE, "version": market_version}
    if result["status"] != "passed":
        return result
    temporary = host.host_temporary_root()
    process = None
    stage = "desktop_market_prepare"
    passed = lambda name: result["gates"].append(api.gate(name, digest, passed=True))
    digests: dict[str, str] = {}
    try:
        desktop.assert_slot_available()
        environment = host.isolated_environment(temporary)
        node_env = {**environment, "ELECTRON_RUN_AS_NODE": "1"}
        work = temporary / "work"
        work.mkdir()
        host.write_test_fixture(work)
        fixture_new = host.package_fixture(temporary, "1.0.1")
        command = lambda *args: host.run_host_command(work, node_env, *args)
        result["platform"]["toolchain"]["dsh"] = version
        result["platform"]["toolchain"]["desktop_node"] = command(desktop.carrier(archive), "--version").strip()
        helper = root / "scripts" / "native_desktop_tools.mjs"
        profile = temporary / "dsh" / "profiles" / "desktop"
        command(*desktop.electron_command(archive, helper, "init", str(archive), str(profile)))
        lock_args = ["--profile", "desktop", "--runtime-root", str(archive), "--profile-root", str(profile)]
        graph = json.loads(command("node", str(root / "bin" / "dsh-completion-guard-host-lock.mjs"),
                                   "inspect-graph", *lock_args))
        if graph["host_version"]["version"] != version or graph["status"] != "supported":
            raise RuntimeError("Desktop preinstall graph mismatch")
        passed("desktop_market_preinstall_graph")
        stage = "desktop_market_registry_identity"
        result["market"].update(registry_market_identity(market_version))
        passed("desktop_market_registry_identity")
        # Guard alone first: exact-artifact parity, then a full lock on the
        # market-free profile (the coexistence positive control).
        stage = "desktop_market_guard_install"
        command(*plugin_command(archive, "plugin", "--profile", "desktop", "add",
                                "--ignore-scripts", "--config.auto-install-peers=false", str(artifact)))
        installed = profile / "node_modules" / "dsh-completion-guard"
        extracted = temporary / "extracted"
        extracted.mkdir()
        command("tar", "-xf", str(artifact), "-C", str(extracted))
        guard_tree = api.tree_digest(extracted / "package")
        if api.tree_digest(installed) != guard_tree:
            raise RuntimeError("installed Guard package differs from the frozen tgz")
        passed("desktop_market_guard_install")
        locker = installed / "bin" / "dsh-completion-guard-host-lock.mjs"
        stage = "desktop_market_guard_lock"
        inspected = json.loads(command("node", str(locker), "inspect", *lock_args))
        if inspected["status"] != "supported" or inspected.get("inspection_scope") != "active_profile":
            raise RuntimeError("Guard-only Desktop inspection did not audit the active importer")
        readback = json.loads(command("node", str(locker), "inject", *lock_args))
        if readback["status"] != "supported" or readback["host_lock_digest"] != inspected["host_lock_digest"]:
            raise RuntimeError("Guard-only Desktop lock unavailable")
        digests["desktop_pre_market"] = readback["host_lock_digest"]
        composed_pre = temporary / "desktop-pre-market.yml"
        composed_pre.write_text(command("node", str(locker), "dump-desktop", *lock_args), encoding="utf-8")
        command("node", str(locker), "verify-dump", *lock_args, "--dump-config", str(composed_pre))
        passed("desktop_market_guard_lock")
        # The real market cohort through the official management entry.
        stage = "desktop_market_install"
        command(*plugin_command(archive, "plugin", "--profile", "desktop", "add",
                                "--ignore-scripts", "--config.auto-install-peers=false",
                                f"{MARKET_PACKAGE}@{market_version}"))
        manifest = json.loads((profile / "package.json").read_text())
        market_manifest = json.loads((profile / "node_modules" / MARKET_PACKAGE / "package.json").read_text())
        if manifest.get("dependencies", {}).get(MARKET_PACKAGE) != market_version \
                or MARKET_PACKAGE not in ((manifest.get("dsh") or {}).get("profile") or {}).get("bundles", []) \
                or market_manifest.get("name") != MARKET_PACKAGE or market_manifest.get("version") != market_version:
            raise RuntimeError("market install did not bind the declared cohort into the profile")
        if api.tree_digest(installed) != guard_tree:
            raise RuntimeError("installing the market modified the frozen Guard package")
        passed("desktop_market_install")
        # The pre-market lock must not survive the importer change silently.
        stage = "desktop_market_lock_drift"
        drifted = subprocess.run(["node", str(locker), "verify-dump", *lock_args,
                                  "--dump-config", str(composed_pre)],
                                 cwd=work, env=node_env, text=True, capture_output=True, check=False)
        if drifted.returncode == 0:
            raise RuntimeError("the pre-market composed dump still verified after the market install")
        passed("desktop_market_lock_drift")
        stage = "desktop_market_coexistence_lock"
        coexistence = json.loads(command("node", str(locker), "inspect", *lock_args))
        if coexistence["status"] != "supported" or coexistence.get("profile") != "desktop":
            raise RuntimeError("coexistence profile was not resolved as Desktop")
        rebound = json.loads(command("node", str(locker), "inject", *lock_args))
        if rebound["status"] != "supported" or rebound["host_lock_digest"] == digests["desktop_pre_market"]:
            raise RuntimeError("coexistence rebind did not produce a fresh lock identity")
        digests["desktop_coexistence"] = rebound["host_lock_digest"]
        composed_coexistence = temporary / "desktop-coexistence.yml"
        composed_coexistence.write_text(command("node", str(locker), "dump-desktop", *lock_args), encoding="utf-8")
        command("node", str(locker), "verify-dump", *lock_args, "--dump-config", str(composed_coexistence))
        passed("desktop_market_coexistence_lock")
        # Removing the market through the same entry restores the Guard-only
        # identity; the market-era lock must refuse in between.
        stage = "desktop_market_remove_restore"
        command(*plugin_command(archive, "plugin", "--profile", "desktop", "remove", MARKET_PACKAGE))
        manifest = json.loads((profile / "package.json").read_text())
        if MARKET_PACKAGE in manifest.get("dependencies", {}) \
                or (profile / "node_modules" / MARKET_PACKAGE).exists() \
                or api.tree_digest(installed) != guard_tree:
            raise RuntimeError("market removal did not restore the Guard-only profile")
        removed_rebind = json.loads(command("node", str(locker), "inject", *lock_args))
        if removed_rebind["status"] != "supported" or removed_rebind["host_lock_digest"] != digests["desktop_pre_market"]:
            raise RuntimeError("market removal did not restore the pre-market lock identity")
        passed("desktop_market_remove_restore")
        # Acceptance target is coexistence: restore the market through the
        # official entry and rebuild the machine-local lock for the final state.
        stage = "desktop_market_final_coexistence"
        command(*plugin_command(archive, "plugin", "--profile", "desktop", "add",
                                "--ignore-scripts", "--config.auto-install-peers=false",
                                f"{MARKET_PACKAGE}@{market_version}"))
        final = json.loads(command("node", str(locker), "inject", *lock_args))
        if final["status"] != "supported" or final["host_lock_digest"] == digests["desktop_pre_market"] \
                or api.tree_digest(installed) != guard_tree:
            raise RuntimeError("final coexistence rebind failed")
        digests["desktop_final"] = final["host_lock_digest"]
        composed_final = temporary / "desktop-final.yml"
        composed_final.write_text(command("node", str(locker), "dump-desktop", *lock_args), encoding="utf-8")
        command("node", str(locker), "verify-dump", *lock_args, "--dump-config", str(composed_final))
        if MARKET_PACKAGE not in composed_final.read_text():
            raise RuntimeError("the final composed config does not carry the market layer")
        passed("desktop_market_final_coexistence")
        # Loaded-backend probe in the final coexistence state.
        output = temporary / "desktop"
        nonce = secrets.token_hex(12)
        config = {"runtimeRoot": str(archive / "dsh"), "workRoot": str(work), "nonce": nonce,
                  "output": str(output) + ".probe", "profile": "desktop", "profileRoot": str(profile),
                  "hostPackages": graph["packages"], "fixtureTgz": str(fixture_new),
                  "sourceCommit": result["repository"]["commit"], "artifactSha256": digest,
                  "desktopArchive": str(archive)}
        probe_patch = temporary / "probe-patch.json"
        probe_patch.write_text(json.dumps(host.native_probe_patch(root / "scripts" / "native_host_probe_v070.mjs", config)))
        command(*desktop.electron_command(archive, helper, "probe", str(archive), str(profile), str(probe_patch)))
        stage = "desktop_market_probe_composition"
        composed_final.write_text(command("node", str(locker), "dump-desktop", *lock_args), encoding="utf-8")
        command("node", str(locker), "verify-dump", *lock_args, "--dump-config", str(composed_final))
        passed("desktop_market_probe_composition")
        stage = "desktop_market_host_start_and_probe"
        process = subprocess.Popen(["node", str(helper), "host", str(archive), str(profile), str(output)],
                                   cwd=work, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   start_new_session=platform.system() != "Windows")
        process.wait(timeout=520)
        receipt_paths = list(temporary.glob("desktop.probe.*.json"))
        if process.returncode or len(receipt_paths) != 1:
            raise RuntimeError("coexistence Desktop backend did not complete its probe")
        probe = json.loads(receipt_paths[0].read_text())
        if not host.validate_probe(probe, nonce, host.probe_driver_digest(root, "v070"), protocol="v070"):
            raise host.HostProbeFailure(probe)
        driver = json.loads(Path(str(output) + ".driver.json").read_text())
        if not driver["ready"] or not driver["shutdown_acknowledged"] or driver["exit_code"] != 0:
            raise RuntimeError("coexistence backend did not stop gracefully")
        passed("desktop_market_loaded_backend")
        for row in probe["cases"]:
            passed("desktop_market_" + row["id"])
        passed("desktop_market_graceful_stop")
        desktop.assert_slot_available()
        stage = "desktop_market_uninstall"
        command(*plugin_command(archive, "plugin", "--profile", "desktop", "remove",
                                "dsh-completion-guard", MARKET_PACKAGE))
        manifest = json.loads((profile / "package.json").read_text())
        if installed.exists() or (profile / "node_modules" / MARKET_PACKAGE).exists() \
                or "dsh-completion-guard" in manifest.get("dependencies", {}) \
                or MARKET_PACKAGE in manifest.get("dependencies", {}):
            raise RuntimeError("Desktop uninstall retained Guard or the market")
        passed("desktop_market_uninstall")
    except (OSError, ValueError, KeyError, StopIteration, RuntimeError, subprocess.SubprocessError,
            urllib.error.URLError) as error:
        result["gates"].append(api.gate("desktop_market_acceptance", digest, passed=False,
                                      note=host.failure_note(stage, error)))
        host.write_host_diagnostic(diagnostics_output, stage, error, digest, result["repository"]["commit"],
                                   progress={"host_lock_digests": digests} if digests else None)
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
            desktop.assert_slot_available()
        except OSError:
            result["cleanup"] = {"status": "failed", "remaining_ids": ["desktop_market_listener"]}
        shutil.rmtree(temporary, ignore_errors=True)
        if temporary.exists():
            result["cleanup"] = {"status": "failed", "remaining_ids": ["desktop_market_temporary_root"]}
        elif result["cleanup"]["status"] == "passed":
            passed("desktop_market_cleanup")
    complete = len(result["gates"]) == len(MARKET_GATES) and {row["id"] for row in result["gates"]} == MARKET_GATES
    result["status"] = "passed" if complete and all(row["status"] == "passed" for row in result["gates"]) and result["cleanup"]["status"] == "passed" else "failed"
    result["run"]["finished_at"] = NATIVE.timestamp()
    return result


def preflight_source_and_artifact(root: Path, artifact: Path, artifact_sha256: str,
                                  source_commit: str) -> None:
    """The same exact source/artifact identity checks the portable entry runs,
    without installing anything."""
    NATIVE.verify_exact_source(root, source_commit)
    NATIVE.normalize_repository_url(NATIVE.run(root, "git", "remote", "get-url", "origin").stdout)
    if NATIVE.sha256(artifact) != artifact_sha256:
        raise NATIVE.NativeRunError("artifact SHA-256 does not match the expected digest")
    with tarfile.open(artifact, "r:gz") as archive:
        NATIVE.safe_tar_entries("\n".join(member.name for member in archive.getmembers()))
        member = archive.getmember("package/package.json")
        if not member.isfile() or member.size > 1024 * 1024:
            raise NATIVE.NativeRunError("artifact package manifest must be a bounded regular file")
        with archive.extractfile(member) as stream:
            manifest = json.load(stream)
        if manifest.get("name") != "dsh-completion-guard" or manifest.get("gitHead") != source_commit:
            raise NATIVE.NativeRunError("package manifest name or gitHead does not match the candidate")
    for command in ("node", "npm", "tar"):
        NATIVE.resolve_executable(command)


def preflight_market_inputs(root: Path, archive: Path, version: str, market_version: str) -> None:
    """No packages installed, no host booted, no model; same-invocation checks."""
    desktop.preflight_desktop_inputs(root, archive, version)
    result_market = registry_market_identity(market_version)
    if result_market["version"] != market_version:
        raise RuntimeError("registry cohort mismatch")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--artifact-sha256", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--preflight", action="store_true",
                        help="check local inputs and output paths without installing packages or starting hosts")
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--runtime-root", type=Path, required=True,
                        help="physical official app.asar of the signed Desktop carrier")
    parser.add_argument("--desktop-cohort", required=True, help="exact Desktop DSH version")
    parser.add_argument("--market-cohort", required=True, help="exact dshmarket version installed through the official entry")
    parser.add_argument("--transfer-receipt", type=Path)
    parser.add_argument("--transport-url")
    parser.add_argument("--run-url")
    args = parser.parse_args(argv)
    args.output = args.output.absolute()
    if args.transfer_receipt is not None:
        args.transfer_receipt = args.transfer_receipt.absolute()
    if not HEX64.fullmatch(args.artifact_sha256) or not HEX40.fullmatch(args.source_commit):
        parser.error("artifact SHA-256 and source commit must be full lowercase digests")
    if not SEMVER.fullmatch(args.market_cohort):
        parser.error("--market-cohort must be an exact semver version")
    try:
        if args.transfer_receipt:
            url = urlsplit(args.transport_url or "")
            if url.scheme != "https" or not url.hostname or url.username or url.password:
                raise NATIVE.NativeRunError("a transfer receipt requires a credential-free HTTPS transport URL")
            if args.output.resolve() == args.transfer_receipt.resolve():
                raise NATIVE.NativeRunError("acceptance and transfer receipt need different output paths")
            NATIVE.check_output_path(args.transfer_receipt, args.repo_root)
        diagnostics_output = args.output.with_name(args.output.name + ".diagnostics.json")
        if args.transfer_receipt and diagnostics_output.resolve() == args.transfer_receipt.resolve():
            raise NATIVE.NativeRunError("diagnostics and transfer receipt need different output paths")
        NATIVE.check_output_path(diagnostics_output, args.repo_root)
        NATIVE.check_output_path(args.output, args.repo_root)
        # Full source/artifact identity check plus the Desktop carrier and
        # registry cohort checks; no package is installed and no host starts.
        preflight_source_and_artifact(args.repo_root.resolve(), args.artifact.resolve(),
                                      args.artifact_sha256, args.source_commit)
        preflight_market_inputs(args.repo_root.resolve(), args.runtime_root.resolve(),
                                args.desktop_cohort, args.market_cohort)
    except (OSError, ValueError, KeyError, AttributeError, tarfile.TarError, RuntimeError,
            urllib.error.URLError) as exc:
        parser.error(str(exc))
    if args.preflight:
        print("native_preflight=passed; input_checks_only; acceptance_not_run")
        return 0
    from types import SimpleNamespace
    api = SimpleNamespace(gate=NATIVE.gate, sha256=NATIVE.sha256, tree_digest=NATIVE.tree_digest,
                          timestamp=NATIVE.timestamp)
    result = NATIVE.portable_acceptance(args.repo_root.resolve(), args.artifact.resolve(),
                                        args.artifact_sha256, args.source_commit, args.run_url)
    result = market_acceptance(api, args.repo_root.resolve(), args.artifact.resolve(),
                               args.artifact_sha256, args.runtime_root.resolve(), result,
                               args.desktop_cohort, args.market_cohort, diagnostics_output)
    NATIVE.write_result(args.output, result)
    if args.transfer_receipt:
        if not args.transport_url or result["artifact"]["sha256"] != args.artifact_sha256:
            parser.error("a transfer receipt requires an HTTPS transport URL and matching bytes")
        NATIVE.write_result(args.transfer_receipt, NATIVE.transfer_receipt(result, args.transport_url))
    print(f"native_acceptance={result['status']}")
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
