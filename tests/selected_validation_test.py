"""Regression tests for selected validation command mapping."""

from __future__ import annotations

import importlib.util
import contextlib
import io
import json
import subprocess
import unittest
from unittest import mock
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "run_selected_validation.py"
SPEC = importlib.util.spec_from_file_location("run_selected_validation", SCRIPT)
assert SPEC and SPEC.loader
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


def plan(gates: list[str], paths: list[str]) -> dict[str, object]:
    return {
        "schema": "change-scoped-validation-plan/v1",
        "gates": gates,
        "changed_paths": paths,
        "base_sha": "a" * 40,
        "head_sha": "b" * 40,
    }


class SelectedValidationTests(unittest.TestCase):
    def test_docs_do_not_run_runtime_or_package_gates(self) -> None:
        commands = RUNNER.commands_for(plan(["docs_contract"], ["AGENTS.md"]))
        joined = [" ".join(command) for command in commands]
        self.assertTrue(any("audit_repository_documentation.py" in item for item in joined))
        self.assertFalse(any("pnpm test" in item or "release-pack" in item for item in joined))

    def test_runtime_uses_related_tests_and_exact_static_gates(self) -> None:
        commands = RUNNER.commands_for(
            plan(["build", "focused_tests", "lint", "package_tests", "typecheck"], ["src/index.ts"])
        )
        joined = [" ".join(command) for command in commands]
        self.assertTrue(any("vitest related src/index.ts --run" in item for item in joined))
        self.assertEqual(sum("run typecheck" in item for item in joined), 1)
        self.assertEqual(sum("run build" in item for item in joined), 1)

    def test_unknown_gate_fails_closed(self) -> None:
        with self.assertRaisesRegex(RUNNER.RunSelectionError, "unknown gate"):
            RUNNER.commands_for(plan(["invented"], ["src/index.ts"]))

    def test_desktop_profile_group_has_real_node_and_consumer_commands(self) -> None:
        commands = RUNNER.commands_for(plan(['desktop_profile_tests'], ['scripts/native_profile_preservation.mjs']))
        joined = [' '.join(command) for command in commands]
        self.assertIn('node --test --test-reporter=tap tests/native_profile_preservation.node.mjs', joined)
        self.assertTrue(any('tests.native_desktop_acceptance_test' in item and 'tests.validate_native_desktop_market_test' in item for item in joined))
        self.assertFalse(any('pnpm test' in item for item in joined))

    def test_desktop_group_rejects_empty_plan_and_non_evidence(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(RUNNER.main(['--plan-json', json.dumps(plan(['docs_contract'], ['AGENTS.md'])), '--platform-only']), 2)
        node, python = RUNNER.desktop_profile_commands()
        for output in ('', '# tests 0\n# pass 0\n# skipped 0\n', '# tests 9\n# pass 8\n# skipped 1\n'):
            self.assertFalse(RUNNER.group_output_valid(node, output))
        self.assertTrue(RUNNER.group_output_valid(node, '# tests 9\n# pass 9\n# skipped 0\n'))
        self.assertFalse(RUNNER.group_output_valid(python, 'Ran 2 tests in 0.1s\nOK (skipped=2)'))
        self.assertFalse(RUNNER.group_output_valid(python, ''))
        self.assertTrue(RUNNER.group_output_valid(python, 'Ran 2 tests in 0.1s\nOK'))
        self.assertFalse(RUNNER.fixture_output_valid('Tests 4 skipped (4)'))
        self.assertFalse(RUNNER.fixture_output_valid('Tests 3 passed | 1 skipped (4)'))
        self.assertTrue(RUNNER.fixture_output_valid('Tests 4 passed (4)'))

    def test_desktop_execution_rejects_skipped_or_all_skipped_results(self) -> None:
        args = ['--plan-json', json.dumps(plan(['desktop_profile_tests'], ['scripts/native_profile_preservation.mjs'])), '--platform-only']
        node_ok = subprocess.CompletedProcess([], 0, '# tests 9\n# pass 9\n# skipped 0\n', '')
        node_skipped = subprocess.CompletedProcess([], 0, '# tests 9\n# pass 8\n# skipped 1\n', '')
        python_skipped = subprocess.CompletedProcess([], 0, '', 'Ran 2 tests in 0.1s\nOK (skipped=2)')
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()), mock.patch.object(RUNNER.subprocess, 'run', return_value=node_skipped):
            self.assertEqual(RUNNER.main(args), 1)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()), mock.patch.object(RUNNER.subprocess, 'run', side_effect=[node_ok, python_skipped]):
            self.assertEqual(RUNNER.main(args), 1)

    def test_full_platform_runs_fixture_unless_full_suite_already_covered_it(self) -> None:
        args = ['--plan-json', json.dumps(plan(['full_candidate'], ['validation-map.json'])), '--platform-only', '--list']
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(RUNNER.main(args), 0)
        self.assertIn(RUNNER.native_fixture_commands()[0], json.loads(output.getvalue()))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(RUNNER.main([*args, '--fixtures-covered']), 0)
        self.assertNotIn(RUNNER.native_fixture_commands()[0], json.loads(output.getvalue()))

    def test_full_candidate_includes_complete_local_gate_once(self) -> None:
        commands = RUNNER.commands_for(plan(["full_candidate"], ["validation-map.json"]))
        joined = [" ".join(command) for command in commands]
        self.assertEqual(sum(item == "pnpm test" for item in joined), 1)
        self.assertTrue(any("test:release-pack" in item for item in joined))
        self.assertTrue(any("test:stats" in item for item in joined))


if __name__ == "__main__":
    unittest.main()
