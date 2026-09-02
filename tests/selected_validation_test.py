"""Regression tests for selected validation command mapping."""

from __future__ import annotations

import importlib.util
import unittest
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

    def test_full_candidate_includes_complete_local_gate_once(self) -> None:
        commands = RUNNER.commands_for(plan(["full_candidate"], ["validation-map.json"]))
        joined = [" ".join(command) for command in commands]
        self.assertEqual(sum(item == "pnpm test" for item in joined), 1)
        self.assertTrue(any("test:release-pack" in item for item in joined))
        self.assertTrue(any("test:stats" in item for item in joined))


if __name__ == "__main__":
    unittest.main()
