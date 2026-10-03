import contextlib
import copy
import importlib.util
import io
import json
import re
import subprocess
import sys
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

DRIVER = "b" * 64
COMMIT = "a" * 40
PID = 424242
NONCE = "ab" * 12
INTEGRITY = "sha512-" + "A" * 86 + "=="
FIXED_DIGESTS = {name: chr(ord("c") + index) * 64 for index, name in enumerate(MARKET.LOCK_SLOTS)}


def schema_shape(value, schema, path="$"):
    """Bounded structural check of the schema subset this annex uses."""
    problems = []
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict):
            return [f"{path}: expected object"]
        for key in schema.get("required", []):
            if key not in value:
                problems.append(f"{path}: missing required {key}")
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in properties:
                    problems.append(f"{path}: additional property {key}")
        for key, subschema in properties.items():
            if key in value:
                problems += schema_shape(value[key], subschema, f"{path}.{key}")
    elif kind == "array":
        if not isinstance(value, list):
            return [f"{path}: expected array"]
        if "minItems" in schema and len(value) < schema["minItems"]:
            problems.append(f"{path}: too few items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            problems.append(f"{path}: too many items")
        for index, item in enumerate(value):
            problems += schema_shape(item, schema.get("items", {}), f"{path}[{index}]")
    elif kind == "integer":
        if type(value) is not int:
            problems.append(f"{path}: expected integer")
        elif value < schema.get("minimum", value) or value > schema.get("maximum", value):
            problems.append(f"{path}: out of range")
    elif kind == "string":
        if not isinstance(value, str):
            problems.append(f"{path}: expected string")
        elif "pattern" in schema and not re.fullmatch(schema["pattern"], value):
            problems.append(f"{path}: pattern mismatch")
        elif "minLength" in schema and len(value) < schema["minLength"]:
            problems.append(f"{path}: too short")
    if "const" in schema and value != schema["const"]:
        problems.append(f"{path}: const mismatch")
    if "enum" in schema and value not in schema["enum"]:
        problems.append(f"{path}: not in enum")
    return problems


def load_schema():
    return json.loads((ROOT / "schemas/native-desktop-market-v1.schema.json").read_text())


class MarketEntrypointTests(unittest.TestCase):
    fixture = base.NativeAcceptanceEntrypointTests.fixture

    def test_schema_closes_the_producer_gate_and_lock_slot_inventory(self):
        schema = load_schema()
        gates = schema["properties"]["gates"]
        self.assertEqual(gates["minItems"], len(MARKET.MARKET_GATES))
        self.assertEqual(gates["maxItems"], len(MARKET.MARKET_GATES))
        self.assertEqual(set(gates["items"]["properties"]["id"]["enum"]), MARKET.MARKET_GATES)
        self.assertEqual(set(schema["properties"]["host_lock_digests"]["required"]), set(MARKET.LOCK_SLOTS))
        self.assertEqual(set(schema["properties"]["host_lock_digests"]["properties"]), set(MARKET.LOCK_SLOTS))
        self.assertEqual(schema["properties"]["capability_skips"]["const"], MARKET.CAPABILITY_SKIPS)
        self.assertIn("market_observation", schema["required"])

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

        good = {"name": "dshmarket", "version": "1.66.6", "dist": {"integrity": INTEGRITY}}
        with mock.patch.object(MARKET.urllib.request, "urlopen", return_value=Response(good)):
            # The producer projection carries exactly the schema's market keys.
            self.assertEqual(MARKET.registry_market_identity("1.66.6"),
                             {"version": "1.66.6", "registry_integrity": INTEGRITY})
        for broken in ({**good, "name": "other"}, {**good, "version": "1.66.7"},
                       {**good, "dist": {}}, {k: v for k, v in good.items() if k != "name"}):
            with mock.patch.object(MARKET.urllib.request, "urlopen", return_value=Response(broken)), \
                    self.assertRaises(RuntimeError):
                MARKET.registry_market_identity("1.66.6")
        with mock.patch.object(MARKET.urllib.request, "urlopen", return_value=Response(good, status=404)), \
                self.assertRaises(RuntimeError):
            MARKET.registry_market_identity("1.66.6")


class ProducerConsumerClosureTests(unittest.TestCase):
    """End-to-end controls over the REAL producer function with every native
    operation mocked: the produced receipt must satisfy the real schema shape
    and the real consumer; state and fault variants must fail the run."""

    def artifact_fixture(self, directory: str):
        import tarfile as tarfile_module
        artifact = Path(directory) / "candidate.tgz"
        data = json.dumps({"name": "dsh-completion-guard", "gitHead": COMMIT}).encode()
        with tarfile_module.open(artifact, "w:gz") as archive:
            member = tarfile_module.TarInfo("package/package.json")
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
        return artifact, MARKET.NATIVE.sha256(artifact)

    def full_run(self, directory: str, *, inject_digests=None, drift=None, market_status="observed",
                 market_capabilities=None, closure_break=None):
        artifact, artifact_sha = self.artifact_fixture(directory)
        temp = Path(directory) / "owned"
        temp.mkdir()
        profile = temp / "dsh" / "profiles" / "desktop"
        installed = profile / "node_modules" / "dsh-completion-guard"
        archive = Path(directory) / "app.asar"
        schema = load_schema()
        desktop_runtime = {key: value for key, value in
                           schema_shape and {
                               "manifest_sha256": "f" * 64, "header_sha256": "a" * 64,
                               "metadata_sha256": "b" * 64, "host_version": "0.2.0-rc.2",
                               "desktop_version": "0.2.0", "payload_file_count": 1}.items()}
        state = {"market": False, "inject_count": 0, "guard_installed": False}

        def write_manifest():
            manifest = {"name": "dsh-profile-desktop", "private": True,
                        "dependencies": {"dsh-completion-guard": "0.8.4",
                                         **({"dshmarket": "1.66.6"} if state["market"] else {})},
                        "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
                                                         "dsh-completion-guard",
                                                         *(["dshmarket"] if state["market"] else [])]}}}
            (profile / "package.json").write_text(json.dumps(manifest, indent=2) + "\n")

        def command(*args):
            args = tuple(map(str, args))
            if args[-1:] == ("--version",):
                return "v24.0.0"
            if "init" in args:
                (profile / "node_modules").mkdir(parents=True)
                write_manifest()
                return ""
            if "inspect-graph" in args:
                return json.dumps({"status": "supported", "host_version": {"version": "0.2.0-rc.2"},
                                   "packages": [], "desktop_runtime": desktop_runtime})
            if "plugin" in args and "add" in args:
                if "dshmarket@1.66.6" in args:
                    state["market"] = True
                    market_dir = profile / "node_modules" / "dshmarket"
                    market_dir.mkdir(parents=True, exist_ok=True)
                    (market_dir / "package.json").write_text(json.dumps({"name": "dshmarket", "version": "1.66.6"}))
                else:
                    state["guard_installed"] = True
                (installed / "bin").mkdir(parents=True, exist_ok=True)
                (installed / "package.json").write_text(json.dumps({"name": "dsh-completion-guard", "version": "0.8.4"}))
                (installed / "bin" / "dsh-completion-guard-host-lock.mjs").write_text("// locker\n")
                write_manifest()
                return ""
            if "plugin" in args and "remove" in args:
                import shutil as shutil_module
                if "dshmarket" in args:
                    state["market"] = False
                    shutil_module.rmtree(profile / "node_modules" / "dshmarket", ignore_errors=True)
                if "dsh-completion-guard" in args:
                    state["guard_installed"] = False
                    shutil_module.rmtree(installed, ignore_errors=True)
                if "dsh-completion-guard" in args:
                    (profile / "package.json").write_text(json.dumps(
                        {"name": "dsh-profile-desktop", "private": True, "dependencies": {},
                         "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]}}}, indent=2) + "\n")
                else:
                    write_manifest()
                return ""
            if "inspect" in args:
                return json.dumps({"status": "supported", "inspection_scope": "active_profile",
                                   "profile": "desktop", "host_lock_digest": FIXED_DIGESTS["desktop_pre_market"]})
            if "inject" in args:
                digests = inject_digests or [FIXED_DIGESTS[slot] for slot in MARKET.LOCK_SLOTS]
                digest = digests[state["inject_count"]]
                state["inject_count"] += 1
                return json.dumps({"status": "supported", "host_lock_digest": digest})
            if "dump-desktop" in args:
                market_layer = "\n  - label: node_modules/dshmarket\n" if state["market"] else ""
                return f"layers:{market_layer}\n"
            if "verify-dump" in args:
                return "{}"
            if "probe" in args:
                return ""
            return ""

        def popen(argv, **kwargs):
            output = Path(argv[5])
            (temp / "desktop.probe.424242.json").write_text(json.dumps(
                {"schema": "dsh-native-host-probe/v2", "nonce": NONCE,
                 "cases": [{"id": case} for case in MARKET.host.PROBE_V070_CASES]}))
            Path(str(output) + ".driver.json").write_text(json.dumps(
                {"schema": "dsh-desktop-driver/v1", "ready": True, "fatal": False,
                 "shutdown_acknowledged": True, "exit_code": 0, "pid": PID}))
            capabilities = market_capabilities or {
                "schema": MARKET.MARKET_API_SCHEMA, "apiVersion": 1, "marketVersion": "1.66.6",
                "profile": "desktop", "runtime": "desktop", "bootId": f"{PID}-1699000000000"}
            Path(str(output) + ".market.json").write_text(json.dumps(
                {"schema": "dsh-desktop-market-observation/v1", "status": market_status, "nonce": NONCE,
                 "expected_market_version": "1.66.6", "child_pid": PID, "port": 45123,
                 "capabilities": capabilities if market_status == "observed" else None}))
            return SimpleNamespace(wait=mock.Mock(return_value=0), poll=mock.Mock(return_value=0),
                                   returncode=0, pid=PID)

        drift_calls = {"count": 0}

        def fake_run(argv, **kwargs):
            if drift is not None:
                outcome = drift(drift_calls["count"])
            else:
                outcome = "expected"
            drift_calls["count"] += 1
            if outcome == "expected":
                return subprocess.CompletedProcess(argv, 1, "",
                                                   json.dumps({"status": "unavailable",
                                                               "reason_code": MARKET.DRIFT_REASON_CODE}))
            if outcome == "timeout":
                raise subprocess.TimeoutExpired(cmd=argv, timeout=kwargs.get("timeout"))
            if outcome == "zero":
                return subprocess.CompletedProcess(argv, 0, "{}", "")
            if outcome == "missing-module":
                return subprocess.CompletedProcess(argv, 1, "",
                                                   "node: Cannot find module 'synthetic missing executable'")
            if outcome == "other-code":
                return subprocess.CompletedProcess(argv, 1, "",
                                                   json.dumps({"status": "unavailable",
                                                               "reason_code": "active_graph_invalid"}))
            if outcome == "non-json":
                return subprocess.CompletedProcess(argv, 1, "", "fatal: synthetic broken output")
            raise AssertionError(outcome)

        digest_seed = {"value": DRIVER}
        result = {"schema": "native-acceptance/v2", "status": "passed", "product": "dsh_completion_guard",
                  "gate_profile": "portable_artifact",
                  "repository": {"url": "https://example.invalid/repo.git", "commit": COMMIT},
                  "runtime_tree_sha256": None,
                  "artifact": {"filename": artifact.name, "sha256": artifact_sha,
                               "size_bytes": artifact.stat().st_size, "file_count": 1, "git_head": COMMIT},
                  "platform": {"os": "macos", "shell": "python-subprocess",
                               "toolchain": {"python": "3.12", "node": "v24.0.0"}},
                  "gates": [MARKET.NATIVE.gate(name, artifact_sha, passed=True) for name in sorted(MARKET.BASE_GATES)],
                  "cleanup": {"status": "passed", "remaining_ids": []},
                  "run": {"started_at": "2026-10-03T00:00:00Z", "finished_at": None},
                  "unperformed_actions": ["tag", "package_publish", "release"]}
        api = SimpleNamespace(gate=MARKET.NATIVE.gate, sha256=MARKET.NATIVE.sha256,
                              tree_digest=lambda p: "1" * 64, timestamp=MARKET.NATIVE.timestamp)
        with mock.patch.object(MARKET.host, "host_temporary_root", return_value=temp), \
                mock.patch.object(MARKET.host, "isolated_environment", return_value={}), \
                mock.patch.object(MARKET.host, "write_test_fixture", return_value=None), \
                mock.patch.object(MARKET.host, "package_fixture", side_effect=lambda p, v: p / "fixture.tgz"), \
                mock.patch.object(MARKET.host, "run_host_command", side_effect=lambda work, env, *a: command(*a)), \
                mock.patch.object(MARKET.host, "native_probe_patch", return_value={}), \
                mock.patch.object(MARKET.host, "validate_probe", return_value=True), \
                mock.patch.object(MARKET.host, "probe_driver_digest", return_value=DRIVER), \
                mock.patch.object(MARKET.host, "write_host_diagnostic", return_value=None), \
                mock.patch.object(MARKET.desktop, "carrier", return_value=Path("/synthetic/desktop")), \
                mock.patch.object(MARKET.desktop, "assert_slot_available", return_value=None), \
                mock.patch.object(MARKET, "market_driver_digest", return_value=digest_seed["value"]), \
                mock.patch.object(MARKET, "registry_market_identity",
                                  return_value={"version": "1.66.6", "registry_integrity": INTEGRITY}), \
                mock.patch.object(MARKET.secrets, "token_hex", return_value=NONCE), \
                mock.patch.object(MARKET.subprocess, "run", side_effect=fake_run), \
                mock.patch.object(MARKET.subprocess, "Popen", side_effect=popen):
            out = MARKET.market_acceptance(api, ROOT, artifact, artifact_sha, archive,
                                           result, "0.2.0-rc.2", "1.66.6", temp / "diagnostics.json")
        return {"result": out, "artifact": artifact, "driver": digest_seed["value"], "temp": temp}

    def consumer_check(self, out, artifact, locks=None):
        sys.path.insert(0, str(ROOT / "scripts"))
        spec = importlib.util.spec_from_file_location("validate_market_consumer", ROOT / "scripts" / "validate_native_desktop_market.py")
        consumer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(consumer)
        return consumer.valid_market_annex(out, artifact, COMMIT, self.driver_digest, "macos",
                                           locks or out.get("host_lock_digests")), consumer

    def setUp(self):
        self.driver_digest = DRIVER

    def test_healthy_run_produces_schema_and_consumer_valid_receipt(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            run = self.full_run(directory)
            out = run["result"]
            self.assertEqual(out["status"], "passed",
                             json.dumps([g for g in out["gates"] if g["status"] != "passed"], default=str)[:800])
            self.assertEqual(len(out["gates"]), len(MARKET.MARKET_GATES))
            # F1: the receipt the producer built satisfies the real schema and
            # the real consumer, with the run's own digests and runtime facts.
            problems = schema_shape(out, load_schema())
            self.assertEqual(problems, [])
            valid, _ = self.consumer_check(out, run["artifact"])
            self.assertTrue(valid)
            self.assertEqual(set(out["host_lock_digests"]), set(MARKET.LOCK_SLOTS))
            self.assertNotEqual(out["host_lock_digests"]["desktop_pre_market"],
                                out["host_lock_digests"]["desktop_coexistence"])
            self.assertEqual(set(out["market"]), {"package", "version", "registry_integrity"})
            self.assertEqual(out["market_observation"]["status"], "observed")
            self.assertEqual(out["desktop_runtime"]["host_version"], "0.2.0-rc.2")

    def test_field_mutations_break_the_produced_receipt(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            run = self.full_run(directory)
            out = run["result"]
            for mutate in (
                    lambda v: v.pop("host_lock_digests"),
                    lambda v: v.pop("desktop_runtime"),
                    lambda v: v["market"].update(name="dshmarket"),
                    lambda v: v["host_lock_digests"].pop("desktop_removed_rebind"),
                    lambda v: v["market_observation"].update(status="not_observed"),
            ):
                changed = copy.deepcopy(out)
                mutate(changed)
                problems = schema_shape(changed, load_schema())
                self.assertTrue(problems, "expected the schema check to catch the mutation")
                valid, _ = self.consumer_check(changed, run["artifact"],
                                               locks=out["host_lock_digests"])
                self.assertFalse(valid)

    def test_final_may_legally_restore_the_coexistence_identity(self):
        import tempfile
        slots = [FIXED_DIGESTS["desktop_pre_market"], FIXED_DIGESTS["desktop_coexistence"],
                 FIXED_DIGESTS["desktop_removed_rebind"], FIXED_DIGESTS["desktop_coexistence"]]
        with tempfile.TemporaryDirectory() as directory:
            run = self.full_run(directory, inject_digests=slots)
            out = run["result"]
            self.assertEqual(out["status"], "passed")
            self.assertEqual(out["host_lock_digests"]["desktop_final"],
                             out["host_lock_digests"]["desktop_coexistence"])
            valid, _ = self.consumer_check(out, run["artifact"])
            self.assertTrue(valid)

    def test_removed_rebind_may_legally_differ_from_pre_market(self):
        import tempfile
        slots = [FIXED_DIGESTS["desktop_pre_market"], FIXED_DIGESTS["desktop_coexistence"],
                 FIXED_DIGESTS["desktop_final"], FIXED_DIGESTS["desktop_final"]]
        with tempfile.TemporaryDirectory() as directory:
            run = self.full_run(directory, inject_digests=slots)
            out = run["result"]
            self.assertEqual(out["status"], "passed")
            self.assertNotEqual(out["host_lock_digests"]["desktop_removed_rebind"],
                                out["host_lock_digests"]["desktop_pre_market"])

    def test_coexistence_digest_equal_to_pre_market_fails_the_run(self):
        import tempfile
        slots = [FIXED_DIGESTS["desktop_pre_market"], FIXED_DIGESTS["desktop_pre_market"],
                 FIXED_DIGESTS["desktop_removed_rebind"], FIXED_DIGESTS["desktop_final"]]
        with tempfile.TemporaryDirectory() as directory:
            run = self.full_run(directory, inject_digests=slots)
            out = run["result"]
            self.assertEqual(out["status"], "failed")
            notes = [g for g in out["gates"] if g["id"] == "desktop_market_acceptance" and g["status"] == "failed"]
            self.assertTrue(notes)

    def test_drift_fault_variants_fail_the_run(self):
        cases = {
            "missing-module": "desktop_market_lock_drift",
            "zero": "desktop_market_lock_drift",
            "timeout": "desktop_market_lock_drift",
            "other-code": "desktop_market_lock_drift",
            "non-json": "desktop_market_lock_drift",
        }
        for outcome, expected_stage in cases.items():
            with self.subTest(outcome=outcome):
                import tempfile
                with tempfile.TemporaryDirectory() as directory:
                    run = self.full_run(directory, drift=lambda index: outcome)
                    self.assertEqual(run["result"]["status"], "failed")

    def test_removal_side_drift_also_checked(self):
        import tempfile
        def drift(index):
            return "expected" if index == 0 else "zero"
        with tempfile.TemporaryDirectory() as directory:
            run = self.full_run(directory, drift=drift)
            self.assertEqual(run["result"]["status"], "failed")
            notes = [g for g in run["result"]["gates"]
                     if g["id"] == "desktop_market_acceptance" and g["status"] == "failed"]
            self.assertTrue(notes)
            self.assertIn("desktop_market_remove_restore", json.dumps(notes))

    def test_market_instance_must_be_observed_on_the_backend(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            run = self.full_run(directory, market_status="not_observed")
            out = run["result"]
            self.assertEqual(out["status"], "failed")
            self.assertIn("desktop_market_api", json.dumps(
                [g for g in out["gates"] if g["status"] == "failed"]))

    def test_wrong_market_capabilities_fail_the_run(self):
        for capabilities in (
                {"schema": "other-api/v1", "apiVersion": 1, "marketVersion": "1.66.6",
                 "profile": "desktop", "runtime": "desktop", "bootId": f"{PID}-1"},
                {"schema": MARKET.MARKET_API_SCHEMA, "apiVersion": 1, "marketVersion": "1.0.0",
                 "profile": "desktop", "runtime": "desktop", "bootId": f"{PID}-1"},
                {"schema": MARKET.MARKET_API_SCHEMA, "apiVersion": 1, "marketVersion": "1.66.6",
                 "profile": "web", "runtime": "desktop", "bootId": f"{PID}-1"},
                {"schema": MARKET.MARKET_API_SCHEMA, "apiVersion": 1, "marketVersion": "1.66.6",
                 "profile": "desktop", "runtime": "desktop", "bootId": f"{PID + 1}-1"},
        ):
            with self.subTest(schema=capabilities["schema"], version=capabilities["marketVersion"]):
                import tempfile
                with tempfile.TemporaryDirectory() as directory:
                    run = self.full_run(directory, market_capabilities=capabilities)
                    self.assertEqual(run["result"]["status"], "failed")

    def test_receipt_contract_closure_flags_broken_shapes(self):
        healthy = {
            "host_lock_digests": {slot: FIXED_DIGESTS[slot] for slot in MARKET.LOCK_SLOTS},
            "desktop_runtime": {"manifest_sha256": "f" * 64, "header_sha256": "a" * 64,
                                "metadata_sha256": "b" * 64, "host_version": "0.2.0-rc.2",
                                "desktop_version": "0.2.0", "payload_file_count": 1},
            "market": {"package": "dshmarket", "version": "1.66.6", "registry_integrity": INTEGRITY},
            "market_observation": {"schema": "dsh-desktop-market-observation/v1", "status": "observed",
                                   "api_schema": MARKET.MARKET_API_SCHEMA, "api_version": 1,
                                   "market_version": "1.66.6", "boot_id": f"{PID}-1", "port": 45123},
            "gates": [MARKET.NATIVE.gate(name, "a" * 64, passed=True) for name in sorted(MARKET.MARKET_GATES)],
            "market_coexistence_contract": MARKET.CONTRACT,
            "capability_skips": MARKET.CAPABILITY_SKIPS,
        }
        self.assertEqual(MARKET.receipt_contract_closure(healthy), [])
        broken = copy.deepcopy(healthy)
        broken["host_lock_digests"]["desktop_coexistence"] = broken["host_lock_digests"]["desktop_pre_market"]
        self.assertTrue(MARKET.receipt_contract_closure(broken))
        broken = copy.deepcopy(healthy)
        broken["market"]["name"] = "dshmarket"
        self.assertTrue(MARKET.receipt_contract_closure(broken))
        broken = copy.deepcopy(healthy)
        broken["gates"].pop()
        self.assertTrue(MARKET.receipt_contract_closure(broken))


if __name__ == "__main__":
    unittest.main()
