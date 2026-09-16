"""Real owned-filesystem T06 smoke test; Windows CI checks Windows semantics."""
import importlib.util
import os
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("cleanup_probe", Path(__file__).resolve().parents[1] / "scripts/native_cleanup_probe.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class CleanupProbeTest(unittest.TestCase):
    def test_owned_handle_and_unknown_candidate(self):
        result = probe.run_probe()
        self.assertEqual(result["removalAttempts"], 1)
        self.assertTrue(result["unknownCandidateRetained"])
        self.assertEqual(result["dependencyStatus"], "in_use")
        self.assertIsNone(result["certificate"])
        self.assertEqual(result["cleanup"], "passed")
        if os.name == "nt":
            self.assertEqual(result["contentRemoved"], "partial")
            self.assertEqual(result["directoryRemoved"], "no")
        else:
            self.assertEqual(result["contentRemoved"], "yes")
            self.assertEqual(result["directoryRemoved"], "yes")


if __name__ == "__main__":
    unittest.main()
