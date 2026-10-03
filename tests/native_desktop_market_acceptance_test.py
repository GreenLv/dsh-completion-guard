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

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("native_desktop_market_acceptance", ROOT / "scripts" / "native_desktop_market_acceptance.py")
assert SPEC and SPEC.loader
MARKET = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MARKET)


class MarketEntrypointTests(unittest.TestCase):
    fixture = base.NativeAcceptanceEntrypointTests.fixture

    def test_schema_closes_the_producer_gate_and_lock_slot_inventory(self):
        schema = json.loads((ROOT / "schemas/native-desktop-market-v1.schema.json").read_text())
        gates = schema["properties"]["gates"]
        self.assertEqual(gates["minItems"], len(MARKET.MARKET_GATES))
        self.assertEqual(gates["maxItems"], len(MARKET.MARKET_GATES))
        self.assertEqual(set(gates["items"]["properties"]["id"]["enum"]), MARKET.MARKET_GATES)
        self.assertEqual(set(schema["properties"]["host_lock_digests"]["required"]), set(MARKET.LOCK_SLOTS))
        self.assertEqual(schema["properties"]["capability_skips"]["const"], MARKET.CAPABILITY_SKIPS)

    def test_market_requires_its_declared_cohorts_before_any_install(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root, _, args = self.fixture(directory)
            with mock.patch.object(NATIVE, "portable_acceptance") as install, \
                    contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                MARKET.main(args + ["--runtime-root", str(root)])
            install.assert_not_called()

    def test_preflight_checks_inputs_and_never_runs_acceptance(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root, output, args = self.fixture(directory)
            args += ["--runtime-root", str(root / "app.asar"), "--desktop-cohort", "0.2.0-rc.2",
                     "--market-cohort", "1.66.6", "--preflight"]
            with mock.patch.object(MARKET, "preflight_source_and_artifact") as source, \
                    mock.patch.object(MARKET, "preflight_market_inputs") as market, \
                    mock.patch.object(NATIVE, "portable_acceptance") as install, \
                    contextlib.redirect_stdout(io.StringIO()) as stdout:
                self.assertEqual(MARKET.main(args), 0)
            source.assert_called_once()
            market.assert_called_once_with(root.resolve(), (root / "app.asar").resolve(), "0.2.0-rc.2", "1.66.6")
            install.assert_not_called()
            self.assertFalse(output.exists())
            self.assertIn("acceptance_not_run", stdout.getvalue())

    def test_transfer_receipt_needs_distinct_credential_free_paths(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root, output, args = self.fixture(directory)
            args += ["--runtime-root", str(root / "app.asar"), "--desktop-cohort", "0.2.0-rc.2",
                     "--market-cohort", "1.66.6", "--transfer-receipt", str(output),
                     "--transport-url", "https://example.invalid/tgz"]
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                MARKET.main(args)

    def test_registry_identity_requires_exact_name_version_and_integrity(self):
        class Response:
            def __init__(self, payload, status=200):
                self.status = status
                self._body = json.dumps(payload).encode()
            def read(self):
                return self._body
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return None

        good = {"name": "dshmarket", "version": "1.66.6", "dist": {"integrity": "sha512-" + "A" * 86}}
        with mock.patch.object(MARKET.urllib.request, "urlopen", return_value=Response(good)):
            self.assertEqual(MARKET.registry_market_identity("1.66.6")["registry_integrity"], "sha512-" + "A" * 86)
        for broken in ({**good, "name": "other"}, {**good, "version": "1.66.7"},
                       {**good, "dist": {}}, {k: v for k, v in good.items() if k != "name"}):
            with mock.patch.object(MARKET.urllib.request, "urlopen", return_value=Response(broken)), \
                    self.assertRaises(RuntimeError):
                MARKET.registry_market_identity("1.66.6")
        with mock.patch.object(MARKET.urllib.request, "urlopen", return_value=Response(good, status=404)), \
                self.assertRaises(RuntimeError):
            MARKET.registry_market_identity("1.66.6")


if __name__ == "__main__":
    unittest.main()
