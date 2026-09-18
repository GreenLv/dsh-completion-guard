"""Exact v4 annex identity controls; v3 remains historical and separate."""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from unittest import mock
from pathlib import Path
import contextlib
import sys

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("validate_native_v070", ROOT / "scripts" / "validate_native_v070.py")
assert SPEC and SPEC.loader
import sys
sys.path.insert(0, str(ROOT / "scripts"))
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)


class V070AnnexTests(unittest.TestCase):
    def test_cli_rejects_dirty_source_even_with_matching_head(self):
        with tempfile.TemporaryDirectory() as directory:
            annex = Path(directory) / "annex.json"
            artifact = Path(directory) / "fixture.tgz"
            annex.write_text("{}", encoding="utf-8")
            artifact.write_bytes(b"fixture")
            argv = ["validate_native_v070.py", str(annex), "--artifact", str(artifact),
                    "--repo-root", directory, "--expected-platform", "macos",
                    "--web-host-lock-digest", "c" * 64, "--headless-host-lock-digest", "d" * 64]
            with mock.patch.object(sys, "argv", argv), \
                 mock.patch.object(VALIDATOR.subprocess, "check_output", side_effect=["a" * 40, " M src/runtime.ts"]), \
                 mock.patch.object(VALIDATOR, "probe_driver_digest", return_value="b" * 64), \
                 mock.patch.object(VALIDATOR, "valid_v070_annex", return_value=True), \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(VALIDATOR.main(), 1)

    def test_exact_artifact_commit_driver_gate_set_and_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "fixture.tgz"
            commit = "a" * 40
            data = json.dumps({"name": "fixture", "version": "0.7.0", "gitHead": commit}).encode()
            with tarfile.open(artifact, "w:gz") as archive:
                row = tarfile.TarInfo("package/package.json")
                row.size = len(data)
                archive.addfile(row, io.BytesIO(data))
            sha = hashlib.sha256(artifact.read_bytes()).hexdigest()
            driver = "b" * 64
            locks = {"web": "c" * 64, "headless": "d" * 64}
            gates = [{"id": id, "required": True, "status": "passed", "exit_code": 0,
                      "subject": {"kind": "artifact", "id": sha}, "evidence": {"mode": "executed"}}
                     for id in sorted(VALIDATOR.EXPECTED_GATES)]
            valid = {"schema": "native-acceptance/v2", "status": "passed", "product": "dsh_completion_guard",
                     "gate_profile": "dsh-host-bound/v4", "repository": {"url": "https://example.invalid/repo.git", "commit": commit},
                     "runtime_tree_sha256": None,
                     "artifact": {"filename": artifact.name, "sha256": sha, "size_bytes": artifact.stat().st_size,
                                  "file_count": 1, "git_head": commit},
                     "platform": {"os": "macos", "shell": "python-subprocess", "toolchain": {"node": "v22"}},
                     "gates": gates, "cleanup": {"status": "passed", "remaining_ids": []},
                     "run": {"started_at": "2026-09-19T00:00:00Z", "finished_at": "2026-09-19T00:01:00Z"},
                     "unperformed_actions": ["tag", "package_publish", "release"],
                     "capability_skips": ["real_model_request"], "host_lock_policy": "dsh-core/v1",
                     "host_driver_sha256": driver, "host_lock_digests": locks,
                     "market_interface": {"status": "not_requested"}}
            check = lambda value, *, tar=artifact, rev=commit, driver_sha=driver, os_name="macos", expected_locks=locks: VALIDATOR.valid_v070_annex(
                value, tar, rev, driver_sha, os_name, expected_locks)
            self.assertTrue(check(valid))
            import native_host_acceptance as producer
            with mock.patch.object(producer, "PROBE_V070_CASES", {"v070_root_v6_delivery"}):
                missing = copy.deepcopy(valid)
                missing["gates"] = [row for row in missing["gates"] if row["id"] != "web_v070_ordinary_test_and_checkpoint"]
                self.assertFalse(check(missing))
            self.assertFalse(check(valid, os_name="windows"))
            self.assertFalse(check(valid, expected_locks={"web": "e" * 64, "headless": "d" * 64}))
            for key, wrong in (("gate_profile", "host_bound_core"), ("host_driver_sha256", "c" * 64),
                               ("capability_skips", []), ("status", "failed")):
                changed = {**valid, key: wrong}
                self.assertFalse(check(changed), key)
            self.assertFalse(check(valid, rev="e" * 40))
            self.assertFalse(check(valid, driver_sha="e" * 64))
            for mutate in (
                lambda v: v["artifact"].update(sha256="e" * 64),
                lambda v: v["artifact"].update(git_head="e" * 40),
                lambda v: v["repository"].update(commit="e" * 40),
                lambda v: v["gates"].pop(),
                lambda v: v["gates"][0].update(status="failed"),
                lambda v: v["cleanup"].update(status="failed", remaining_ids=["owned_process"]),
                lambda v: v["host_lock_digests"].update(web="e" * 64),
            ):
                changed = copy.deepcopy(valid)
                mutate(changed)
                self.assertFalse(check(changed))
            artifact.write_bytes(artifact.read_bytes() + b"changed")
            self.assertFalse(check(valid))


if __name__ == "__main__":
    unittest.main()
