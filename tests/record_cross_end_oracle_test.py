#!/usr/bin/env python3
"""Unit tests for scripts/record_cross_end_oracle.py (0.6.2 D062-04).

These tests never depend on an installed Codex Context Guard. They use a
synthetic module that exposes the same shape, so the recorder's contract —
execute the real entry points, never write outside an explicit output path,
detect shape drift, and fail closed when the module is absent — is testable
everywhere.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "record_cross_end_oracle.py"
RECORDING = REPO_ROOT / "tests" / "fixtures" / "cross-end" / "codex-0.13.9.facts.json"
BEHAVIOUR_RECORDING = REPO_ROOT / "tests" / "fixtures" / "cross-end" / "codex-0.13.9.behaviour.json"

SYNTHETIC_MODULE = '''
"""Synthetic stand-in exposing the audited entry-point shape."""

PRODUCT_VERSION = "0.0.0-test"
STOP_PROTOCOL_VERSION = "9.9.9"
PROOF_PROTOCOL_VERSION = "1.0.0"
CLASSIFIER_VERSION = "0.0.1"


def clause_metadata(text):
    # A deliberately trivial classifier: this module tests the RECORDER, not
    # the semantics of any real product.
    operation = "test_verify" if "test" in text else "unspecified"
    return {"clauses": [{"operation": operation}]}


def verification_contract(item_id, text, state, asset_ids, clauses=None):
    clauses = clauses or clause_metadata(text)
    return {"mode": "legacy_fallback", "reason": "no_deterministic_contract", "obligations": []}
'''

CALLS_LOG = '''
"""Records which entry points a probe actually invoked."""

PRODUCT_VERSION = "0.0.0-test"
STOP_PROTOCOL_VERSION = "9.9.9"
PROOF_PROTOCOL_VERSION = "1.0.0"
CLASSIFIER_VERSION = "0.0.1"

CALLS = []


def clause_metadata(text):
    CALLS.append("clause_metadata")
    return {"clauses": [{"operation": "unspecified"}]}


def verification_contract(item_id, text, state, asset_ids, clauses=None):
    CALLS.append("verification_contract")
    return {"mode": "legacy_fallback", "reason": "no_deterministic_contract", "obligations": []}


def derive_ordinary_proofs(state):
    CALLS.append("derive_ordinary_proofs")
    return []


def handle_stop(state):
    CALLS.append("handle_stop")
    return 0
'''


def run_recorder(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        check=False,
    )


class RecorderContractTest(unittest.TestCase):
    def test_missing_module_fails_closed_without_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "out.json"
            result = run_recorder("--module", str(Path(tmp) / "absent.py"), "--output", str(output))
            self.assertEqual(result.returncode, 1)
            self.assertFalse(output.exists(), "a missing module must not produce a recording")

    def test_shape_drift_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            module = Path(tmp) / "drifted.py"
            module.write_text('PRODUCT_VERSION = "0.0.0-test"\n')
            output = Path(tmp) / "out.json"
            result = run_recorder("--module", str(module), "--output", str(output))
            self.assertEqual(result.returncode, 2)
            self.assertFalse(output.exists())

    def test_recording_executes_the_real_entry_points_and_binds_the_module(self):
        with tempfile.TemporaryDirectory() as tmp:
            module_path = Path(tmp) / "calls.py"
            module_path.write_text(CALLS_LOG)
            output = Path(tmp) / "out.json"
            result = run_recorder("--module", str(module_path), "--output", str(output))
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(output.read_text())
            self.assertEqual(payload["productVersion"], "0.0.0-test")
            self.assertEqual(payload["executedHere"], ["clause_metadata", "verification_contract"])
            self.assertEqual(len(payload["cases"]), 6)
            # The recording is bound to the module bytes it came from.
            import hashlib
            self.assertEqual(payload["moduleSha256"], hashlib.sha256(module_path.read_bytes()).hexdigest())
            # The probe must NOT have called the read-only entry points: the
            # recorded executed/read-only split is the probe's own claim and is
            # asserted to be disjoint.
            self.assertNotIn("derive_ordinary_proofs", payload["executedHere"])
            for name in payload["readOnly"]:
                self.assertNotIn(name, payload["executedHere"])

    def test_repeat_recording_is_byte_identical(self):
        with tempfile.TemporaryDirectory() as tmp:
            module_path = Path(tmp) / "synthetic.py"
            module_path.write_text(SYNTHETIC_MODULE)
            first = Path(tmp) / "first.json"
            second = Path(tmp) / "second.json"
            self.assertEqual(run_recorder("--module", str(module_path), "--output", str(first)).returncode, 0)
            self.assertEqual(run_recorder("--module", str(module_path), "--output", str(second)).returncode, 0)
            self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_check_mode_reports_drift_without_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            module_path = Path(tmp) / "synthetic.py"
            module_path.write_text(SYNTHETIC_MODULE)
            output = Path(tmp) / "out.json"
            self.assertEqual(run_recorder("--module", str(module_path), "--output", str(output)).returncode, 0)
            before = output.read_bytes()
            self.assertEqual(run_recorder("--module", str(module_path), "--output", str(output), "--check").returncode, 0)
            self.assertEqual(output.read_bytes(), before, "--check must not rewrite the recording")
            output.write_text('{"tampered": true}\n')
            self.assertEqual(run_recorder("--module", str(module_path), "--output", str(output), "--check").returncode, 1)


class CommittedRecordingTest(unittest.TestCase):
    def test_committed_recording_has_the_audited_shape(self):
        payload = json.loads(RECORDING.read_text())
        self.assertEqual(payload["recordingVersion"], "1")
        self.assertEqual(payload["product"], "codex-context-guard")
        self.assertRegex(payload["moduleSha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(payload["executedHere"], ["clause_metadata", "verification_contract"])
        for name in ("derive_ordinary_proofs", "_auto_complete_checkpoint", "handle_stop"):
            self.assertIn(name, payload["readOnly"])
        self.assertGreaterEqual(len(payload["cases"]), 6)
        for case in payload["cases"]:
            self.assertEqual(case["contract_mode"], "legacy_fallback")
            self.assertEqual(case["contract_reason"], "no_deterministic_contract")
            self.assertEqual(case["obligations"], 0)

    def test_committed_behaviour_recording_is_honest_about_what_ran(self):
        payload = json.loads(BEHAVIOUR_RECORDING.read_text())
        self.assertEqual(payload["recordingVersion"], "1")
        self.assertEqual(payload["product"], "codex-context-guard")
        self.assertRegex(payload["moduleSha256"], r"^[0-9a-f]{64}$")
        by_id = {case["id"]: case for case in payload["cases"]}
        # The proof and checkpoint refusals were executed.
        self.assertEqual(by_id["proofs-without-bound-evidence"]["status"], "executed")
        self.assertEqual(by_id["proofs-without-bound-evidence"]["result"], [])
        self.assertEqual(by_id["checkpoint-without-unique-evidence"]["status"], "executed")
        self.assertIsNone(by_id["checkpoint-without-unique-evidence"]["result"])
        # The unmeasurable path is marked, not fabricated.
        self.assertEqual(by_id["handle_stop"]["status"], "not_executed")
        self.assertNotIn("result", by_id["handle_stop"])
        for case in payload["cases"]:
            self.assertIn(case["status"], {"executed", "not_executed", "absent"})
            self.assertTrue(case["note"])

    def test_behaviour_mode_marks_absent_entry_points_and_check_detects_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            module_path = Path(tmp) / "synthetic.py"
            module_path.write_text(SYNTHETIC_MODULE)
            output = Path(tmp) / "behaviour.json"
            # A module without the private entry points records them as ABSENT
            # rather than failing the recording or inventing a result.
            self.assertEqual(
                run_recorder("--mode", "behaviour", "--module", str(module_path), "--output", str(output)).returncode, 0
            )
            payload = json.loads(output.read_text())
            by_id = {case["id"]: case for case in payload["cases"]}
            self.assertEqual(by_id["derive_ordinary_proofs"]["status"], "absent")
            self.assertEqual(by_id["_auto_complete_checkpoint"]["status"], "absent")
            self.assertEqual(by_id["handle_stop"]["status"], "not_executed")
            # --check reports drift and leaves the file alone.
            self.assertEqual(
                run_recorder("--mode", "behaviour", "--module", str(module_path), "--output", str(output), "--check").returncode, 0
            )
            output.write_text('{"tampered": true}\n')
            self.assertEqual(
                run_recorder("--mode", "behaviour", "--module", str(module_path), "--output", str(output), "--check").returncode, 1
            )

    def test_committed_recording_contains_no_private_paths_or_session_content(self):
        raw = RECORDING.read_text()
        for forbidden in ("/Users/", "/home/", "AppData", "session", "transcript", "token", "credential"):
            self.assertNotIn(forbidden, raw, f"recording must not carry {forbidden!r}")


class LifecycleRecorderBoundaryTest(unittest.TestCase):
    def load_recorder(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("recorder_boundary_test", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_requested_version_never_falls_back_to_another_cache(self):
        from unittest.mock import patch
        recorder = self.load_recorder()
        with tempfile.TemporaryDirectory() as tmp:
            other = Path(tmp) / ".codex/plugins/cache/codex-context-guard/context-guard/99.0.0/scripts/context_guard.py"
            other.parent.mkdir(parents=True)
            other.write_text(SYNTHETIC_MODULE)
            with patch.object(Path, "home", return_value=Path(tmp)):
                self.assertIsNone(recorder.find_module(None, "0.13.9"))

    def test_unverified_prompt_fails_and_cleans_disposable_state(self):
        from types import SimpleNamespace
        recorder = self.load_recorder()
        directories = []
        def ingest(root, state, payload):
            directories.append(root)
            (root / "synthetic-state").write_text("only temporary")
        module = SimpleNamespace(new_state=lambda payload: {}, handle_user_prompt=ingest,
                                 latest_requirement_text=lambda root, state: "")
        with self.assertRaisesRegex(ValueError, "did not verify"):
            recorder.record_lifecycle(module, SCRIPT)
        self.assertTrue(directories)
        self.assertTrue(all(not root.exists() for root in directories))


if __name__ == "__main__":
    unittest.main()
