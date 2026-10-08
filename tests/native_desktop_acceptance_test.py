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

        import sys

        def load(name):
            spec = importlib.util.spec_from_file_location(name, root / "scripts" / (name + ".py"))
            module = importlib.util.module_from_spec(spec)
            with mock.patch.object(sys, "path", [str(root / "scripts"), *sys.path]):
                spec.loader.exec_module(module)
            return module

        desktop = load("native_desktop_acceptance")
        market = load("native_desktop_market_acceptance")
        host = load("native_host_acceptance")
        consumers = [load(name) for name in (
            "validate_native_desktop", "validate_native_desktop_market", "validate_native_v070")]
        import inspect
        import re
        portable = inspect.getsource(NATIVE.portable_acceptance)
        base_gates = set(re.findall(r'gate\("([a-z0-9_]+)", artifact_digest, passed=True', portable))
        host_source = inspect.getsource(host.host_acceptance)
        host_gates = base_gates | set(re.findall(r'passed\("([a-z0-9_]+)"\)', host_source))
        for suffix in re.findall(r'passed\(f"\{profile\}_([a-z0-9_]+)"\)', host_source):
            host_gates.update(profile + "_" + suffix for profile in ("web", "headless"))
        host_gates.update(profile + "_" + case for profile in ("web", "headless")
                          for case in host.PROBE_V070_CASES)
        inventories = (
            ("native-desktop-bound-v2", desktop.DESKTOP_GATES, consumers[0].EXPECTED_GATES),
            ("native-desktop-market-v1", market.MARKET_GATES, consumers[1].EXPECTED_GATES),
            ("native-host-bound-v4", host_gates, consumers[2].EXPECTED_GATES),
        )
        for name, produced, consumed in inventories:
            with self.subTest(contract=name):
                self.assertEqual(produced, consumed)
                gates = json.loads((root / "schemas" / (name + ".schema.json")).read_text())["properties"]["gates"]
                self.assertEqual(gates["minItems"], len(produced))
                self.assertEqual(gates["maxItems"], len(produced))
                identifiers = gates["items"]["properties"]["id"]
                if "enum" in identifiers:
                    self.assertEqual(set(identifiers["enum"]), produced)
                    self.assertEqual(len(identifiers["enum"]), len(produced))
        # The shared probe is the actual Host producer; its emitted cases feed
        # both Web and Headless as well as Desktop and Market consumers.
        driver = (root / "scripts/native_host_probe_v070.mjs").read_text()
        cases = re.search(r"const INITIAL_CASES = \[(.*?)\]", driver, re.S).group(1)
        emitted = re.findall(r"'([^']+)'", cases)
        self.assertEqual(set(emitted), host.PROBE_V070_CASES)
        self.assertEqual(len(emitted), len(host.PROBE_V070_CASES))
        for consumer in consumers:
            self.assertEqual(consumer.PROBE_V070_CASES, host.PROBE_V070_CASES)
        probe = json.loads((root / "schemas/native-host-probe-v2.schema.json").read_text())
        pattern = probe["properties"]["cases"]["items"]["properties"]["id"]["pattern"]
        for identifier in emitted + ["initialize_runtime", "v070_persisted_restart_resume"]:
            self.assertIsNotNone(re.fullmatch(pattern, identifier), identifier)
        self.assertIsNone(re.fullmatch(pattern, "v090_unrecognized_probe"))
        self.assertIsNone(re.fullmatch(pattern, "unrecognized_probe"))

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


class StrictNoopDiagnosticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[1]
        spec = importlib.util.spec_from_file_location("desktop_diagnostic", root / "scripts/native_desktop_acceptance.py")
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def test_field_receipt_contains_names_and_offsets_only(self):
        before = b"prunedAt: old-secret\nstoreDir: private-home\nunknownCredential: token-one\n"
        after = b"prunedAt: new-secret\nstoreDir: other-home\nunknownCredential: token-two\n"
        receipt = self.module.noop_difference(before, after, True)
        self.assertEqual(receipt["changed_top_level_fields"], ["prunedAt", "storeDir"])
        self.assertEqual(receipt["other_changed_field_count"], 1)
        self.assertGreater(receipt["different_byte_count"], 0)
        serialized = json.dumps(receipt)
        for secret in ("secret", "home", "Credential", "token"):
            self.assertNotIn(secret, serialized)

    def test_binary_and_length_changes_have_exact_bounded_offsets(self):
        self.assertEqual(self.module.noop_difference(b"abc", b"axcdef"), {
            "before_size": 3, "after_size": 6, "different_byte_count": 4,
            "first_difference_offset": 1, "last_difference_offset": 5})
        self.assertEqual(self.module.noop_difference(b"", b"x")["first_difference_offset"], 0)

    def test_failure_preserves_private_raw_bytes_and_does_not_overwrite(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            diagnostic = Path(directory) / "diagnostic.json"
            name = "node_modules/.modules.yaml"
            before, after = {".modules.yaml": "a"}, {".modules.yaml": "b"}
            receipt = self.module.strict_noop_receipt(before, after, {name: b"old"}, {name: b"new"}, "tree", "tree", diagnostic)
            private = diagnostic.with_name(diagnostic.name + ".strict-noop-private")
            self.assertEqual(receipt["raw_capture"], "private_local_redacted")
            self.assertEqual((private / "0-before.bin").read_bytes(), b"old")
            self.assertEqual((private / "0-after.bin").read_bytes(), b"new")
            if __import__("os").name != "nt":
                self.assertEqual(private.stat().st_mode & 0o777, 0o700)
                self.assertEqual((private / "0-before.bin").stat().st_mode & 0o777, 0o600)
            again = self.module.strict_noop_receipt(before, after, {name: b"replace"}, {name: b"replace"}, "tree", "tree", diagnostic)
            self.assertEqual(again["raw_capture"], "unavailable")
            self.assertEqual((private / "0-before.bin").read_bytes(), b"old")
            self.assertNotIn(str(directory), json.dumps(receipt))
            error = self.module.StrictNoopFailure(receipt)
            self.assertEqual(json.loads(self.module.host.failure_note("desktop_second_install", error))["diagnostic_code"], "STRICT_SECOND_NOOP_MISMATCH")

    def test_strict_gate_never_captures_on_success_and_never_ignores_hash_or_tree_change(self):
        with mock.patch.object(self.module, "strict_noop_receipt", return_value={}) as receipt, \
                mock.patch.object(self.module, "noop_snapshot", return_value={}):
            self.module.check_strict_noop({"a": "one"}, {"a": "one"}, {}, [], Path("."), "tree", "tree", Path("diagnostic"))
            receipt.assert_not_called()
            for after, tree in (({"a": "two"}, "tree"), ({"a": "one"}, "changed"), ({}, "tree")):
                with self.assertRaises(self.module.StrictNoopFailure):
                    self.module.check_strict_noop({"a": "one"}, after, {}, [], Path("."), "tree", tree, Path("diagnostic"))
            self.assertEqual(receipt.call_count, 3)

    def semantic_check(self, before_value, after_value, *, before_other="same", after_other="same", after_tree="tree"):
        import hashlib
        encode = lambda value: json.dumps(value, ensure_ascii=False, indent=2).encode()
        left, right = encode(before_value), encode(after_value)
        before = {".modules.yaml": hashlib.sha256(left).hexdigest(), "package.json": before_other}
        after = {".modules.yaml": hashlib.sha256(right).hexdigest(), "package.json": after_other}
        with mock.patch.object(self.module, "noop_snapshot", return_value={"node_modules/.modules.yaml": right}), \
                mock.patch.object(self.module, "strict_noop_receipt", return_value={}):
            self.module.check_multi_package_semantic_noop(before, after, {"node_modules/.modules.yaml": left},
                [], Path("."), "tree", after_tree, Path("diagnostic"))
            return 0

    def test_semantic_gate_accepts_only_object_key_order_and_never_writes_metadata(self):
        before = {"hoistedLocations": {"guard": ["guard"], "fixture": ["fixture"]}, "unknown": {"x": 1, "y": True}}
        after = {"unknown": {"y": True, "x": 1}, "hoistedLocations": {"fixture": ["fixture"], "guard": ["guard"]}}
        self.assertEqual(self.semantic_check(before, after), 0)

    def test_real_metadata_files_are_read_only_during_semantic_success(self):
        import tempfile
        import hashlib
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory) / "profile"
            modules = profile / "node_modules" / ".modules.yaml"
            modules.parent.mkdir(parents=True)
            left = json.dumps({"hoistedLocations": {"guard": ["guard"], "fixture": ["fixture"]}}, indent=2).encode()
            right = json.dumps({"hoistedLocations": {"fixture": ["fixture"], "guard": ["guard"]}}, indent=2).encode()
            modules.write_bytes(left)
            captured = self.module.noop_snapshot([modules], profile)
            modules.write_bytes(right)
            diagnostic = Path(directory) / "diagnostic.json"
            self.module.check_multi_package_semantic_noop({".modules.yaml": hashlib.sha256(left).hexdigest()},
                {".modules.yaml": hashlib.sha256(right).hexdigest()}, captured, [modules], profile, "tree", "tree", diagnostic)
            self.assertEqual(modules.read_bytes(), right)
            self.assertFalse(diagnostic.exists())
            self.assertFalse(diagnostic.with_name(diagnostic.name + ".strict-noop-private").exists())
            delta = self.module.noop_difference(left, right, True)
            self.assertEqual(delta["changed_top_level_fields"], ["hoistedLocations"])

    def test_semantic_gate_rejects_every_value_type_and_array_order_change(self):
        before = {"unknown": {"flag": True}, "hoistedLocations": {"guard": ["first", "second"]}}
        for after in ({"unknown": {"flag": 1}, "hoistedLocations": before["hoistedLocations"]},
                      {"unknown": {"flag": False}, "hoistedLocations": before["hoistedLocations"]},
                      {"unknown": before["unknown"], "hoistedLocations": {"guard": ["second", "first"]}},
                      {"unknown": before["unknown"], "hoistedLocations": {"guard": ["first"]}},
                      {"hoistedLocations": before["hoistedLocations"]}):
            with self.subTest(after=after), self.assertRaises(self.module.StrictNoopFailure):
                self.semantic_check(before, after)
        with self.assertRaises(self.module.StrictNoopFailure):
            self.semantic_check({"x": 1}, {"x": 1.0})

    def test_semantic_gate_keeps_other_files_and_package_tree_strict(self):
        for kwargs in ({"after_other": "changed"}, {"after_tree": "changed"}, {"after_other": None}):
            with self.subTest(kwargs=kwargs), self.assertRaises(self.module.StrictNoopFailure):
                self.semantic_check({"x": 1}, {"x": 1}, **kwargs)

    def test_semantic_parser_rejects_duplicate_keys_yaml_and_unobserved_serialization(self):
        for data in (b'{"x":1,"x":1}', b'{"x":{"y":1,"y":1}}', b'x: 1\n', b'[]',
                     b'{"x":NaN}', b'{"x":Infinity}', b'{"x":1e309}', b'\xff', None, b'{"x":1}',
                     b'{\n  "x": 1\n}\n'):
            with self.subTest(data=data), self.assertRaises((ValueError, UnicodeError)):
                self.module.modules_json_value(data)

    def test_semantic_gate_validates_even_byte_identical_invalid_metadata(self):
        data = b'{"x":1,"x":1}'
        with mock.patch.object(self.module, "noop_snapshot", return_value={"node_modules/.modules.yaml": data}), \
                mock.patch.object(self.module, "strict_noop_receipt", return_value={}):
            with self.assertRaises(self.module.StrictNoopFailure):
                self.module.check_multi_package_semantic_noop({".modules.yaml": "same"}, {".modules.yaml": "same"},
                    {"node_modules/.modules.yaml": data}, [], Path("."), "tree", "tree", Path("diagnostic"))

    def test_regular_snapshot_in_native_temporary_directory(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory) / "profile"
            profile.mkdir()
            path = profile / ".modules.yaml"
            path.write_bytes(b"layoutVersion: 5\n")
            self.assertEqual(self.module.noop_snapshot([path], profile), {".modules.yaml": b"layoutVersion: 5\n"})

    def test_selected_root_alias_is_allowed_but_descendant_redirects_are_refused(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            real = root / "real"
            profile = real / "profile"
            profile.mkdir(parents=True)
            normal = profile / "normal"
            normal.write_bytes(b"normal")
            alias = root / "system-root-alias"
            alias.symlink_to(real, target_is_directory=True)
            selected = alias / "profile"
            # Reproduce macOS /var -> /private/var without depending on OS.
            self.assertEqual(self.module.noop_snapshot([selected / "normal"], selected), {"normal": b"normal"})
            internal = profile / "internal"
            internal.mkdir()
            (internal / "file").write_bytes(b"internal")
            (profile / "redirected-parent").symlink_to(internal, target_is_directory=True)
            outside = root / "outside"
            outside.mkdir()
            (outside / "file").write_bytes(b"outside")
            (profile / "escaped-parent").symlink_to(outside, target_is_directory=True)
            redirected = selected / "redirected-parent" / "file"
            escaped = selected / "escaped-parent" / "file"
            self.assertEqual(self.module.noop_snapshot([redirected, escaped], selected), {
                "redirected-parent/file": None, "escaped-parent/file": None})

    def test_capture_refuses_redirected_and_oversized_files(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profile = root / "profile"
            profile.mkdir()
            external = root / "external"
            external.write_bytes(b"private")
            redirected = profile / "redirected"
            redirected.symlink_to(external)
            large = profile / "large"
            large.write_bytes(b"12345")
            with mock.patch.object(self.module, "NOOP_CAPTURE_LIMIT", 4):
                self.assertEqual(self.module.noop_snapshot([redirected, large], profile), {"redirected": None, "large": None})


if __name__ == "__main__":
    unittest.main()
