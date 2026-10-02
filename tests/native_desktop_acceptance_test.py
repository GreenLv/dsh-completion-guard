import contextlib
import importlib.util
import io
import json
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from tests import native_acceptance_test as base
NATIVE = base.NATIVE


class DesktopEntrypointTests(unittest.TestCase):
    fixture = base.NativeAcceptanceEntrypointTests.fixture

    def test_schema_accepts_complete_producer_gate_inventory(self):
        root = Path(__file__).resolve().parents[1]
        spec = importlib.util.spec_from_file_location("desktop_contract", root / "scripts/native_desktop_acceptance.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        gates = json.loads((root / "schemas/native-desktop-bound-v1.schema.json").read_text())["properties"]["gates"]
        # The producer added a probe gate; a stale 25-item consumer rejected real
        # successful 26-gate native receipts on both platforms.
        count = len(module.DESKTOP_GATES)
        self.assertEqual(gates["minItems"], count)
        self.assertEqual(gates["maxItems"], count)

    def test_desktop_requires_its_own_declared_cohort(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root, _, args = self.fixture(directory)
            with mock.patch.object(NATIVE, "portable_acceptance") as install, \
                    contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                NATIVE.main(args + ["--gate-profile", "desktop_bound", "--runtime-root", str(root)])
            install.assert_not_called()

    def test_desktop_dispatches_signed_carrier_preflight_before_install(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root, output, args = self.fixture(directory)
            args += ["--gate-profile", "desktop_bound", "--runtime-root", str(root / "app.asar"),
                     "--desktop-cohort", "0.2.0-rc.2", "--preflight"]
            helper = SimpleNamespace(preflight_desktop_inputs=mock.Mock())
            spec = SimpleNamespace(loader=SimpleNamespace(exec_module=mock.Mock()))
            with mock.patch.object(NATIVE, "verify_exact_source"), \
                    mock.patch.object(NATIVE, "run", return_value=subprocess.CompletedProcess([], 0, "https://example.invalid/repo.git", "")), \
                    mock.patch.object(NATIVE, "resolve_executable", side_effect=lambda name: name), \
                    mock.patch.object(NATIVE.importlib.util, "spec_from_file_location", return_value=spec), \
                    mock.patch.object(NATIVE.importlib.util, "module_from_spec", return_value=helper), \
                    mock.patch.object(NATIVE, "portable_acceptance") as install, \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(NATIVE.main(args), 0)
            helper.preflight_desktop_inputs.assert_called_once_with(root.resolve(), (root / "app.asar").resolve(), "0.2.0-rc.2")
            install.assert_not_called()
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
