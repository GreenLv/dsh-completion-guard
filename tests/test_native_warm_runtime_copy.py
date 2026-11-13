import importlib.util
import ntpath
import os
import secrets
import shutil
import subprocess
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path, PureWindowsPath
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
spec = importlib.util.spec_from_file_location("warm_copy", SCRIPTS / "native_warm_runtime_copy.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@contextmanager
def directory():
    root = Path(tempfile.gettempdir()).resolve() / ("dcg-copy-test-" + secrets.token_hex(12))
    root.mkdir()
    try:
        yield root
    finally:
        if root.exists():
            shutil.rmtree(root)


def make_source(root):
    src = root / "source"
    src.mkdir()
    (src / "node_modules").mkdir()
    (src / "package.json").write_text("{}", encoding="utf8")
    (src / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n", encoding="utf8")
    return src


def directory_link(test, target, link):
    try:
        if os.name == "nt":
            subprocess.run(["node", "-e", 'require("node:fs").symlinkSync(process.argv[1],process.argv[2],"junction")',
                            str(target), str(link)], capture_output=True, timeout=15, check=True)
        else:
            os.symlink(os.path.relpath(target, link.parent), link, target_is_directory=True)
    except (OSError, subprocess.SubprocessError):
        test.skipTest("directory link capability unavailable")


def file_link(test, target, link):
    try:
        os.symlink(os.path.relpath(target, link.parent), link)
    except OSError:
        test.skipTest("file symlink capability unavailable")


def unlink_directory_link(path):
    if hasattr(path, 'is_junction') and path.is_junction():
        path.rmdir()
    else:
        path.unlink()


class CopyTests(unittest.TestCase):
    def test_windows_trusted_root_alias_matrix_preserves_untrusted_suffix(self):
        normal = PureWindowsPath(r'C:\Users\runneradmin\AppData\Local\Temp\Runtime Fixture Long\source')
        short = PureWindowsPath(r'C:\Users\RUNNER~1\AppData\Local\Temp\RUNTIM~1\source')
        targets = [
            PureWindowsPath(r'C:\Users\runneradmin\AppData\Local\Temp\Runtime Fixture Long\source\node_modules\pkg'),
            PureWindowsPath(r'C:\Users\RUNNER~1\AppData\Local\Temp\RUNTIM~1\source\node_modules\pkg'),
            PureWindowsPath(r'C:\Users\RUNNER~1\AppData\Local\Temp\Runtime Fixture Long\source\NODE_M~1\pkg'),
        ]
        self.assertEqual(module._windows_relative_to_root(normal, short, targets[0]), ('node_modules', 'pkg'))
        self.assertEqual(module._windows_relative_to_root(normal, short, targets[1]), ('node_modules', 'pkg'))
        self.assertEqual(module._windows_relative_to_root(normal, short, targets[2]), ('NODE_M~1', 'pkg'))
        self.assertEqual(module._windows_relative_to_root(normal, None, targets[0]), ('node_modules', 'pkg'))
        self.assertIsNone(module._windows_relative_to_root(normal, None, targets[1]))
        extended = module._native_target(r'\\?\C:\Users\RUNNER~1\AppData\Local\Temp\RUNTIM~1\source\pkg', windows=True)
        self.assertEqual(module._windows_relative_to_root(normal, short, PureWindowsPath(extended)), ('pkg',))
        relative = module._windows_relative_to_root(normal, short, targets[0] / '..' / 'outside')
        self.assertEqual(relative, ('node_modules', 'pkg', '..', 'outside'))
        for target in (PureWindowsPath(r'C:\Users\RUNNER~1-extra\AppData\Local\Temp\RUNTIM~1\source\pkg'),
                       PureWindowsPath(r'D:\Users\RUNNER~1\AppData\Local\Temp\RUNTIM~1\source\pkg'),
                       PureWindowsPath(r'C:\outside\junction\source\pkg')):
            self.assertIsNone(module._windows_relative_to_root(normal, short, target))
        wrong_drive = PureWindowsPath(r'D:\Users\RUNNER~1\AppData\Local\Temp\RUNTIM~1\source')
        self.assertIsNone(module._windows_relative_to_root(normal, wrong_drive, wrong_drive / 'pkg'))
        unc = module._native_target(r'\\?\UNC\server\share\root\pkg', windows=True)
        self.assertEqual(module._windows_relative_to_root(PureWindowsPath(r'\\server\share\root'), None,
                                                         PureWindowsPath(unc)), ('pkg',))

    def test_windows_component_alias_must_resolve_to_the_scanned_entry(self):
        with directory() as root:
            long = root / 'Long Component Name'
            # Deliberately distinct from this entry's real Windows 8.3 alias.
            alias = root / 'FAKEAL~9'
            long.write_bytes(b'x')
            os.link(long, alias)
            entries = {root: {ntpath.normcase(long.name): long.name}}
            with patch.object(module, '_windows_entry_name', return_value=long.name):
                self.assertEqual(module._windows_physical_component(root, alias.name, entries), long.name)
            alias.unlink()
            alias.write_bytes(b'different')
            with patch.object(module, '_windows_entry_name', return_value=long.name):
                with self.assertRaisesRegex(ValueError, 'directory entry changed'):
                    module._windows_physical_component(root, alias.name, entries)
            with patch.object(module, '_windows_entry_name', return_value='unknown'):
                with self.assertRaisesRegex(ValueError, 'target unavailable'):
                    module._windows_physical_component(root, alias.name, entries)
            for bad in ('..\\outside', '*.json', 'C:evil'):
                with self.assertRaisesRegex(ValueError, 'target unavailable'):
                    module._windows_physical_component(root, bad, entries)

    @unittest.skipUnless(os.name == 'nt', 'Windows 8.3 and junction acceptance')
    def test_windows_actual_short_long_mixed_and_extended_junctions(self):
        with directory() as root:
            parent = root / 'Runtime Fixture Directory With Long Name'
            parent.mkdir()
            src = make_source(parent)
            target = src / 'node_modules' / 'Package Directory With Long Name' / 'Nested Module Directory'
            target.mkdir(parents=True)
            (target / 'index.js').write_text('module.exports=7', encoding='utf8')
            canonical_src = src.resolve(strict=True)
            canonical_target = target.resolve(strict=True)
            short_root = module._windows_short_root(canonical_src)
            short_target = module._windows_short_root(canonical_target)
            if short_root is None or short_target is None:
                self.skipTest('Windows short-name API unavailable')
            normal_root = PureWindowsPath(str(canonical_src))
            normal_target = PureWindowsPath(str(canonical_target))
            root_size = len(normal_root.parts)
            if (ntpath.normcase(str(short_root)) == ntpath.normcase(str(normal_root)) or
                    short_target.parts[root_size:] == normal_target.parts[root_size:]):
                self.skipTest('8.3 names unavailable on this volume')
            mixed_root = PureWindowsPath(*(short if i % 2 else long
                                           for i, (long, short) in enumerate(zip(normal_root.parts, short_root.parts))))
            normal_suffix = normal_target.parts[root_size:]
            short_suffix = short_target.parts[root_size:]
            link = src / 'node_modules' / 'matrix-junction'
            index = 0
            for source in (canonical_src, Path(str(short_root))):
                for prefix in (normal_root, short_root, mixed_root):
                    for suffix in (normal_suffix, short_suffix):
                        with self.subTest(source=str(source), prefix=str(prefix), suffix=suffix):
                            target_spelling = PureWindowsPath(*prefix.parts, *suffix)
                            directory_link(self, Path(str(target_spelling)), link)
                            raw = module._native_target(os.readlink(link))
                            self.assertEqual(ntpath.normcase(raw), ntpath.normcase(str(target_spelling)))
                            output = root / ('matrix-copy-' + str(index))
                            index += 1
                            result = module.copy_runtime(source, output)
                            self.assertEqual(result['relocated_links'], 1)
                            self.assertEqual((output / 'node_modules' / 'matrix-junction').resolve(strict=True),
                                             output / 'node_modules' / 'Package Directory With Long Name' / 'Nested Module Directory')
                            shutil.rmtree(output)
                            unlink_directory_link(link)
            extended = Path('\\\\?\\' + str(normal_target))
            directory_link(self, extended, link)
            output = root / 'extended-copy'
            self.assertEqual(module.copy_runtime(canonical_src, output)['relocated_links'], 1)
            self.assertEqual((output / 'node_modules' / 'matrix-junction').resolve(strict=True),
                             output / 'node_modules' / 'Package Directory With Long Name' / 'Nested Module Directory')

    @unittest.skipUnless(os.name == 'nt', 'Windows directory-entry no-follow acceptance')
    def test_windows_find_entry_keeps_internal_and_external_junction_identity(self):
        import ctypes
        from ctypes import wintypes
        with directory() as root:
            src = make_source(root)
            node = src / 'node_modules'
            internal = node / 'inside-target'
            external = root / 'outside-target'
            internal.mkdir(); external.mkdir()
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            get_short = kernel.GetShortPathNameW
            get_short.argtypes = (wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD)
            get_short.restype = wintypes.DWORD
            for name, target in [('Long Internal Junction Name', internal),
                                 ('Long External Junction Name', external)]:
                link = node / name
                directory_link(self, target, link)
                buffer = ctypes.create_unicode_buffer(32768)
                if not get_short(str(link), buffer, len(buffer)):
                    self.skipTest('Windows short-name API unavailable')
                alias = Path(module._native_target(buffer.value))
                if ntpath.normcase(alias.name) == ntpath.normcase(name):
                    self.skipTest('8.3 names unavailable on this volume')
                self.assertNotEqual(ntpath.normcase(alias.name), ntpath.normcase(target.name))
                self.assertEqual(module._windows_entry_name(alias), name)
                self.assertTrue(module.is_link(alias))
                entries = {node: {ntpath.normcase(name): name}}
                self.assertEqual(module._windows_physical_component(node, alias.name, entries), name)

    def test_copies_bytes_and_keeps_source_independent(self):
        with directory() as root:
            src = make_source(root)
            (src / "node_modules" / "one").write_bytes(b"source")
            result = module.copy_runtime(src, root / "copy")
            self.assertEqual(result["schema"], "dsh-warm-runtime-copy/v2")
            self.assertEqual(result["files"], 3)
            self.assertEqual(result["relocated_links"], 0)
            self.assertEqual(result["graph_equivalence"], "unverified")
            (root / "copy" / "node_modules" / "one").write_bytes(b"changed")
            self.assertEqual((src / "node_modules" / "one").read_bytes(), b"source")

    def test_shared_dag_is_copied_once_and_node_realpath_is_local(self):
        with directory() as root:
            src = make_source(root)
            store = src / "node_modules" / "store"
            target = store / "target"
            target.mkdir(parents=True)
            (target / "index.js").write_text("module.exports = { token: 17 }\n", encoding="utf8")
            for name in ("alias-a", "alias-b", "alias-c"):
                directory_link(self, target, src / "node_modules" / name)
            result = module.copy_runtime(src, root / "copy", max_files=3)
            self.assertEqual(result["files"], 3)
            self.assertEqual(result["relocated_links"], 3)
            copy = root / "copy"
            for name in ("alias-a", "alias-b", "alias-c"):
                self.assertEqual((copy / "node_modules" / name).resolve(), copy / "node_modules" / "store" / "target")
                self.assertNotEqual((copy / "node_modules" / name).resolve(), target)
            code = ('const p=require("node:path"); const f=require("node:fs");'
                    'const root=process.argv[1]; const a=require(p.join(root,"node_modules/alias-a"));'
                    'const b=require(p.join(root,"node_modules/alias-b"));'
                    'if(a!==b||a.token!==17||!f.realpathSync(require.resolve(p.join(root,"node_modules/alias-a"))).startsWith(root+p.sep))process.exit(2)')
            subprocess.run(["node", "-e", code, str(copy.resolve())], capture_output=True, timeout=15, check=True)
            shutil.rmtree(copy)
            self.assertEqual((target / "index.js").read_text(encoding="utf8"), "module.exports = { token: 17 }\n")

    def test_internal_file_links_relocated_and_digest_binds_targets(self):
        with directory() as root:
            src = make_source(root)
            node = src / "node_modules"
            (node / "one").write_bytes(b"source")
            (node / "two").write_bytes(b"source")
            file_link(self, node / "one", node / "alias")
            first = module.copy_runtime(src, root / "copy1")
            alias = root / "copy1" / "node_modules" / "alias"
            self.assertEqual(alias.resolve(), root / "copy1" / "node_modules" / "one")
            (node / "alias").unlink()
            file_link(self, node / "two", node / "alias")
            second = module.copy_runtime(src, root / "copy2")
            self.assertNotEqual(first["inventory_sha256"], second["inventory_sha256"])
            self.assertEqual(second["relocated_links"], 1)

    def test_link_chain_and_repeated_pack_are_stable(self):
        with directory() as root:
            src = make_source(root)
            node = src / "node_modules"
            target = node / "target"
            target.mkdir()
            (target / "a").write_bytes(b"x")
            directory_link(self, target, node / "alias")
            directory_link(self, node / "alias", node / "chain")
            one = module.copy_runtime(src, root / "copy1")
            two = module.copy_runtime(src, root / "copy2")
            self.assertEqual(one["inventory_sha256"], two["inventory_sha256"])
            self.assertEqual((root / "copy1" / "node_modules" / "chain").resolve(), root / "copy1" / "node_modules" / "target")
            self.assertEqual(one["relocated_links"], 2)

    def test_parent_components_after_symlink_follow_real_filesystem_order(self):
        with directory() as root:
            src = make_source(root)
            node = src / 'node_modules'
            base = node / 'base'
            deep, sibling = base / 'deep', base / 'sibling'
            deep.mkdir(parents=True)
            sibling.mkdir()
            (sibling / 'file').write_bytes(b'correct')
            directory_link(self, deep, node / 'alias')
            # `alias/..` means base, not node_modules: do not collapse '..'
            # before resolving the preceding link component.
            if os.name == 'nt':
                self.skipTest('junction creation normalizes the source target path')
            os.symlink('alias/../sibling', node / 'chain')
            self.assertEqual((node / 'chain').resolve(strict=True), sibling)
            module.copy_runtime(src, root / 'copy')
            self.assertEqual((root / 'copy' / 'node_modules' / 'chain').resolve(strict=True),
                             root / 'copy' / 'node_modules' / 'base' / 'sibling')

    def test_disjoint_and_exclusive(self):
        with directory() as root:
            src = make_source(root)
            with self.assertRaises(ValueError):
                module.copy_runtime(src, src / "inside")
            (root / "exists").mkdir()
            with self.assertRaises(ValueError):
                module.copy_runtime(src, root / "exists")
            with self.assertRaises(ValueError):
                module.copy_runtime(src, root)
            with self.assertRaises(ValueError):
                module.copy_runtime(Path("relative"), root / "copy")

    def test_source_byte_drift_retains_failed_fixture(self):
        with directory() as root:
            src = make_source(root)
            (src / "node_modules" / "one").write_bytes(b"source")
            with patch.object(module, "_stream_digest", side_effect=["a", "b"]):
                with self.assertRaisesRegex(ValueError, "changed during copy"):
                    module.copy_runtime(src, root / "copy")
            self.assertTrue((root / "copy").is_dir())
            self.assertTrue(any(p.is_file() for p in (root / "copy").rglob('*')))

    def test_source_change_after_copy_is_refused(self):
        with directory() as root:
            src = make_source(root)
            item = src / 'node_modules' / 'item'
            item.write_bytes(b'before')
            original = module.file_sha256
            def mutate_after_copy(path):
                value = original(path)
                if path.name == 'item':
                    item.write_bytes(b'after!')
                return value
            with patch.object(module, 'file_sha256', side_effect=mutate_after_copy):
                with self.assertRaisesRegex(ValueError, 'changed during copy'):
                    module.copy_runtime(src, root / 'copy')
            self.assertTrue((root / 'copy' / 'node_modules' / 'item').exists())

    def test_rejects_non_program_root_and_sensitive_names(self):
        with directory() as root:
            src = make_source(root)
            (src / "private-profile").mkdir()
            with self.assertRaises(ValueError):
                module.copy_runtime(src, root / "copy")
            self.assertFalse((root / "copy").exists())
            (src / "private-profile").rmdir()
            (src / "node_modules" / ".npmrc").write_text("synthetic", encoding="utf8")
            with self.assertRaisesRegex(ValueError, "sensitive runtime file name"):
                module.copy_runtime(src, root / "copy2")
            self.assertTrue((root / "copy2").is_dir())
            self.assertFalse((root / "copy2" / "node_modules" / ".npmrc").exists())

    def test_rejects_external_link_and_external_intermediate_hop(self):
        with directory() as root:
            src = make_source(root)
            target = src / "node_modules" / "target"
            target.mkdir()
            outside = root / "outside"
            outside.mkdir()
            directory_link(self, outside, src / "node_modules" / "escape")
            with self.assertRaisesRegex(ValueError, "escapes source"):
                module.copy_runtime(src, root / "copy1")
            unlink_directory_link(src / "node_modules" / "escape")
            directory_link(self, target, outside / "return")
            directory_link(self, outside / "return", src / "node_modules" / "escape")
            with self.assertRaisesRegex(ValueError, "escapes source"):
                module.copy_runtime(src, root / "copy2")
            self.assertTrue((root / "copy1").exists())
            self.assertTrue((root / "copy2").exists())

    def test_rejects_internal_to_external_to_internal_link_chain(self):
        with directory() as root:
            src = make_source(root)
            node = src / 'node_modules'
            target = node / 'target'
            target.mkdir()
            outside = root / 'outside'
            outside.mkdir()
            directory_link(self, target, outside / 'return')
            directory_link(self, outside / 'return', node / 'z-indirect')
            directory_link(self, node / 'z-indirect', node / 'a-outer')
            if os.name == 'nt':
                raw = module._native_target(os.readlink(node / 'a-outer'))
                self.assertEqual(ntpath.normcase(PureWindowsPath(raw).name), ntpath.normcase('z-indirect'))
            with self.assertRaisesRegex(ValueError, 'escapes source'):
                module.copy_runtime(src, root / 'copy')
            self.assertTrue((root / 'copy').is_dir())

    def test_rejects_directory_cycles_and_dangling_links(self):
        with directory() as root:
            src = make_source(root)
            node = src / "node_modules"
            child = node / "child"
            child.mkdir()
            directory_link(self, node, child / "ancestor")
            with self.assertRaisesRegex(ValueError, "directory cycle"):
                module.copy_runtime(src, root / "copy1")
            unlink_directory_link(child / "ancestor")
            if os.name == "nt":
                # Junction creation requires the target to exist on Windows.
                missing = node / "missing"
                missing.mkdir()
                directory_link(self, missing, child / "missing-link")
                missing.rmdir()
            else:
                os.symlink("missing", child / "missing-link")
            with self.assertRaisesRegex(ValueError, "target unavailable"):
                module.copy_runtime(src, root / "copy2")

    def test_file_byte_directory_link_and_resolution_budgets_fail_closed(self):
        with directory() as root:
            src = make_source(root)
            node = src / "node_modules"
            target = node / "target"
            target.mkdir()
            (target / "file").write_bytes(b"1234")
            directory_link(self, target, node / "alias")
            for name, kwargs, message in [
                ("files", {"max_files": 2}, "copy budget"),
                ("bytes", {"max_bytes": 1}, "copy budget"),
                ("directories", {"max_directories": 2}, "directory copy budget"),
                ("links", {"max_links": 0}, "link copy budget"),
                ("steps", {"max_resolution_steps": 0}, "link resolution budget"),
                ("hops", {"max_link_hops": 0}, "hop budget"),
            ]:
                with self.subTest(name=name):
                    with self.assertRaisesRegex(ValueError, message):
                        module.copy_runtime(src, root / ("copy-" + name), **kwargs)
                    self.assertTrue((root / ("copy-" + name)).is_dir())

    def test_link_creation_failure_retains_fixture_without_retry(self):
        with directory() as root:
            src = make_source(root)
            target = src / "node_modules" / "target"
            target.mkdir()
            directory_link(self, target, src / "node_modules" / "alias")
            with patch.object(module, "_create_relocated_link", side_effect=PermissionError("denied")) as create:
                with self.assertRaises(PermissionError):
                    module.copy_runtime(src, root / "copy")
            self.assertEqual(create.call_count, 1)
            self.assertTrue((root / "copy").is_dir())
            self.assertFalse((root / "copy" / "package.json").exists())
            self.assertFalse((root / "copy" / "node_modules" / "alias").exists())

    def test_link_retarget_during_copy_is_refused(self):
        with directory() as root:
            src = make_source(root)
            node = src / 'node_modules'
            first, second = node / 'first', node / 'second'
            first.mkdir(); second.mkdir()
            link = node / 'alias'
            directory_link(self, first, link)
            original = module._create_relocated_link
            def retarget_after_probe(path, mapped, is_directory):
                original(path, mapped, is_directory)
                unlink_directory_link(link)
                directory_link(self, second, link)
            with patch.object(module, '_create_relocated_link', side_effect=retarget_after_probe):
                with self.assertRaisesRegex(ValueError, 'source link changed'):
                    module.copy_runtime(src, root / 'copy')
            self.assertTrue((root / 'copy').is_dir())

    def test_changed_or_external_output_link_is_rejected(self):
        with directory() as root:
            src = make_source(root)
            target = src / "node_modules" / "target"
            target.mkdir()
            directory_link(self, target, src / "node_modules" / "alias")
            if module._uses_junctions():
                normal_batch = module._create_windows_junctions
                count = 0
                def bad_batch(pairs):
                    nonlocal count
                    count += 1
                    if count == 1:
                        normal_batch(pairs)
                    else:
                        normal_batch([(pairs[0][0], target)])
                with patch.object(module, "_create_windows_junctions", side_effect=bad_batch):
                    with self.assertRaisesRegex(ValueError, "escapes fixture"):
                        module.copy_runtime(src, root / "copy")
            else:
                normal_create = module._create_relocated_link
                count = 0
                def bad_link(path, mapped, is_directory):
                    nonlocal count
                    count += 1
                    if count == 1:
                        normal_create(path, mapped, is_directory)
                    else:
                        directory_link(self, target, path)
                with patch.object(module, "_create_relocated_link", side_effect=bad_link):
                    with self.assertRaisesRegex(ValueError, "escapes fixture"):
                        module.copy_runtime(src, root / "copy")
            self.assertTrue((root / "copy").is_dir())
            self.assertTrue(target.is_dir())

    def test_single_junction_batch_and_partial_failure_retain_fixture(self):
        with directory() as root:
            src = make_source(root)
            node = src / 'node_modules'
            target = node / 'target'
            target.mkdir()
            (target / 'index.js').write_text('module.exports=1', encoding='utf8')
            for name in ('alias1', 'alias2', 'alias3'):
                directory_link(self, target, node / name)
            original = module._create_windows_junctions
            batches = []
            def traced(pairs):
                batches.append(len(pairs))
                return original(pairs)
            with patch.object(module, '_uses_junctions', return_value=True), \
                    patch.object(module, '_create_windows_junctions', side_effect=traced):
                result = module.copy_runtime(src, root / 'copy')
            self.assertEqual(batches, [1, 3])  # one capability probe, one actual batch
            self.assertEqual(result['relocated_links'], 3)
            def fail_partway(pairs):
                if len(pairs) == 1:
                    return original(pairs)
                original(pairs[:1])
                raise module.LinkBatchError('creation_failed', 1, len(pairs))
            with patch.object(module, '_uses_junctions', return_value=True), \
                    patch.object(module, '_create_windows_junctions', side_effect=fail_partway):
                with self.assertRaises(module.LinkBatchError) as failure:
                    module.copy_runtime(src, root / 'partial')
            self.assertEqual((failure.exception.completed, failure.exception.planned), (1, 3))
            self.assertTrue((root / 'partial').is_dir())
            self.assertTrue((root / 'partial' / 'node_modules' / 'alias1').exists())
            self.assertFalse((root / 'partial' / 'node_modules' / 'alias2').exists())

    def test_junction_process_reports_partial_count_without_path_output(self):
        with directory() as root:
            target = root / 'target'
            target.mkdir()
            existing = root / 'existing'
            existing.mkdir()
            first = root / 'created'
            with self.assertRaises(module.LinkBatchError) as failure:
                module._create_windows_junctions([(first, target), (existing, target)])
            self.assertEqual((failure.exception.reason, failure.exception.completed, failure.exception.planned),
                             ('creation_failed', 1, 2))
            self.assertNotIn(str(root), str(failure.exception))
            self.assertEqual(first.resolve(strict=True), target)
            self.assertTrue(existing.is_dir())


if __name__ == "__main__":
    unittest.main()
