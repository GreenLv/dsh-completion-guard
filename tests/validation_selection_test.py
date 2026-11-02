"""Golden tests for this repository's validation selection policy."""

from __future__ import annotations

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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

    def test_portability_matrix_reduces_only_reviewed_inputs(self) -> None:
        for paths in (("README.md",), ("src/domain/parse-cache.ts", "tests/v083-parse-cache.test.ts", "dist/index.js"),
                      ("tests/v083-parse-cache.test.ts",)):
            with self.subTest(paths=paths):
                with mock.patch.object(SELECTOR, "portable_changes_are_safe", return_value=True):
                    self.assertFalse(SELECTOR.full_portability_matrix(self.classify(*paths), ROOT))
        for paths in (("dist/index.js",), ("src/runtime.ts",), ("package.json",),
                      ("src/domain/host-lock.ts",), ("docs/SEMANTIC_COMPATIBILITY.md",),
                      ("tests/fixtures/conformance/digest_v3/cases.json",),
                      ("scripts/native_acceptance.py",), ("validation-map.json",),
                      ("unexpected/new-format.bin",), ("src/domain/parse-cache.ts", "package.json"),
                      ("src/domain/parse-cache.ts", "tests/new-validator.test.ts")):
            with self.subTest(paths=paths):
                self.assertTrue(SELECTOR.full_portability_matrix(self.classify(*paths)))

    def test_short_matrix_source_screen_fails_closed_on_platform_and_unreadable_inputs(self) -> None:
        plan = self.classify("src/domain/parse-cache.ts", "tests/v083-parse-cache.test.ts", "dist/index.js")
        def response(cmd, **kwargs):
            if "show" in cmd:
                return subprocess.CompletedProcess(cmd, 0, "export class ParseCache {}", "")
            if "diff" in cmd:
                return subprocess.CompletedProcess(cmd, 0, "+expect(cache.get('a')).toBe(1)\n", "")
            return subprocess.CompletedProcess(cmd, 0, b"", b"")
        with mock.patch.object(SELECTOR.subprocess, "run", side_effect=response):
            self.assertFalse(SELECTOR.full_portability_matrix(plan, ROOT))
        def unsafe(cmd, **kwargs):
            if "show" in cmd:
                return subprocess.CompletedProcess(cmd, 0, "import { spawn } from 'node:child_process'", "")
            return response(cmd, **kwargs)
        with mock.patch.object(SELECTOR.subprocess, "run", side_effect=unsafe):
            self.assertTrue(SELECTOR.full_portability_matrix(plan, ROOT))
        with mock.patch.object(SELECTOR.subprocess, "run", side_effect=OSError("missing Git")):
            self.assertTrue(SELECTOR.full_portability_matrix(plan, ROOT))
        def deleted_test(cmd, **kwargs):
            if "diff" in cmd:
                return subprocess.CompletedProcess(cmd, 0, "-expect(true).toBe(true)\n", "")
            return response(cmd, **kwargs)
        with mock.patch.object(SELECTOR.subprocess, "run", side_effect=deleted_test):
            self.assertTrue(SELECTOR.full_portability_matrix(plan, ROOT))

    def test_real_git_base_head_selects_short_then_full_for_platform_change(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.run(["git", "-C", str(root), "-c", "user.name=Test", "-c",
                                       "user.email=test@example.invalid", *args], check=True,
                                      capture_output=True, text=True).stdout.strip()
            git("init", "-q")
            source = root / "src/domain/parse-cache.ts"
            source.parent.mkdir(parents=True)
            source.write_text("export class ParseCache {}\n", encoding="utf-8")
            git("add", ".")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            source.write_text("export class ParseCache { readonly size = 1 }\n", encoding="utf-8")
            git("add", ".")
            git("commit", "-qm", "portable")
            head = git("rev-parse", "HEAD")
            plan = SELECTOR.classify(self.mapping, SELECTOR.changed_paths(root, base, head),
                                     map_sha256=self.map_sha256, base=base, head=head)
            output = root / "output"
            SELECTOR.write_github_outputs(output, plan, root)
            self.assertIn("full_matrix=false\n", output.read_text())
            output.unlink()
            source.write_text("import { spawn } from 'node:child_process'\nexport class ParseCache {}\n", encoding="utf-8")
            git("add", ".")
            git("commit", "-qm", "platform")
            new_head = git("rev-parse", "HEAD")
            plan = SELECTOR.classify(self.mapping, SELECTOR.changed_paths(root, head, new_head),
                                     map_sha256=self.map_sha256, base=head, head=new_head)
            self.assertTrue(SELECTOR.full_portability_matrix(plan, root))

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

    def test_module_checkout_policy_requires_new_artifact_and_native_portable(self) -> None:
        plan = self.classify(".gitattributes")
        self.assertTrue(plan["full_required"])
        self.assertIn("full_candidate", plan["gates"])
        self.assertIn("artifact", plan["invalidates"])
        self.assertIn("native_artifact", plan["invalidates"])
        self.assertEqual(plan["unknown_paths"], [])

    def test_shared_contract_selects_peer_gate(self) -> None:
        plan = self.classify("tests/fixtures/conformance/digest_v3/cases.json")
        self.assertEqual(plan["contracts"], ["context_guard_semantics_v1", "digest_v3"])
        self.assertEqual(plan["peer_gates"], {"codex_context_guard": ["contract_tests"]})

    def test_new_core_v2_scripts_select_contract_gates(self) -> None:
        mirror = self.classify("scripts/verify-core-v2-mirror.mjs")
        self.assertEqual(mirror["unknown_paths"], [])
        self.assertEqual(mirror["contracts"], ["core_v2"])
        self.assertIn("contract_tests", mirror["gates"])
        self.assertEqual(mirror["peer_gates"], {"codex_context_guard": ["contract_tests"]})
        core_fixture = self.classify("tests/fixtures/conformance/core_v2/UPSTREAM_PIN.json")
        self.assertEqual(core_fixture["contracts"], ["core_v2"])
        self.assertEqual(core_fixture["unknown_paths"], [])
        core_test = self.classify("tests/core-v2-mirror.test.ts")
        self.assertIn("contract_tests", core_test["gates"])
        replay = self.classify("scripts/replay_raw_v2.mjs")
        self.assertEqual(replay["unknown_paths"], [])
        self.assertIn("contract_tests", replay["gates"])
        self.assertIn("focused_tests", replay["gates"])

    def test_local_history_measurement_selects_host_audit_gates(self) -> None:
        plan = self.classify("scripts/measure-local-history.mjs")
        self.assertEqual(plan["unknown_paths"], [])
        self.assertEqual(plan["gates"], ["artifact_identity", "static_contracts"])
        self.assertEqual(plan["invalidates"], ["artifact", "native_artifact"])
        self.assertFalse(plan["full_required"])

    def test_host_lock_selects_native_focused_gate(self) -> None:
        plan = self.classify("src/domain/host-lock.ts")
        self.assertIn("host_lock_tests", plan["gates"])

    def test_host_version_contract_requires_full_candidate(self) -> None:
        plan = self.classify("src/domain/host-version.ts")
        self.assertTrue(plan["full_required"])
        self.assertIn("full_candidate", plan["gates"])
        self.assertIn("native_runtime", plan["invalidates"])
        self.assertIn("publication_identity", plan["invalidates"])
        self.assertEqual(plan["unknown_paths"], [])
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

    def test_new_native_profile_paths_are_mapped(self) -> None:
        for path in ("scripts/native_host_probe_v070.mjs", "scripts/native_release_fixture_v070.mjs",
                     "schemas/native-host-probe-v2.schema.json", "schemas/native-host-bound-v4.schema.json",
                     "scripts/validate_native_v070.py", "tests/validate_native_v070_test.py",
                     "scripts/native_warm_acceptance.py", "scripts/native_warm_scope_core.mjs",
                     "scripts/native_warm_scope_preflight.py", "scripts/native_warm_scope_consumer.mjs",
                     "schemas/native-warm-scope-v1.schema.json"):
            plan = self.classify(path)
            self.assertEqual(plan["unknown_paths"], [])
            self.assertIn("native_artifact", plan["invalidates"])
            self.assertTrue(plan["full_required"])

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


class GateVocabularyTests(unittest.TestCase):
    """CG-083-VAL03: the map, the selector and the runner share ONE gate word
    list. A rule may only emit gates the runner can execute; anything else
    would turn a mapped plan into `empty or unknown gate set` at run time."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.mapping, _ = SELECTOR.load_map(ROOT / "validation-map.json")
        runner_spec = importlib.util.spec_from_file_location("run_selected_validation", ROOT / "scripts" / "run_selected_validation.py")
        assert runner_spec and runner_spec.loader
        cls.runner = importlib.util.module_from_spec(runner_spec)
        runner_spec.loader.exec_module(cls.runner)

    def classify(self, *paths: str) -> dict[str, object]:
        mapping, map_sha256 = SELECTOR.load_map(ROOT / "validation-map.json")
        return SELECTOR.classify(mapping, list(paths), map_sha256=map_sha256, base="a" * 40, head="b" * 40)

    def test_every_rule_gate_is_known_to_the_runner(self) -> None:
        known = self.runner.KNOWN_GATES
        emitted: set[str] = {self.mapping["full_gate"], *self.mapping["default"]["gates"]}
        for rule in self.mapping["rules"]:
            emitted.update(rule["gates"])
        self.assertEqual(sorted(emitted - known), [], "map emits gates the runner cannot execute")

    def test_host_audit_tooling_plan_is_executable(self) -> None:
        plan = self.classify("scripts/measure-host-audit.mjs")
        self.assertIn("static_contracts", plan["gates"])
        commands = self.runner.commands_for(plan)
        self.assertTrue(commands, "host_audit_tooling plan must map to a closed command set")

    def test_runner_rejects_unknown_gate_fail_closed(self) -> None:
        with self.assertRaises(self.runner.RunSelectionError):
            self.runner.commands_for({"schema": "change-scoped-validation-plan/v1", "gates": ["static_contracts", "unknown_gate"],
                                      "changed_paths": ["scripts/measure-host-audit.mjs"]})


if __name__ == "__main__":
    unittest.main()
