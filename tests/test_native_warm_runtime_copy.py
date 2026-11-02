import importlib.util
import os
import secrets
import shutil
import subprocess
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch
SCRIPTS=Path(__file__).resolve().parents[1]/"scripts"
spec=importlib.util.spec_from_file_location("warm_copy",SCRIPTS/"native_warm_runtime_copy.py")
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
@contextmanager
def directory():
    root=Path(tempfile.gettempdir())/("dcg-copy-test-"+secrets.token_hex(12));root.mkdir()
    try:yield root
    finally:shutil.rmtree(root)
def make_source(root):
    src=root/"source";src.mkdir();(src/"node_modules").mkdir()
    (src/"package.json").write_text("{}",encoding="utf8")
    (src/"pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n",encoding="utf8")
    return src
class CopyTests(unittest.TestCase):
    def test_copies_bytes_and_keeps_source_independent(self):
        with directory() as root:
            src=make_source(root);(src/"node_modules"/"one").write_bytes(b"source")
            result=module.copy_runtime(src,root/"copy")
            self.assertEqual(result["files"],3);self.assertEqual(result["graph_equivalence"],"unverified")
            (root/"copy"/"node_modules"/"one").write_bytes(b"changed");self.assertEqual((src/"node_modules"/"one").read_bytes(),b"source")
    def test_disjoint_and_exclusive(self):
        with directory() as root:
            src=make_source(root);(src/"node_modules"/"one").write_bytes(b"source")
            with self.assertRaises(ValueError):module.copy_runtime(src,src/"inside")
            (root/"exists").mkdir()
            with self.assertRaises(ValueError):module.copy_runtime(src,root/"exists")
    def test_source_byte_drift_retains_failed_fixture(self):
        with directory() as root:
            src=make_source(root);(src/"node_modules"/"one").write_bytes(b"source")
            with patch.object(module,"file_sha256",side_effect=["a","b"]):
                with self.assertRaises(ValueError):module.copy_runtime(src,root/"copy")
            self.assertTrue((root/"copy"/"node_modules"/"one").exists())
    def test_directory_junction_internal_and_external(self):
        with directory() as root:
            src=make_source(root);target=src/"node_modules"/"target";target.mkdir();(target/"one").write_bytes(b"source")
            external=root/"outside";external.mkdir()
            code='require("node:fs").symlinkSync(process.argv[1],process.argv[2],"junction")'
            try:subprocess.run(['node','-e',code,str(target),str(src/"node_modules"/"alias")],capture_output=True,timeout=15,check=True)
            except (OSError,subprocess.SubprocessError):self.skipTest("directory junction capability unavailable")
            result=module.copy_runtime(src,root/"copy")
            self.assertEqual(result["materialized_links"],1);self.assertEqual((root/"copy"/"node_modules"/"alias"/"one").read_bytes(),b"source")
            self.assertFalse((root/"copy"/"node_modules"/"alias").is_symlink())
            subprocess.run(['node','-e',code,str(external),str(src/"node_modules"/"escape")],capture_output=True,timeout=15,check=True)
            with self.assertRaises(ValueError):module.copy_runtime(src,root/"copy2")
    def test_rejects_non_program_root_and_sensitive_names(self):
        with directory() as root:
            src=make_source(root);(src/"private-profile").mkdir()
            with self.assertRaises(ValueError):module.copy_runtime(src,root/"copy")
            self.assertFalse((root/"copy").exists());(src/"private-profile").rmdir()
            (src/"node_modules"/".npmrc").write_text("synthetic",encoding="utf8")
            with self.assertRaises(ValueError):module.copy_runtime(src,root/"copy2")
            self.assertFalse((root/"copy2"/"node_modules"/".npmrc").exists())
    def test_external_link_refused_internal_materialized(self):
        with directory() as root:
            src=make_source(root);(src/"node_modules"/"one").write_bytes(b"source");(root/"external").write_bytes(b"external")
            try:os.symlink(src/"node_modules"/"one",src/"node_modules"/"alias")
            except OSError:self.skipTest("symlink capability unavailable")
            result=module.copy_runtime(src,root/"copy")
            self.assertEqual(result["materialized_links"],1);self.assertFalse((root/"copy"/"node_modules"/"alias").is_symlink())
            os.symlink(root/"external",src/"node_modules"/"escape")
            with self.assertRaises(ValueError):module.copy_runtime(src,root/"copy2")
            self.assertTrue((root/"copy2").exists())
if __name__=="__main__":unittest.main()
