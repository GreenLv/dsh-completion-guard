"""Focused tests for the portable native acceptance entrypoint."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).parents[1] / "scripts" / "native_acceptance.py"
SPEC = importlib.util.spec_from_file_location("native_acceptance", SCRIPT)
assert SPEC and SPEC.loader
NATIVE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(NATIVE)


class NativeAcceptanceEntrypointTests(unittest.TestCase):
    def test_resolves_windows_command_launchers(self) -> None:
        with mock.patch.object(NATIVE.shutil, "which", return_value=r"C:\\nodejs\\npm.cmd"):
            self.assertEqual(NATIVE.resolve_executable("npm"), r"C:\\nodejs\\npm.cmd")

    def test_missing_executable_fails_closed(self) -> None:
        with mock.patch.object(NATIVE.shutil, "which", return_value=None):
            with self.assertRaisesRegex(NATIVE.NativeRunError, "executable not found"):
                NATIVE.resolve_executable("npm")

    def test_normalizes_public_github_ssh_remote(self) -> None:
        self.assertEqual(
            NATIVE.normalize_repository_url("git@github.com:owner/repo.git"),
            "https://github.com/owner/repo.git",
        )

    def test_rejects_credentialed_or_non_github_remote(self) -> None:
        for value in ("https://token@github.com/owner/repo.git", "ssh://example.invalid/repo"):
            with self.subTest(value=value), self.assertRaises(NATIVE.NativeRunError):
                NATIVE.normalize_repository_url(value)

    def test_tar_inventory_rejects_traversal_and_duplicates(self) -> None:
        with self.assertRaises(NATIVE.NativeRunError):
            NATIVE.safe_tar_entries("package/package.json\n../escape\n")
        with self.assertRaises(NATIVE.NativeRunError):
            NATIVE.safe_tar_entries("package/a\npackage/a\n")

    def test_tree_digest_is_stable_and_rejects_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "a.txt").write_text("a", encoding="utf-8")
            first = NATIVE.tree_digest(root)
            self.assertEqual(first, NATIVE.tree_digest(root))
            try:
                (root / "link").symlink_to(root / "a.txt")
            except OSError:
                self.skipTest("symlinks unavailable")
            with self.assertRaises(NATIVE.NativeRunError):
                NATIVE.tree_digest(root)

    def test_transfer_receipt_binds_receiver_to_same_bytes(self) -> None:
        result = {
            "artifact": {"filename": "p.tgz", "sha256": "b" * 64, "size_bytes": 12, "git_head": "a" * 40},
            "repository": {"url": "https://example.invalid/repo", "commit": "a" * 40},
            "platform": {"os": "windows"},
            "run": {"started_at": "2026-09-02T00:00:00Z"},
        }
        receipt = NATIVE.transfer_receipt(result, "https://example.invalid/actions/1")
        self.assertEqual(receipt["transport"]["downloaded_sha256"], "b" * 64)
        self.assertEqual(receipt["receiver"]["source_commit"], "a" * 40)

    def test_exact_source_rejects_untracked_files(self) -> None:
        source_commit = "a" * 40
        results = [
            subprocess.CompletedProcess(["git"], 0, source_commit + "\n", ""),
            subprocess.CompletedProcess(["git"], 0, "?? stray.txt\n", ""),
        ]
        with mock.patch.object(NATIVE, "run", side_effect=results) as command:
            with self.assertRaisesRegex(NATIVE.NativeRunError, "untracked"):
                NATIVE.verify_exact_source(Path("."), source_commit)
        self.assertIn("--untracked-files=all", command.call_args_list[1].args)


class HostBoundEntrypointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("native_host_acceptance", SCRIPT.with_name("native_host_acceptance.py"))
        assert spec and spec.loader
        cls.host = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.host)

    def test_isolated_environment_drops_credentials_and_node_injection(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(self.host.os.environ, {
            "OPENAI_API_KEY": "synthetic-do-not-inherit", "NODE_OPTIONS": "--require unwanted", "DSH_HOME": "daily-profile",
        }):
            env = self.host.isolated_environment(Path(directory))
            self.assertNotIn("OPENAI_API_KEY", env)
            self.assertNotIn("NODE_OPTIONS", env)
            self.assertEqual(env["DSH_HOME"], str(Path(directory) / "dsh"))
            expected = str(Path(directory) / "home")
            self.assertEqual(env["HOME"], expected)
            self.assertEqual(env["USERPROFILE"], expected)
            actual = self.host.subprocess.check_output(
                ["node", "-e", "process.stdout.write(require('node:os').homedir())"], env=env, text=True)
            self.assertEqual(Path(actual).resolve(), Path(expected).resolve())
            self.assertTrue(Path(actual).is_dir())

    def test_probe_requires_all_nonempty_real_host_cases_and_driver_identity(self):
        receipt = {"schema": "dsh-native-host-probe/v1", "nonce": "nonce", "driver_sha256": "a" * 64,
                   "status": "passed", "pid": 100, "real_model_request": False,
                   "cases": [{"id": id, "status": "passed"} for id in self.host.PROBE_CASES]}
        self.assertTrue(self.host.validate_probe(receipt, "nonce", "a" * 64))
        self.assertFalse(self.host.validate_probe(receipt, "other", "a" * 64))
        self.assertFalse(self.host.validate_probe(receipt, "nonce", "b" * 64))
        self.assertFalse(self.host.validate_probe({**receipt, "cases": []}, "nonce", "a" * 64))
        self.assertFalse(self.host.validate_probe({**receipt, "cases": receipt["cases"][:-1]}, "nonce", "a" * 64))

    def test_probe_resolves_dependencies_from_real_pnpm_package_location(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / "store" / "node_modules" / "@deepseek-ai" / "dsh"
            package.mkdir(parents=True)
            (package / "package.json").write_text('{"name":"@deepseek-ai/dsh"}')
            dependency = root / "store" / "node_modules" / "fixture-dependency"
            dependency.mkdir()
            (dependency / "index.js").write_text('module.exports = 42')
            link = root / "runtime" / "node_modules" / "@deepseek-ai" / "dsh"
            link.parent.mkdir(parents=True)
            try:
                link.symlink_to(package, target_is_directory=True)
            except OSError:
                self.skipTest("directory symlink creation unavailable on this host")
            probe = SCRIPT.with_name("native_host_probe.mjs").resolve().as_uri()
            code = f"import {{ runtimeRequire }} from {json.dumps(probe)}; process.stdout.write(String(runtimeRequire(process.argv[1])('fixture-dependency')))"
            value = subprocess.check_output(["node", "--input-type=module", "-e", code, str(root / "runtime")], text=True)
            self.assertEqual(value, "42")

    def test_probe_starts_from_launcher_readiness_and_reports_initialization_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            probe = SCRIPT.with_name("native_host_probe.mjs").resolve().as_uri()
            code = f"""
                import {{ apply, inject }} from {json.dumps(probe)};
                import {{ readFileSync }} from 'node:fs';
                import assert from 'node:assert/strict';
                let ready;
                const ctx = {{ effect: fn => fn(), appReady: {{ onReady: fn => {{ ready = fn; return () => {{}}; }} }} }};
                assert.ok(!inject.includes('tools'));
                apply(ctx, {{ runtimeRoot: process.argv[1], output: process.argv[1] + '/probe', nonce: 'fixture' }});
                assert.equal(typeof ready, 'function');
                await ready();
                const result = JSON.parse(readFileSync(process.argv[1] + '/probe.' + process.pid + '.json'));
                assert.equal(result.status, 'failed');
                assert.equal(result.cases[0].id, 'initialize_runtime');
                process.stdout.write('readiness_failure_recorded');
            """
            value = subprocess.check_output(["node", "--input-type=module", "-e", code, str(root)], text=True)
            self.assertEqual(value, "readiness_failure_recorded")

    def test_native_factory_mounts_the_standard_preset_before_use_and_on_resume(self):
        probe = SCRIPT.with_name("native_host_probe.mjs").resolve().as_uri()
        code = f"""
            import {{ createProbeAgent }} from {json.dumps(probe)};
            import assert from 'node:assert/strict';
            const events = [];
            const agentCtx = {{}};
            const presets = {{ resolve: async id => ({{id}}), mount: async (ctx, id) => {{ assert.equal(ctx, agentCtx); assert.equal(id, 'standard'); events.push('mount'); }} }};
            const handle = {{ agent: {{ whenIdle: async () => events.push('idle') }} }};
            const ctx = {{ get: name => name === 'agentPresets' ? presets : undefined, agents: {{
                create: async options => {{ assert.equal(options.meta.agentPreset, 'standard'); await options.setup(agentCtx); events.push('create'); return handle; }},
                resume: async options => {{ assert.equal(options.resumeSessionId, 'fixture'); await options.setup(agentCtx); events.push('resume'); return handle; }}
            }} }};
            await createProbeAgent(ctx, 'fixture', '/work');
            await createProbeAgent(ctx, 'fixture', '/work', true);
            assert.deepEqual(events, ['mount', 'create', 'idle', 'mount', 'resume', 'idle']);
            process.stdout.write('preset_lifecycle_passed');
        """
        value = subprocess.check_output(["node", "--input-type=module", "-e", code], text=True)
        self.assertEqual(value, 'preset_lifecycle_passed')

    def test_native_probe_reads_folded_binding_details_with_snapshot(self):
        probe = SCRIPT.with_name("native_host_probe.mjs").resolve().as_uri()
        code = f"""
            import {{ readProbeItem }} from {json.dumps(probe)};
            import assert from 'node:assert/strict';
            const item = {{ id: 'R003', binding_template: {{ evidence_ids: ['resolution', 'effect', 'state'] }} }};
            const text = JSON.stringify([item]);
            let calls = 0;
            const call = async (name, args) => {{
                assert.equal(name, 'context_guard_checkpoint');
                assert.equal(args.detail_id, 'detail-token');
                assert.equal(args.detail_offset, calls * 20);
                if (calls) assert.equal(args.detail_snapshot, 'same-snapshot');
                calls++;
                const end = Math.min(args.detail_offset + 20, text.length);
                return {{ detail_chunk: text.slice(args.detail_offset, end), snapshot: 'same-snapshot', next_detail_offset: end < text.length ? end : null }};
            }};
            assert.deepEqual(await readProbeItem(call, {{open_items: [{{id: item.id, omitted: true, detail_id: 'detail-token'}}]}}, item.id), item);
            assert.ok(calls > 1);
            assert.deepEqual(await readProbeItem(() => {{ throw Error('unexpected detail request'); }}, {{open_items: [item]}}, item.id), item);
            process.stdout.write('detail_roundtrip_passed');
        """
        value = subprocess.check_output(["node", "--input-type=module", "-e", code], text=True)
        self.assertEqual(value, 'detail_roundtrip_passed')

    def test_restart_cleanup_discovers_only_exact_owned_patch_argv(self):
        cli, overlay = Path('/runtime/dsh/bin.js'), Path('/tmp/isolated profile/probe.yml')
        command = 'node /runtime/dsh/bin.js --profile web --patch "/tmp/isolated profile/probe.yml"'
        self.assertTrue(self.host.owns_host_command(command, cli, overlay))
        self.assertFalse(self.host.owns_host_command(command + '.other', cli, overlay))
        self.assertFalse(self.host.owns_host_command(command.replace('--patch', '--other'), cli, overlay))
        self.assertFalse(self.host.owns_host_command(command.replace('/runtime/dsh/bin.js', '/other/bin.js'), cli, overlay))
        windows_cli, windows_overlay = Path(r'C:\Runtime\bin.js'), Path(r'C:\Temp\probe root\probe.yml')
        self.assertTrue(self.host.owns_host_command('node "C:\\Runtime\\bin.js" --patch "C:\\Temp\\probe root\\probe.yml"', windows_cli, windows_overlay, True))
        process_rows = f'101 {command}\n102 node /runtime/dsh/bin.js --patch /tmp/other.yml\n'
        with mock.patch.object(self.host.platform, 'system', return_value='Darwin'), mock.patch.object(self.host.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, process_rows)):
            self.assertEqual(self.host.discover_owned_hosts(cli, [overlay]), {101: overlay})

    def test_restart_probe_requires_persisted_resume_without_repeating_update(self):
        receipt = {"schema": "dsh-native-host-probe/v1", "nonce": "nonce", "driver_sha256": "a" * 64,
                   "mode": "restart", "status": "passed", "pid": 100, "real_model_request": False,
                   "cases": [{"id": "persisted_restart_resume", "status": "passed"}]}
        self.assertTrue(self.host.validate_probe(receipt, "nonce", "a" * 64, restart=True))
        self.assertFalse(self.host.validate_probe(receipt, "nonce", "a" * 64))
        self.assertFalse(self.host.validate_probe({**receipt, "cases": []}, "nonce", "a" * 64, restart=True))

    def test_failed_portable_gate_never_starts_a_host(self):
        result = {"status": "failed", "gates": []}
        with mock.patch.object(self.host.tempfile, "mkdtemp") as create:
            actual = self.host.host_acceptance(None, Path("."), Path("artifact.tgz"), "a" * 64, Path("runtime"), result)
        self.assertEqual(actual["status"], "failed")
        create.assert_not_called()


if __name__ == "__main__":
    unittest.main()
