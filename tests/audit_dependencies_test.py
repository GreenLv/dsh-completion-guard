"""Fail-closed dependency advisory gate tests (F10)."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "audit_dependencies.py"
SPEC = importlib.util.spec_from_file_location("audit_dependencies", SCRIPT)
GATE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(GATE)


def advisory(severity: str, module: str = "fixture-pkg", dev: bool = True, key: str | None = None) -> dict:
    return {
        "id": 1,
        "url": "https://github.com/advisories/GHSA-fixture",
        "title": f"Fixture {severity} advisory",
        "severity": severity,
        "module_name": module,
        "dev": dev,
        "findings": [{"version": "1.0.0"}],
    } | ({"key": key} if key else {})


class AuditDependenciesGate(unittest.TestCase):
    def test_clean_report_passes(self) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump({"advisories": {}}, handle)
            path = handle.name
        self.assertEqual(GATE.main(["--report", path]), 0)

    def test_moderate_and_low_are_reported_but_not_blocking(self) -> None:
        report = {"advisories": {"a": advisory("moderate"), "b": advisory("low", dev=False)}}
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(report, handle)
            path = handle.name
        self.assertEqual(GATE.main(["--report", path]), 0)

    def test_high_and_critical_block_including_dev_chains(self) -> None:
        for severity in ("high", "critical"):
            with self.subTest(severity=severity):
                report = {"advisories": {"a": advisory(severity)}}
                with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
                    json.dump(report, handle)
                    path = handle.name
                self.assertEqual(GATE.main(["--report", path]), 1)

    def test_expired_or_mismatched_exception_still_blocks(self) -> None:
        # A blocking advisory without a CURRENT, matching, documented exception
        # entry stays blocking; the exception mechanism cannot weaken the gate.
        report = {"advisories": {"a": advisory("high")}}
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(report, handle)
            path = handle.name
        with tempfile.TemporaryDirectory() as tmp:
            exceptions = Path(tmp) / "exceptions.json"
            exceptions.write_text(json.dumps({
                "schema": "dsh-dependency-scan-exceptions/v1",
                "exceptions": [{"id": "1", "module": "fixture-pkg", "version": "9.9.9",
                                "severity": "high", "rationale": "wrong version",
                                "owner": "t", "expires": "2999-01-01"}],
            }), encoding="utf-8")
            self.assertEqual(GATE.main(["--report", path, "--exceptions", str(exceptions)]), 1)
            exceptions.write_text(json.dumps({
                "schema": "dsh-dependency-scan-exceptions/v1",
                "exceptions": [{"id": "1", "module": "fixture-pkg", "version": "1.0.0",
                                "severity": "high", "rationale": "ok",
                                "owner": "t", "expires": "2000-01-01"}],
            }), encoding="utf-8")
            self.assertEqual(GATE.main(["--report", path, "--exceptions", str(exceptions)]), 2)

    def test_matching_current_exception_is_accepted(self) -> None:
        report = {"advisories": {"a": advisory("high")}}
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(report, handle)
            path = handle.name
        with tempfile.TemporaryDirectory() as tmp:
            exceptions = Path(tmp) / "exceptions.json"
            exceptions.write_text(json.dumps({
                "schema": "dsh-dependency-scan-exceptions/v1",
                "exceptions": [{"id": "1", "module": "fixture-pkg", "version": "1.0.0",
                                "severity": "high", "rationale": "ok",
                                "owner": "t", "expires": "2999-01-01"}],
            }), encoding="utf-8")
            self.assertEqual(GATE.main(["--report", path, "--exceptions", str(exceptions)]), 0)

    def test_malformed_exception_table_fails_closed(self) -> None:
        report = {"advisories": {}}
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(report, handle)
            path = handle.name
        with tempfile.TemporaryDirectory() as tmp:
            exceptions = Path(tmp) / "exceptions.json"
            exceptions.write_text("{not json", encoding="utf-8")
            self.assertEqual(GATE.main(["--report", path, "--exceptions", str(exceptions)]), 2)
            exceptions.write_text(json.dumps({"schema": "wrong", "exceptions": []}), encoding="utf-8")
            self.assertEqual(GATE.main(["--report", path, "--exceptions", str(exceptions)]), 2)

    def test_unparseable_and_non_object_reports_fail_closed(self) -> None:
        for report in ("not json", "[]", '{"advisories": []}', '{"advisories": {"x": "nope"}}', '{"nope": 1}',
                       '{"advisories": {"x": {"severity": "ultra"}}}',
                       '{"advisories": {"x": {"severity": "high", "module_name": "m", "findings": []}}}'):
            with self.subTest(report=report[:30]):
                with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as handle:
                    handle.write(report)
                    path = handle.name
                self.assertEqual(GATE.main(["--report", path]), 2)

    def test_missing_report_file_fails_closed(self) -> None:
        self.assertEqual(GATE.main(["--report", "/nonexistent/audit.json"]), 2)

    def test_evaluate_audit_rows_carry_classification(self) -> None:
        rows = GATE.evaluate_audit({"advisories": {"a": advisory("critical", dev=False)}})
        self.assertEqual(rows["critical"][0]["dev"], "prod")
        self.assertEqual(rows["critical"][0]["module"], "fixture-pkg")


if __name__ == "__main__":
    unittest.main()
