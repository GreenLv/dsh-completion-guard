#!/usr/bin/env python3
"""Real-market Desktop coexistence acceptance against the exact frozen tgz.

Complements, never replaces, the ``dsh-desktop-bound/v2`` gate: the layered
no-op contract stays in ``native_desktop_acceptance.py``. This entrypoint
installs the real ``dshmarket`` cohort through the official plugin CLI into an
owned isolated Desktop profile and verifies the lock lifecycle by graph and
bytes — fresh ``inspect``/``inject`` per state, a newly generated composed dump
verified per state, and precise bounded drift refusals for the superseded
locks on both market install and removal. In the final coexistence state it
probes the loaded backend and observes the market's real instance and versioned
API on that same backend. The graphical shell (including the market GUI) and
real-model requests remain separate required gates.
"""
from __future__ import annotations

import argparse
import hashlib
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
MARKET_API_SCHEMA = "dsh-market/update-api/v1"
DRIFT_REASON_CODE = "host_lock_readback_mismatch"
DRIFT_TIMEOUT_SECONDS = 60

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
    "desktop_market_loaded_backend", "desktop_market_api",
    "desktop_market_graceful_stop",
    "desktop_market_uninstall", "desktop_market_cleanup",
    *PROBE_CASE_GATES,
}
# Lock identity slots. Each is the fresh digest of ONE profile state; a state
# is defined by its bound graph and bytes, not by its position in a lifecycle.
# Distinctness is only required where the bound bytes necessarily changed
# (installing the market rewrites the profile manifest), never as a per-step
# counter: removing the market and reinstalling it may legitimately restore an
# earlier identity, and a metadata serialization change after removal may
# legitimately produce a new one.
LOCK_SLOTS = ("desktop_pre_market", "desktop_coexistence", "desktop_removed_rebind", "desktop_final")
CAPABILITY_SKIPS = ["real_model_request", "graphical_shell", "market_gui"]
CONTRACT = {"schema": "dsh-desktop-market-coexistence/v1",
            "market_install_entry": "official_plugin_cli_registry_spec",
            "lock_drift": "superseded_dump_verify_fails_with_readback_mismatch",
            "final_state": "market_installed_with_rebound_lock"}


def market_driver_digest(root: Path) -> str:
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
    return {"version": version, "registry_integrity": integrity}


def plugin_command(archive: Path, *args: str) -> list[str]:
    cli = archive / "dsh" / "node_modules" / "@deepseek-ai" / "dsh-desktop-host" / "lib" / "cli.js"
    return desktop.electron_command(archive, cli, *args)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def profile_manifest_digest(profile: Path) -> str:
    return sha256_bytes((profile / "package.json").read_bytes())


def expect_drift_refusal(run_drift, dump_path: Path, superseded_by: str) -> dict[str, Any]:
    """The composed dump of a superseded lock must fail the production CLI with
    exactly the readback-mismatch refusal. Any other exit — an unexpected
    nonzero (missing module, permission error), a zero exit (still verifying),
    non-JSON output, or a timeout — fails the run instead of counting as
    drift."""
    try:
        completed = run_drift(dump_path)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"superseded-dump verify-dump timed out after {DRIFT_TIMEOUT_SECONDS}s "
                           f"(lock superseded by {superseded_by})") from error
    if completed.returncode == 0:
        raise RuntimeError(f"the dump superseded by {superseded_by} still verified; the old lock did not drift")
    stderr = (completed.stderr or "").strip()
    payload: dict[str, Any] | None = None
    if stderr:
        try:
            candidate = json.loads(stderr.splitlines()[-1])
            if isinstance(candidate, dict):
                payload = candidate
        except (ValueError, TypeError):
            payload = None
    if payload is None:
        raise RuntimeError(f"superseded-dump verify-dump failed without the CLI JSON readback "
                           f"(lock superseded by {superseded_by}): {stderr[-300:] or 'no stderr'}")
    if payload.get("reason_code") != DRIFT_REASON_CODE:
        raise RuntimeError(f"superseded-dump verify-dump failed with unexpected reason_code "
                           f"{payload.get('reason_code')!r} instead of {DRIFT_REASON_CODE!r} "
                           f"(lock superseded by {superseded_by})")
    return payload


def receipt_contract_closure(result: dict[str, Any]) -> list[str]:
    """Producer-side closure: the checks the schema and consumer will apply to
    a passed receipt, evaluated on this run's own result before the producer
    may declare success."""
    problems: list[str] = []
    locks = result.get("host_lock_digests")
    if not isinstance(locks, dict) or set(locks) != set(LOCK_SLOTS) \
            or any(not isinstance(row, str) or not HEX64.fullmatch(row) for row in locks.values()):
        problems.append("host_lock_digests incomplete or malformed")
    elif locks["desktop_pre_market"] == locks["desktop_coexistence"]:
        problems.append("coexistence digest equals the pre-market digest")
    runtime = result.get("desktop_runtime")
    required_runtime = {"manifest_sha256", "header_sha256", "metadata_sha256", "host_version",
                        "desktop_version", "payload_file_count"}
    if not isinstance(runtime, dict) or set(runtime) != required_runtime \
            or any(not isinstance(runtime.get(key), str) or not HEX64.fullmatch(runtime[key])
                   for key in ("manifest_sha256", "header_sha256", "metadata_sha256")):
        problems.append("desktop_runtime incomplete or malformed")
    market = result.get("market")
    if not isinstance(market, dict) or set(market) != {"package", "version", "registry_integrity"} \
            or market.get("package") != MARKET_PACKAGE \
            or not re.fullmatch(r"sha512-[A-Za-z0-9+/]{86}==", market.get("registry_integrity") or ""):
        problems.append("market identity projection invalid")
    observation = result.get("market_observation")
    if not isinstance(observation, dict) or observation.get("schema") != "dsh-desktop-market-observation/v1" \
            or observation.get("status") != "observed" or observation.get("api_schema") != MARKET_API_SCHEMA \
            or observation.get("api_version") != 1 or observation.get("market_version") != market.get("version") \
            or not isinstance(observation.get("boot_id"), str) or not observation["boot_id"] \
            or type(observation.get("port")) is not int or not 0 < observation["port"] < 65536:
        problems.append("market observation invalid")
    gate_ids = {row.get("id") for row in result.get("gates", [])}
    if gate_ids != MARKET_GATES or len(result.get("gates", [])) != len(MARKET_GATES):
        problems.append("gate inventory incomplete")
    if result.get("market_coexistence_contract") != CONTRACT:
        problems.append("coexistence contract mismatch")
    if result.get("capability_skips") != CAPABILITY_SKIPS:
        problems.append("capability skips mismatch")
    return problems


def market_acceptance(api: Any, root: Path, artifact: Path, digest: str,
                      archive: Path, result: dict[str, Any], version: str,
                      market_version: str, diagnostics_output: Path) -> dict[str, Any]:
    result["gate_profile"] = "desktop-market-coexistence/v1"
    result["market_coexistence_contract"] = dict(CONTRACT)
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

        def run_bounded(*args: str) -> subprocess.CompletedProcess:
            return subprocess.run(["node", *args], cwd=work, env=node_env, text=True,
                                  capture_output=True, timeout=DRIFT_TIMEOUT_SECONDS, check=False)

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
        # F1: the same run's Desktop runtime identity is bound into the receipt.
        result["desktop_runtime"] = {key: value for key, value in graph["desktop_runtime"].items()
                                     if key != "asar_realpath"}
        passed("desktop_market_preinstall_graph")
        stage = "desktop_market_registry_identity"
        result["market"].update(registry_market_identity(market_version))
        passed("desktop_market_registry_identity")
        # Guard alone first: exact-artifact parity, then a complete healthy
        # lock on the market-free profile. This is also the health proof the
        # later drift refusals rely on: the same verify-dump command succeeds
        # here against a freshly generated dump.
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
        manifest_pre_market = profile_manifest_digest(profile)
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
        # Installing the market rewrote the profile manifest (bound bytes), so
        # the pre-market lock MUST drift: verify the OLD pre-market dump fails
        # with the production CLI's readback mismatch, and nothing else.
        stage = "desktop_market_lock_drift"
        if profile_manifest_digest(profile) == manifest_pre_market:
            raise RuntimeError("market install did not change the bound profile manifest")
        expect_drift_refusal(lambda dump: run_bounded(str(locker), "verify-dump", *lock_args,
                                                      "--dump-config", str(dump)),
                             composed_pre, "the market install")
        passed("desktop_market_lock_drift")
        stage = "desktop_market_coexistence_lock"
        coexistence = json.loads(command("node", str(locker), "inspect", *lock_args))
        if coexistence["status"] != "supported" or coexistence.get("profile") != "desktop":
            raise RuntimeError("coexistence profile was not resolved as Desktop")
        rebound = json.loads(command("node", str(locker), "inject", *lock_args))
        if rebound["status"] != "supported" or rebound["host_lock_digest"] == digests["desktop_pre_market"]:
            raise RuntimeError("coexistence rebind did not produce the changed-bytes identity")
        digests["desktop_coexistence"] = rebound["host_lock_digest"]
        composed_coexistence = temporary / "desktop-coexistence.yml"
        composed_coexistence.write_text(command("node", str(locker), "dump-desktop", *lock_args), encoding="utf-8")
        command("node", str(locker), "verify-dump", *lock_args, "--dump-config", str(composed_coexistence))
        passed("desktop_market_coexistence_lock")
        # Removing the market again rewrites the manifest, so the coexistence
        # lock must drift the same way; afterwards a FRESH bind of the restored
        # Guard-only graph must be supported. The fresh digest is its own valid
        # identity: it need not equal the historical pre-market digest, because
        # pnpm may legitimately rewrite installer metadata serialization.
        stage = "desktop_market_remove_restore"
        command(*plugin_command(archive, "plugin", "--profile", "desktop", "remove", MARKET_PACKAGE))
        manifest = json.loads((profile / "package.json").read_text())
        if MARKET_PACKAGE in manifest.get("dependencies", {}) \
                or (profile / "node_modules" / MARKET_PACKAGE).exists() \
                or api.tree_digest(installed) != guard_tree:
            raise RuntimeError("market removal did not restore the Guard-only package state")
        expect_drift_refusal(lambda dump: run_bounded(str(locker), "verify-dump", *lock_args,
                                                      "--dump-config", str(dump)),
                             composed_coexistence, "the market removal")
        removed_rebind = json.loads(command("node", str(locker), "inject", *lock_args))
        if removed_rebind["status"] != "supported":
            raise RuntimeError("the restored Guard-only graph did not rebind to a supported lock")
        digests["desktop_removed_rebind"] = removed_rebind["host_lock_digest"]
        composed_removed = temporary / "desktop-removed.yml"
        composed_removed.write_text(command("node", str(locker), "dump-desktop", *lock_args), encoding="utf-8")
        command("node", str(locker), "verify-dump", *lock_args, "--dump-config", str(composed_removed))
        passed("desktop_market_remove_restore")
        # Acceptance target is coexistence: restore the market through the
        # official entry and rebuild the machine-local lock for the final
        # state. The final identity is defined by the final bytes; it may
        # legitimately coincide with the first coexistence identity when every
        # bound byte matches, or differ when installer metadata changed.
        stage = "desktop_market_final_coexistence"
        command(*plugin_command(archive, "plugin", "--profile", "desktop", "add",
                                "--ignore-scripts", "--config.auto-install-peers=false",
                                f"{MARKET_PACKAGE}@{market_version}"))
        final = json.loads(command("node", str(locker), "inject", *lock_args))
        if final["status"] != "supported" or api.tree_digest(installed) != guard_tree:
            raise RuntimeError("final coexistence rebind failed")
        digests["desktop_final"] = final["host_lock_digest"]
        composed_final = temporary / "desktop-final.yml"
        composed_final.write_text(command("node", str(locker), "dump-desktop", *lock_args), encoding="utf-8")
        command("node", str(locker), "verify-dump", *lock_args, "--dump-config", str(composed_final))
        if MARKET_PACKAGE not in composed_final.read_text():
            raise RuntimeError("the final composed config does not carry the market layer")
        passed("desktop_market_final_coexistence")
        # Loaded-backend probe in the final coexistence state; the driver also
        # observes the market's real instance and versioned API on the SAME
        # backend process and writes <output>.market.json.
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
        process = subprocess.Popen(["node", str(helper), "host", str(archive), str(profile), str(output),
                                    nonce, market_version],
                                   cwd=work, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   start_new_session=platform.system() != "Windows")
        process.wait(timeout=520)
        receipt_paths = list(temporary.glob("desktop.probe.*.json"))
        market_receipt_path = temporary / "desktop.market.json"
        if process.returncode or len(receipt_paths) != 1:
            raise RuntimeError("coexistence Desktop backend did not complete its probe")
        driver = json.loads(Path(str(output) + ".driver.json").read_text())
        if not driver["ready"] or not driver["shutdown_acknowledged"] or driver["exit_code"] != 0:
            raise RuntimeError("coexistence backend did not stop gracefully")
        passed("desktop_market_loaded_backend")
        probe = json.loads(receipt_paths[0].read_text())
        if not host.validate_probe(probe, nonce, host.probe_driver_digest(root, "v070"), protocol="v070"):
            raise host.HostProbeFailure(probe)
        for row in probe["cases"]:
            passed("desktop_market_" + row["id"])
        passed("desktop_market_graceful_stop")
        # The market API oracle of the SAME backend: the driver's observation
        # must have seen the versioned capabilities response of this child.
        stage = "desktop_market_api"
        if not market_receipt_path.is_file():
            raise RuntimeError("the backend driver wrote no market observation receipt")
        observation = json.loads(market_receipt_path.read_text())
        if observation.get("status") != "observed":
            raise RuntimeError(f"the market instance or API was not observed on this backend: "
                               f"{observation.get('status')} {str(observation.get('error'))[:200]}")
        if observation.get("nonce") != nonce or observation.get("child_pid") != driver.get("pid"):
            raise RuntimeError("market observation is not bound to this backend run")
        capabilities = observation.get("capabilities") or {}
        if capabilities.get("schema") != MARKET_API_SCHEMA or capabilities.get("apiVersion") != 1 \
                or capabilities.get("marketVersion") != market_version \
                or capabilities.get("profile") != "desktop" or capabilities.get("runtime") != "desktop":
            raise RuntimeError("market capabilities response did not match the declared cohort")
        if str(capabilities.get("bootId", "")).split("-")[0] != str(driver.get("pid")):
            raise RuntimeError("market capabilities boot identity is not this backend process")
        result["market_observation"] = {"schema": "dsh-desktop-market-observation/v1", "status": "observed",
                                        "api_schema": MARKET_API_SCHEMA, "api_version": 1,
                                        "market_version": capabilities.get("marketVersion"),
                                        "boot_id": capabilities.get("bootId"), "port": observation.get("port")}
        passed("desktop_market_api")
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
    healthy = complete and all(row["status"] == "passed" for row in result["gates"]) and result["cleanup"]["status"] == "passed"
    result["host_lock_digests"] = dict(digests)
    if healthy:
        # F1 closure: the producer may only declare success when its own run's
        # receipt already satisfies the schema/consumer contract.
        closure = receipt_contract_closure(result)
        if closure:
            result["gates"].append(api.gate("desktop_market_acceptance", digest, passed=False,
                                          note="receipt contract closure failed: " + "; ".join(closure)))
            healthy = False
    result["status"] = "passed" if healthy else "failed"
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
