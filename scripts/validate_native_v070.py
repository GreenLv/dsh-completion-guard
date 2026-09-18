#!/usr/bin/env python3
"""Validate one 0.7.0 host-bound annex against its exact local source and tgz.

This standard-library consumer is repo-owned. It never starts a host, installs a
package, contacts a registry, or accepts a v3 no-gain profile as a v4 result.
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

from native_host_acceptance import probe_driver_digest

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
WEB_GATES = {
    "web_package_parity", "web_strict_second_noop", "web_host_lock_readback",
    *("web_" + case for case in PROBE_V070_CASES),
    "web_owned_restart_and_persisted_resume", "web_shell_shim",
}
HEADLESS_GATES = {
    "headless_package_parity", "headless_strict_second_noop", "headless_host_lock_readback",
    "headless_missing_credential_boundary",
    *("headless_" + case for case in PROBE_V070_CASES),
    "headless_shell_shim",
}
EXPECTED_GATES = BASE_GATES | WEB_GATES | HEADLESS_GATES


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def valid_v070_annex(value: Any, artifact: Path, source_commit: str, driver_digest: str,
                      expected_platform: str, expected_locks: dict[str, str]) -> bool:
    if not isinstance(value, dict) or not artifact.is_file() or artifact.is_symlink():
        return False
    if (not HEX40.fullmatch(source_commit) or not HEX64.fullmatch(driver_digest)
            or expected_platform not in {"macos", "windows", "linux"}
            or set(expected_locks) != {"web", "headless"}
            or not all(isinstance(row, str) and HEX64.fullmatch(row) for row in expected_locks.values())):
        return False
    if value.get("schema") != "native-acceptance/v2" or value.get("gate_profile") != "dsh-host-bound/v4":
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
    if package.get("filename") != artifact.name or package.get("size_bytes") != artifact.stat().st_size:
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
    lock = value.get("host_lock_digests")
    if not isinstance(lock, dict) or lock != expected_locks:
        return False
    if value.get("host_lock_policy") != "dsh-core/v1" or value.get("capability_skips") != ["real_model_request"]:
        return False
    cleanup = value.get("cleanup")
    if not isinstance(cleanup, dict) or cleanup.get("status") != "passed" or cleanup.get("remaining_ids") != []:
        return False
    gates = value.get("gates")
    if not isinstance(gates, list) or len(gates) != len(EXPECTED_GATES) or any(not isinstance(row, dict) for row in gates):
        return False
    if {row.get("id") for row in gates} != EXPECTED_GATES:
        return False
    for row in gates:
        subject, evidence = row.get("subject"), row.get("evidence")
        if (row.get("required") is not True or row.get("status") != "passed" or row.get("exit_code") != 0
                or not isinstance(subject, dict) or subject != {"kind": "artifact", "id": package["sha256"]}
                or not isinstance(evidence, dict) or evidence.get("mode") != "executed"):
            return False
    if not isinstance(value.get("market_interface"), dict) or not isinstance(value.get("run"), dict):
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
    parser.add_argument("--expected-platform", choices=("macos", "windows", "linux"), required=True)
    parser.add_argument("--web-host-lock-digest", required=True)
    parser.add_argument("--headless-host-lock-digest", required=True)
    args = parser.parse_args()
    try:
        commit = subprocess.check_output(["git", "-C", str(args.repo_root), "rev-parse", "HEAD"], text=True).strip()
        dirty = subprocess.check_output(["git", "-C", str(args.repo_root), "status", "--porcelain", "--untracked-files=all"], text=True)
        driver = probe_driver_digest(args.repo_root, "v070")
        value = json.loads(args.annex.read_text(encoding="utf-8"))
        valid = not dirty and valid_v070_annex(value, args.artifact, commit, driver,
            args.expected_platform, {"web": args.web_host_lock_digest, "headless": args.headless_host_lock_digest})
    except (OSError, ValueError, subprocess.CalledProcessError, json.JSONDecodeError):
        valid = False
    print("dsh_native_v070=valid" if valid else "dsh_native_v070=invalid")
    return 0 if valid else 1


if __name__ == "__main__":
    raise SystemExit(main())
