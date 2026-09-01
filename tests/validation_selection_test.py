"""Golden tests for this repository's validation selection policy."""

from __future__ import annotations

import importlib.util
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("select_validation", ROOT / "scripts" / "select_validation.py")
assert SPEC and SPEC.loader
SELECTOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SELECTOR)


class ValidationSelectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.mapping, cls.map_sha256 = SELECTOR.load_map(ROOT / "validation-map.json")

    def classify(self, *paths: str) -> dict[str, object]:
        return SELECTOR.classify(self.mapping, list(paths), map_sha256=self.map_sha256, base="a" * 40, head="b" * 40)

    def test_packaged_docs_invalidate_artifact(self) -> None:
        plan = self.classify("docs/ARCHITECTURE.md")
        self.assertEqual(plan["gates"], ["artifact_identity", "docs_contract", "package_tests"])
        self.assertIn("artifact", plan["invalidates"])
        self.assertIn("native_artifact", plan["invalidates"])
        self.assertFalse(plan["full_required"])

    def test_non_packaged_docs_preserve_runtime_and_artifact(self) -> None:
        plan = self.classify("assets/social/completion-guard-hero.png")
        self.assertEqual(plan["gates"], ["docs_contract"])
        self.assertEqual(plan["invalidates"], ["documentation"])

    def test_test_only_selects_focused_group(self) -> None:
        plan = self.classify("tests/runtime.test.ts")
        self.assertEqual(plan["gates"], ["focused_tests"])
        self.assertEqual(plan["invalidates"], ["candidate_matrix"])

    def test_runtime_invalidates_native_evidence(self) -> None:
        plan = self.classify("src/runtime.ts")
        self.assertIn("typecheck", plan["gates"])
        self.assertIn("native_runtime", plan["invalidates"])

    def test_packaging_invalidates_artifact_and_downstream_evidence(self) -> None:
        plan = self.classify("package.json")
        self.assertEqual(plan["invalidates"], ["artifact", "native_artifact", "publication_identity"])

    def test_shared_contract_selects_peer_gate(self) -> None:
        plan = self.classify("tests/fixtures/conformance/digest_v3/cases.json")
        self.assertEqual(plan["contracts"], ["context_guard_semantics_v1", "digest_v3"])
        self.assertEqual(plan["peer_gates"], {"codex_context_guard": ["contract_tests"]})

    def test_host_lock_selects_native_focused_gate(self) -> None:
        plan = self.classify("src/domain/host-lock.ts")
        self.assertIn("host_lock_tests", plan["gates"])
        self.assertIn("native_runtime", plan["invalidates"])

    def test_host_lock_test_does_not_invalidate_native_evidence(self) -> None:
        plan = self.classify("tests/domain/v030-host-lock.test.ts")
        self.assertIn("host_lock_tests", plan["gates"])
        self.assertNotIn("native_runtime", plan["invalidates"])

    def test_release_pack_test_does_not_invalidate_artifact(self) -> None:
        plan = self.classify("tests/release-pack.node.mjs")
        self.assertIn("package_tests", plan["gates"])
        self.assertNotIn("artifact", plan["invalidates"])

    def test_stats_change_does_not_select_product_suite(self) -> None:
        plan = self.classify("scripts/npm-download-stats.mjs")
        self.assertEqual(plan["gates"], ["stats_tests"])

    def test_unknown_path_fails_closed(self) -> None:
        plan = self.classify("unexpected/new-format.bin")
        self.assertTrue(plan["full_required"])
        self.assertEqual(plan["unknown_paths"], ["unexpected/new-format.bin"])
        self.assertEqual(plan["gates"], ["full_candidate"])

    def test_validation_infrastructure_requires_full_candidate(self) -> None:
        plan = self.classify("validation-map.json")
        self.assertTrue(plan["full_required"])
        self.assertEqual(plan["gates"], ["full_candidate"])

    def test_overlapping_rules_are_additive(self) -> None:
        plan = self.classify("cordis.patch.yml")
        self.assertIn("host_lock_tests", plan["gates"])
        self.assertIn("package_tests", plan["gates"])

    def test_empty_diff_selects_nothing(self) -> None:
        plan = self.classify()
        self.assertEqual(plan["gates"], [])
        self.assertFalse(plan["full_required"])

    def test_current_tracked_tree_has_no_unknown_paths(self) -> None:
        paths = subprocess.run(["git", "-C", str(ROOT), "ls-files"], text=True, capture_output=True, check=True).stdout.splitlines()
        self.assertEqual(self.classify(*paths)["unknown_paths"], [])

    def test_rejects_unsafe_changed_path(self) -> None:
        with self.assertRaises(SELECTOR.SelectionError):
            self.classify("../outside")


if __name__ == "__main__":
    unittest.main()
