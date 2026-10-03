"""Exact Desktop market-coexistence annex identity controls."""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import io
import json
import sys
import tarfile
import tempfile
import unittest
import contextlib
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location("validate_native_desktop_market", ROOT / "scripts" / "validate_native_desktop_market.py")
assert SPEC and SPEC.loader
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)

HEX64 = "0123456789abcdef" * 4


class DesktopMarketAnnexTests(unittest.TestCase):
    def annex(self, directory: str, *, digest_slots=None):
        artifact = Path(directory) / "fixture.tgz"
        commit = "a" * 40
        data = json.dumps({"name": "fixture", "version": "0.8.4", "gitHead": commit}).encode()
        with tarfile.open(artifact, "w:gz") as archive:
            row = tarfile.TarInfo("package/package.json")
            row.size = len(data)
            archive.addfile(row, io.BytesIO(data))
        sha = hashlib.sha256(artifact.read_bytes()).hexdigest()
        driver = "b" * 64
        slots = digest_slots or {
            "desktop_pre_market": "c" * 64,
            "desktop_coexistence": "d" * 64,
            "desktop_removed_rebind": "c" * 64,
            "desktop_final": "d" * 64,
        }
        gates = [{"id": gate_id, "required": True, "status": "passed", "exit_code": 0,
                  "subject": {"kind": "artifact", "id": sha}, "evidence": {"mode": "executed"}}
                 for gate_id in sorted(VALIDATOR.EXPECTED_GATES)]
        valid = {"schema": "native-acceptance/v2", "status": "passed", "product": "dsh_completion_guard",
                 "gate_profile": "desktop-market-coexistence/v1",
                 "repository": {"url": "https://example.invalid/repo.git", "commit": commit},
                 "runtime_tree_sha256": None,
                 "artifact": {"filename": artifact.name, "sha256": sha, "size_bytes": artifact.stat().st_size,
                              "file_count": 1, "git_head": commit},
                 "platform": {"os": "macos", "shell": "python-subprocess", "toolchain": {"node": "v22"}},
                 "gates": gates, "cleanup": {"status": "passed", "remaining_ids": []},
                 "run": {"started_at": "2026-10-03T00:00:00Z", "finished_at": "2026-10-03T00:01:00Z"},
                 "unperformed_actions": ["tag", "package_publish", "release"],
                 "capability_skips": ["real_model_request", "graphical_shell", "market_gui"],
                 "host_lock_policy": "dsh-core/v1", "host_driver_sha256": driver, "host_lock_digests": slots,
                 "market_coexistence_contract": copy.deepcopy(VALIDATOR.CONTRACT),
                 "market": {"package": "dshmarket", "version": "1.66.6", "registry_integrity": "sha512-" + "A" * 86 + "=="},
                 "market_observation": {"schema": "dsh-desktop-market-observation/v1", "status": "observed",
                                        "api_schema": "dsh-market/update-api/v1", "api_version": 1,
                                        "market_version": "1.66.6", "boot_id": "4242-1699000000000", "port": 45123},
                 "desktop_runtime": {"manifest_sha256": "f" * 64, "header_sha256": "a" * 64, "metadata_sha256": "b" * 64,
                                     "host_version": "0.2.0-rc.2", "desktop_version": "0.2.0", "payload_file_count": 1}}
        return artifact, commit, driver, slots, valid

    def check(self, value, *, tar, commit, driver, os_name, locks):
        return VALIDATOR.valid_market_annex(value, tar, commit, driver, os_name, locks)

    def test_accepts_a_complete_producer_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact, commit, driver, locks, valid = self.annex(directory)
            self.assertTrue(self.check(valid, tar=artifact, commit=commit, driver=driver,
                                       os_name="macos", locks=locks))

    def test_lock_states_follow_bytes_not_lifecycle_counters(self):
        # The final reinstall restored the exact bound bytes, so final == the
        # first coexistence identity is a legal rebind, not a defect.
        with tempfile.TemporaryDirectory() as directory:
            artifact, commit, driver, locks, valid = self.annex(directory)
            self.assertEqual(locks["desktop_final"], locks["desktop_coexistence"])
            self.assertTrue(self.check(valid, tar=artifact, commit=commit, driver=driver,
                                       os_name="macos", locks=locks))
        # A metadata serialization change after removal yields a fresh removed
        # and final identity; every slot may be distinct as well.
        with tempfile.TemporaryDirectory() as directory:
            slots = {"desktop_pre_market": "c" * 64, "desktop_coexistence": "d" * 64,
                     "desktop_removed_rebind": "e" * 64, "desktop_final": "9" * 64}
            artifact, commit, driver, _, valid = self.annex(directory, digest_slots=slots)
            self.assertTrue(self.check(valid, tar=artifact, commit=commit, driver=driver,
                                       os_name="macos", locks=slots))
        # The market install necessarily rewrites the bound profile manifest,
        # so a receipt whose coexistence digest equals the pre-market digest
        # proves no market install happened and must not validate.
        with tempfile.TemporaryDirectory() as directory:
            slots = {"desktop_pre_market": "c" * 64, "desktop_coexistence": "c" * 64,
                     "desktop_removed_rebind": "c" * 64, "desktop_final": "c" * 64}
            artifact, commit, driver, _, valid = self.annex(directory, digest_slots=slots)
            self.assertFalse(self.check(valid, tar=artifact, commit=commit, driver=driver,
                                        os_name="macos", locks=slots))

    def test_rejects_every_identity_gate_and_observation_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact, commit, driver, locks, valid = self.annex(directory)
            self.assertFalse(self.check(valid, tar=artifact, commit=commit, driver=driver,
                                        os_name="windows", locks=locks))
            self.assertFalse(self.check(valid, tar=artifact, commit=commit, driver=driver,
                                        os_name="macos", locks={**locks, "desktop_final": "9" * 64}))
            for key, wrong in (("gate_profile", "dsh-desktop-bound/v2"), ("host_driver_sha256", "c" * 64),
                               ("capability_skips", ["real_model_request", "graphical_shell"]),
                               ("status", "failed"), ("host_lock_policy", "dsh-core/v2")):
                self.assertFalse(self.check({**valid, key: wrong}, tar=artifact, commit=commit,
                                            driver=driver, os_name="macos", locks=locks), key)
            for mutate in (
                    lambda v: v["artifact"].update(sha256="e" * 64),
                    lambda v: v["artifact"].update(git_head="e" * 40),
                    lambda v: v["repository"].update(commit="e" * 40),
                    lambda v: v["gates"].pop(),
                    lambda v: v["gates"][0].update(exit_code=False),
                    lambda v: v["gates"][0].update(id=v["gates"][1]["id"]),
                    lambda v: v["gates"][0].update(status="failed"),
                    lambda v: v["cleanup"].update(status="failed", remaining_ids=["owned_process"]),
                    lambda v: v["host_lock_digests"].update(desktop_final="9" * 64),
                    lambda v: v["host_lock_digests"].pop("desktop_removed_rebind"),
                    lambda v: v["market_coexistence_contract"].update(lock_drift="silent_trust"),
                    lambda v: v["market"].update(version="not-a-version"),
                    lambda v: v["market"].update(package="other-market"),
                    lambda v: v["market"].update(registry_integrity="md5-deadbeef"),
                    lambda v: v["market_observation"].update(status="not_observed"),
                    lambda v: v["market_observation"].update(market_version="1.0.0"),
                    lambda v: v["market_observation"].pop("boot_id"),
                    lambda v: v["market_observation"].update(port=0),
                    lambda v: v["desktop_runtime"].update(header_sha256="invalid"),
                    lambda v: v["unperformed_actions"].remove("tag"),
            ):
                changed = copy.deepcopy(valid)
                mutate(changed)
                self.assertFalse(self.check(changed, tar=artifact, commit=commit, driver=driver,
                                            os_name="macos", locks=locks))
            artifact.write_bytes(artifact.read_bytes() + b"changed")
            self.assertFalse(self.check(valid, tar=artifact, commit=commit, driver=driver,
                                        os_name="macos", locks=locks))

    def test_cli_rejects_dirty_source_even_with_matching_head(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact, _, _, locks, _ = self.annex(directory)
            annex = Path(directory) / "annex.json"
            annex.write_text("{}", encoding="utf-8")
            argv = ["validate_native_desktop_market.py", str(annex), "--artifact", str(artifact),
                    "--repo-root", directory, "--expected-platform", "macos",
                    "--desktop-pre-market-lock-digest", "c" * 64,
                    "--desktop-coexistence-lock-digest", "d" * 64,
                    "--desktop-removed-rebind-lock-digest", "c" * 64,
                    "--desktop-final-lock-digest", "d" * 64]
            with mock.patch.object(sys, "argv", argv), \
                    mock.patch.object(VALIDATOR.subprocess, "check_output", side_effect=["a" * 40, " M src/runtime.ts"]), \
                    mock.patch.object(VALIDATOR, "market_driver_digest", return_value="b" * 64), \
                    mock.patch.object(VALIDATOR, "valid_market_annex", return_value=True), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(VALIDATOR.main(), 1)


if __name__ == "__main__":
    unittest.main()
