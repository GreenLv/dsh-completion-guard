#!/usr/bin/env python3
"""Validate a real-market Desktop coexistence annex against exact local source and tgz.

Read-only consumer for the ``desktop-market-coexistence/v1`` supplement. It
never upgrades a failed run, never substitutes the ``dsh-desktop-bound/v2``
layered no-op gate, and records GUI/model observations as separate facts.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import tarfile
from pathlib import Path
from typing import Any

from native_desktop_market_acceptance import CONTRACT, LOCK_SLOTS, market_driver_digest

HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX40 = re.compile(r"^[0-9a-f]{40}$")
BASE_GATES = {
    "package_inventory", "manifest_identity", "package_parity", "isolated_install",
    "strict_second_noop", "installed_syntax",
}
PROBE_V070_CASES = {
    "v070_root_v6_delivery", "v070_ordinary_file_edit_readback",
    "v070_ordinary_test_and_checkpoint", "v070_future_vs_current_stop",
    "v070_short_resume_and_persistence", "v070_legacy_migration",
    "v070_goal_adoption_current_closure", "v070_explicit_release_minimum",
    "v070_history_compaction_restart",
}
EXPECTED_GATES = BASE_GATES | {
    "desktop_market_preinstall_graph", "desktop_market_registry_identity",
    "desktop_market_guard_install", "desktop_market_guard_lock",
    "desktop_market_install", "desktop_market_lock_drift",
    "desktop_market_coexistence_lock", "desktop_market_remove_restore",
    "desktop_market_final_coexistence", "desktop_market_probe_composition",
    "desktop_market_loaded_backend", "desktop_market_graceful_stop",
    "desktop_market_uninstall", "desktop_market_cleanup", "desktop_market_api",
    *("desktop_market_" + case for case in PROBE_V070_CASES),
}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def valid_market_annex(value: Any, artifact: Path, source_commit: str, driver_digest: str,
                       expected_platform: str, expected_locks: dict[str, str]) -> bool:
    if not isinstance(value, dict) or not artifact.is_file() or artifact.is_symlink():
        return False
    if (not HEX40.fullmatch(source_commit) or not HEX64.fullmatch(driver_digest)
            or expected_platform not in {"macos", "windows"}
            or set(expected_locks) != set(LOCK_SLOTS)
            or not all(isinstance(row, str) and HEX64.fullmatch(row) for row in expected_locks.values())):
        return False
    # Lock slots are states defined by their bound graph and bytes, not
    # lifecycle counters: the final reinstall may legitimately restore the
    # first coexistence identity, and a removed-state rebind may legitimately
    # differ from the historical pre-market digest when installer metadata
    # changed. Only the market install necessarily rewrites the bound profile
    # manifest, so only pre_market != coexistence is a byte-bound requirement.
    locks = value.get("host_lock_digests")
    if not isinstance(locks, dict) or set(locks) != set(LOCK_SLOTS):
        return False
    if any(not isinstance(row, str) or not HEX64.fullmatch(row) for row in locks.values()):
        return False
    # The annex must carry exactly the digests the coordinating acceptance
    # read back on that machine, not merely well-formed identities.
    if locks != expected_locks:
        return False
    if locks["desktop_pre_market"] == locks["desktop_coexistence"]:
        return False
    if value.get("schema") != "native-acceptance/v2" or value.get("gate_profile") != "desktop-market-coexistence/v1":
        return False
    if value.get("status") != "passed" or value.get("product") != "dsh_completion_guard":
        return False
    if value.get("runtime_tree_sha256") is not None or value.get("host_driver_sha256") != driver_digest:
        return False
    repository, package = value.get("repository"), value.get("artifact")
    if not isinstance(repository, dict) or not isinstance(package, dict):
        return False
    if repository.get("commit") != source_commit or not isinstance(repository.get("url"), str):
        return False
    if package.get("git_head") != source_commit or package.get("sha256") != digest(artifact):
        return False
    if (package.get("filename") != artifact.name or type(package.get("size_bytes")) is not int
            or type(package.get("file_count")) is not int or package.get("size_bytes") != artifact.stat().st_size):
        return False
    try:
        with tarfile.open(artifact, "r:gz") as archive:
            files = [entry for entry in archive.getmembers() if entry.isfile()]
            manifests = [entry for entry in files if entry.name == "package/package.json"]
            if len(manifests) != 1 or len(files) != package.get("file_count"):
                return False
            manifest = json.load(archive.extractfile(manifests[0]))
            if manifest.get("gitHead") != source_commit:
                return False
    except (OSError, tarfile.TarError, ValueError, TypeError, AttributeError, json.JSONDecodeError):
        return False
    platform = value.get("platform")
    if not isinstance(platform, dict) or platform.get("os") != expected_platform:
        return False
    if platform.get("shell") != "python-subprocess" or not isinstance(platform.get("toolchain"), dict):
        return False
    if value.get("host_lock_policy") != "dsh-core/v1" or value.get("capability_skips") != ["real_model_request", "graphical_shell", "market_gui"]:
        return False
    cleanup = value.get("cleanup")
    if not isinstance(cleanup, dict) or cleanup.get("status") != "passed" or cleanup.get("remaining_ids") != []:
        return False
    gates = value.get("gates")
    if not isinstance(gates, list) or len(gates) != len(EXPECTED_GATES) or any(not isinstance(row, dict) for row in gates):
        return False
    if any(not isinstance(row.get("id"), str) for row in gates) or {row.get("id") for row in gates} != EXPECTED_GATES:
        return False
    for row in gates:
        subject, evidence = row.get("subject"), row.get("evidence")
        if (row.get("required") is not True or row.get("status") != "passed" or type(row.get("exit_code")) is not int or row.get("exit_code") != 0
                or not isinstance(subject, dict) or subject != {"kind": "artifact", "id": package["sha256"]}
                or not isinstance(evidence, dict) or evidence.get("mode") != "executed"):
            return False
    if value.get("market_coexistence_contract") != CONTRACT:
        return False
    market = value.get("market")
    if not isinstance(market, dict) or market.get("package") != "dshmarket" \
            or set(market) != {"package", "version", "registry_integrity"}:
        return False
    if not isinstance(market.get("version"), str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", market["version"]):
        return False
    if not isinstance(market.get("registry_integrity"), str) or not re.fullmatch(r"sha512-[A-Za-z0-9+/]{86}==", market["registry_integrity"]):
        return False
    market_observation = value.get("market_observation")
    if not isinstance(market_observation, dict) \
            or set(market_observation) != {"schema", "status", "api_schema", "api_version",
                                            "market_version", "boot_id", "port"} \
            or market_observation.get("schema") != "dsh-desktop-market-observation/v1" \
            or market_observation.get("status") != "observed" \
            or market_observation.get("api_schema") != "dsh-market/update-api/v1" \
            or market_observation.get("api_version") != 1 \
            or market_observation.get("market_version") != market.get("version"):
        return False
    if not isinstance(market_observation.get("boot_id"), str) or not market_observation["boot_id"] \
            or type(market_observation.get("port")) is not int or not 0 < market_observation["port"] < 65536:
        return False
    runtime = value.get("desktop_runtime")
    if not isinstance(runtime, dict) or set(runtime) != {"manifest_sha256", "header_sha256", "metadata_sha256", "host_version", "desktop_version", "payload_file_count"}:
        return False
    if any(not isinstance(runtime.get(key), str) or not HEX64.fullmatch(runtime[key]) for key in ("manifest_sha256", "header_sha256", "metadata_sha256")):
        return False
    if (not isinstance(runtime.get("host_version"), str) or not runtime["host_version"]
            or not isinstance(runtime.get("desktop_version"), str) or not runtime["desktop_version"]
            or type(runtime.get("payload_file_count")) is not int or runtime["payload_file_count"] < 1):
        return False
    if not isinstance(value.get("run"), dict):
        return False
    if not isinstance(value["run"].get("started_at"), str) or not isinstance(value["run"].get("finished_at"), str):
        return False
    actions = value.get("unperformed_actions")
    if (not isinstance(actions, list) or any(not isinstance(row, str) for row in actions)
            or not {"tag", "package_publish", "release"}.issubset(actions)):
        return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("annex", type=Path)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--expected-platform", choices=("macos", "windows"), required=True)
    parser.add_argument("--desktop-pre-market-lock-digest", required=True)
    parser.add_argument("--desktop-coexistence-lock-digest", required=True)
    parser.add_argument("--desktop-removed-rebind-lock-digest", required=True)
    parser.add_argument("--desktop-final-lock-digest", required=True)
    args = parser.parse_args()
    try:
        commit = subprocess.check_output(["git", "-C", str(args.repo_root), "rev-parse", "HEAD"], text=True).strip()
        dirty = subprocess.check_output(["git", "-C", str(args.repo_root), "status", "--porcelain", "--untracked-files=all"], text=True)
        driver = market_driver_digest(args.repo_root)
        value = json.loads(args.annex.read_text(encoding="utf-8"))
        valid = not dirty and valid_market_annex(value, args.artifact, commit, driver,
            args.expected_platform, {
                "desktop_pre_market": args.desktop_pre_market_lock_digest,
                "desktop_coexistence": args.desktop_coexistence_lock_digest,
                "desktop_removed_rebind": args.desktop_removed_rebind_lock_digest,
                "desktop_final": args.desktop_final_lock_digest,
            })
    except (OSError, ValueError, subprocess.CalledProcessError, json.JSONDecodeError, ImportError, AttributeError):
        valid = False
    print("dsh_native_desktop_market=valid" if valid else "dsh_native_desktop_market=invalid")
    return 0 if valid else 1


if __name__ == "__main__":
    raise SystemExit(main())
