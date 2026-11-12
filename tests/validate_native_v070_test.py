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
    def test_incident_evidence_requires_external_output_before_fixture_creation(self):
        import native_host_acceptance as host
        with mock.patch.object(host, "host_temporary_root") as allocate:
            with self.assertRaisesRegex(ValueError, "external diagnostics output"):
                host.host_acceptance(None, Path('.'), Path('artifact.tgz'), 'a' * 64,
                                     Path('runtime'), {}, protocol='v070')
            allocate.assert_not_called()

    @staticmethod
    def incident(kind):
        base = {"schema": "dsh-native-incident-summary/v1", "case": kind,
                "input_boundary": "current_contract_analogue", "evidence_sha256": "f" * 64}
        if kind == "archive043":
            return {**base, "compound_reason": "native_git_command_unsupported", "commit_reason": "git_commit_observed",
                    "push_reason": "git_push_observed", "ordinary_action_reason": "ordinary_action_migrated_to_host_tools",
                    "missing_effect_reason": "native_effect_missing", "refs_verified": True, "persisted_reopen": True}
        return {**base, "scenes": [{"name": name, "pending_before": 2 if name.startswith("old_") else 0,
                 "preserved_pending": True, "no_new_selection": True, "persisted_reopen": True,
                 "reason": "pending_without_action_basis"} for name in
                ("old_unclarified", "old_clarified", "fresh_unclarified", "fresh_clarified")]}

    def test_incident_consumer_requires_exact_reasons_scope_restore_and_matrix(self):
        import native_host_acceptance as host
        for kind in ("archive043", "archive044"):
            value = self.incident(kind)
            self.assertTrue(host.valid_incident_summary(value, kind))
            for key in list(value):
                changed = copy.deepcopy(value)
                del changed[key]
                self.assertFalse(host.valid_incident_summary(changed, kind), key)
            self.assertFalse(host.valid_incident_summary({**value, "raw_tool_text": "private"}, kind))
            self.assertFalse(host.valid_incident_summary({**value, "evidence_sha256": "not-bound"}, kind))
            self.assertFalse(host.valid_incident_summary({**value, "input_boundary": "historical_exact_reproduction"}, kind))
        for key, wrong in (("compound_reason", "native_effect_failed"), ("persisted_reopen", False), ("refs_verified", 1)):
            value = self.incident("archive043")
            value[key] = wrong
            self.assertFalse(host.valid_incident_summary(value, "archive043"))
        for change in (
            lambda v: v["scenes"].pop(),
            lambda v: v["scenes"].reverse(),
            lambda v: v["scenes"][0].update(pending_before=1),
            lambda v: v["scenes"][2].update(pending_before=2),
            lambda v: v["scenes"][1].update(no_new_selection=False),
            lambda v: v["scenes"][0].update(persisted_reopen=False),
            lambda v: v["scenes"][0].update(reason="/private/path"),
        ):
            value = self.incident("archive044")
            change(value)
            self.assertFalse(host.valid_incident_summary(value, "archive044"))

    def test_probe_cannot_pass_new_cases_without_consumed_incident_facts(self):
        import native_host_acceptance as host
        cases = [{"id": id, "status": "passed", "positive": True, "negative": True} for id in sorted(host.PROBE_V070_CASES)]
        for row in cases:
            if "archive043" in row["id"]:
                row["incident"] = self.incident("archive043")
            if "archive044" in row["id"]:
                row["incident"] = self.incident("archive044")
        value = {"schema": "dsh-native-host-probe/v2", "nonce": "unit", "pid": 12, "mode": "initial",
                 "driver_sha256": "a" * 64, "status": "passed", "real_model_request": False, "cases": cases}
        self.assertTrue(host.validate_probe(value, "unit", "a" * 64, protocol="v070"))
        for row in cases:
            if "incident" not in row:
                continue
            saved = row.pop("incident")
            self.assertFalse(host.validate_probe(value, "unit", "a" * 64, protocol="v070"))
            row["incident"] = saved
        private = {"cases": [{"id": "v070_archive043_git_chain", "status": "failed", "operation": "/private/path",
                              "incident": {"raw_text": "private credential"}, "error_code": "INCIDENT_ASSERTION_FAILED"}]}
        safe = json.dumps(host.safe_probe_failures(private))
        self.assertNotIn("private", safe)
        self.assertIn("v070_archive043_git_chain", safe)

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
