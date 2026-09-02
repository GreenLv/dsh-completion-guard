"""Structural regressions for fast PR and exact-candidate workflows."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
EXTERNAL_USE = re.compile(r"^\s*(?:-\s*)?uses:\s+([^\s#]+)@([^\s#]+)", re.MULTILINE)
FULL_COMMIT = re.compile(r"^[0-9a-f]{40}$")


class WorkflowContractTests(unittest.TestCase):
    def test_candidate_matrix_is_independent_and_not_tag_or_pr_triggered(self) -> None:
        text = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        self.assertNotIn("strategy:", text)
        self.assertNotIn("matrix:", text)
        self.assertNotIn("pull_request:", text)
        self.assertNotIn("tags:", text)
        self.assertEqual(text.count("uses: ./.github/workflows/ci-lane.yml"), 6)
        self.assertEqual(text.count("pnpm run typecheck"), 1)
        self.assertEqual(text.count("pnpm run lint"), 1)
        self.assertEqual(text.count("pnpm run build"), 1)
        self.assertIn("if: always()", text)
        self.assertIn("python scripts/verify_required_jobs.py", text)

    def test_pr_gate_is_blocking_and_cancels_only_stale_prs(self) -> None:
        text = (ROOT / ".github" / "workflows" / "validation-shadow.yml").read_text(encoding="utf-8")
        self.assertIn("pull_request:", text)
        self.assertIn("cancel-in-progress: true", text)
        self.assertNotIn("continue-on-error", text)
        self.assertIn("name: PR validation required", text)
        self.assertIn("if: always()", text)

    def test_portable_windows_consumes_one_escrowed_artifact(self) -> None:
        text = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        self.assertIn("name: candidate-${{ github.sha }}", text)
        self.assertIn("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093", text)
        self.assertIn("scripts/native_acceptance.py", text)
        self.assertIn("needs.static.outputs.artifact_sha256", text)
        self.assertIn("artifact-transfer-windows.json", text)
        self.assertIn("contains(needs.classify.outputs.invalidates, 'native_artifact')", text)

    def test_all_external_actions_are_pinned_to_full_commits(self) -> None:
        failures: list[str] = []
        for path in sorted((ROOT / ".github" / "workflows").glob("*.yml")):
            for action, ref in EXTERNAL_USE.findall(path.read_text(encoding="utf-8")):
                if not action.startswith("./") and not FULL_COMMIT.fullmatch(ref):
                    failures.append(f"{path.name}: {action}@{ref}")
        self.assertEqual(failures, [])

    def test_portable_entrypoint_does_not_repeat_source_matrix(self) -> None:
        source = (ROOT / "scripts" / "native_acceptance.py").read_text(encoding="utf-8")
        for fragment in ("pnpm test", "pnpm run typecheck", "pnpm run lint", "vitest"):
            with self.subTest(fragment=fragment):
                self.assertNotIn(fragment, source)


if __name__ == "__main__":
    unittest.main()
