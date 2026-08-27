import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "audit_repository_documentation.py"
SPEC = importlib.util.spec_from_file_location("audit_repository_documentation", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class DocumentationAuditTests(unittest.TestCase):
    def test_passes_existing_local_links_and_reports_document_set(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "README.md").write_text("# Tool\n\nSee [docs](docs/guide.md#usage).\n", encoding="utf-8")
            (root / "README.zh-CN.md").write_text("# 工具\n", encoding="utf-8")
            (root / "docs").mkdir()
            (root / "docs" / "guide.md").write_text("# Guide\n\n## Usage\n", encoding="utf-8")
            result = MODULE.audit(root)
            self.assertEqual(result["errors"], 0)
            self.assertIn("README.md", result["markdown_files"])

    def test_reports_missing_local_targets_and_anchors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "README.md").write_text("# Tool\n\n[missing](missing.md) [anchor](README.md#nope)\n", encoding="utf-8")
            result = MODULE.audit(root)
            codes = {finding["code"] for finding in result["findings"]}
            self.assertEqual(result["errors"], 2)
            self.assertEqual(codes, {"missing-link-target", "missing-anchor"})

    def test_flags_unreleased_changelog_without_failing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "README.md").write_text("# Tool\n", encoding="utf-8")
            (root / "README.zh-CN.md").write_text("# 工具\n", encoding="utf-8")
            (root / "CHANGELOG.md").write_text("# Changelog\n\n## Unreleased\n", encoding="utf-8")
            result = MODULE.audit(root)
            self.assertEqual(result["errors"], 0)
            self.assertEqual(result["warnings"], 2)
            self.assertEqual(
                {finding["code"] for finding in result["findings"] if finding["level"] == "warning"},
                {"unreleased-section", "missing-version"},
            )


if __name__ == "__main__":
    unittest.main()
