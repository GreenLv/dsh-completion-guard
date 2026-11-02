import importlib.util
import json
import io
import sys
import tempfile
import secrets
import shutil
import re
from contextlib import contextmanager
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("warm_preflight", SCRIPTS / "native_warm_scope_preflight.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

@contextmanager
def test_directory():
    # Default ACL inheritance avoids Python 3.12 Windows mkdtemp DACL denial.
    root = Path(tempfile.gettempdir()) / ("dcg-warm-test-" + secrets.token_hex(12))
    root.mkdir()
    try:
        yield root
    finally:
        shutil.rmtree(root)

class PreflightTests(unittest.TestCase):
    def setUp(self):
        platform = patch.object(module.sys, "platform", "darwin")
        platform.start(); self.addCleanup(platform.stop)

    def test_driver_covers_local_probe_imports(self):
        bound=set(module.FILES)
        for name in module.FILES:
            if not name.endswith(".mjs"):continue
            text=(SCRIPTS/name).read_text(encoding="utf-8")
            for target in re.findall(r"(?:from\s+|import\s*\()?['\"](\./[^'\"]+\.mjs)['\"]",text):
                self.assertIn(target[2:],bound,(name,target))

    def test_unsupported_platform_fails_before_host_or_install(self):
        with test_directory() as root:
            repo=root/'repo'; runtime=root/'runtime';repo.mkdir();runtime.mkdir()
            artifact=root/'input.tgz';artifact.write_bytes(b'fixture')
            args=module.argparse.Namespace(repo_root=repo,runtime_root=runtime,artifact=artifact,source_commit='a'*40,artifact_sha256='b'*64)
            with patch.object(module.sys,'platform','linux'),patch.object(module.host,'preflight_host_inputs') as host_inputs:
                result=module.check(args)
            self.assertEqual((result['status'],result['stage']),('failed','platform'))
            host_inputs.assert_not_called()

    def test_failure_is_preserved_and_no_overwrite(self):
        with test_directory() as tmp:
            root=Path(tmp); repo=root / "repo"; runtime=root / "runtime"; repo.mkdir(); runtime.mkdir()
            output=root / "result.json"
            args=["--repo-root",str(repo),"--runtime-root",str(runtime),"--artifact",str(root / "missing.tgz"),
                  "--artifact-sha256","b"*64,"--source-commit","a"*40,"--output",str(output)]
            self.assertEqual(module.main(args),1)
            result=json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(result["status"],"failed")
            self.assertEqual(result["stage"],"identity")
            self.assertFalse(result["acceptance_executed"])
            original=output.read_bytes()
            with self.assertRaises(FileExistsError): module.main(args)
            self.assertEqual(output.read_bytes(),original)
    def test_rejects_output_in_source_or_runtime(self):
        with test_directory() as tmp:
            root=Path(tmp); repo=root / "repo"; runtime=root / "runtime"; repo.mkdir(); runtime.mkdir()
            for base in (repo,runtime):
                with self.assertRaises(ValueError): module.reserve_result(base / "out.json",repo,runtime)
    def test_artifact_read_failure_does_not_claim_acceptance(self):
        with test_directory() as tmp:
            root=Path(tmp); repo=root / "repo"; runtime=root / "runtime"; repo.mkdir(); runtime.mkdir()
            args=module.argparse.Namespace(repo_root=repo,runtime_root=runtime,artifact=root / "a",artifact_sha256="b"*64,source_commit="a"*40,web_cohort="0.2.1-rc.5",headless_cohort="0.2.1-rc.5")
            args.artifact.write_bytes(b"x")
            with patch.object(module.native,"verify_exact_source"), patch.object(module.native,"sha256",return_value="b"*64), patch.object(module.tarfile,"open",side_effect=PermissionError("sensitive path")):
                result=module.check(args)
            self.assertEqual(result["status"],"failed"); self.assertEqual(result["stage"],"artifact_manifest")
            self.assertEqual(result["failure_type"],"PermissionError"); self.assertNotIn("sensitive path",json.dumps(result))
    def test_same_invocation_child_query_failure(self):
        with test_directory() as tmp:
            root=Path(tmp); repo=root / "repo"; runtime=root / "runtime"; repo.mkdir(); runtime.mkdir()
            artifact=root / "a"; artifact.write_bytes(b"x")
            args=module.argparse.Namespace(repo_root=repo,runtime_root=runtime,artifact=artifact,artifact_sha256="b"*64,source_commit="a"*40,web_cohort="0.2.1-rc.5",headless_cohort="0.2.1-rc.5")
            member=MagicMock(); member.name="package/package.json"; member.isfile.return_value=True; member.size=10
            archive=MagicMock(); archive.getmembers.return_value=[member]; archive.getmember.return_value=member
            archive.extractfile.return_value=io.BytesIO(json.dumps({"name":"dsh-completion-guard","gitHead":"a"*40}).encode())
            with patch.object(module.native,"verify_exact_source"), patch.object(module.native,"sha256",return_value="b"*64), patch.object(module.tarfile,"open") as opened, patch.object(module.host,"preflight_host_inputs"), patch.object(module.native,"resolve_executable"), patch.object(module.host,"preflight_execution_access",side_effect=PermissionError("private")):
                opened.return_value.__enter__.return_value=archive
                result=module.check(args)
            self.assertEqual(result["status"],"failed"); self.assertEqual(result["stage"],"child_and_process_query")
            self.assertEqual(result["failure_type"],"PermissionError"); self.assertNotIn("private",json.dumps(result))
    def test_preflight_checks_consumer_after_capabilities(self):
        with test_directory() as tmp:
            root=Path(tmp); repo=root / "repo"; runtime=root / "runtime"; repo.mkdir(); runtime.mkdir()
            artifact=root / "a"; artifact.write_bytes(b"x")
            args=module.argparse.Namespace(repo_root=repo,runtime_root=runtime,artifact=artifact,artifact_sha256="b"*64,source_commit="a"*40,web_cohort="dsh-0.2.1-rc.5-core-v1",headless_cohort="dsh-0.2.1-rc.5-core-v1")
            member=MagicMock(); member.name="package/package.json"; member.isfile.return_value=True; member.size=10
            archive=MagicMock(); archive.getmembers.return_value=[member]; archive.getmember.return_value=member
            archive.extractfile.return_value=io.BytesIO(json.dumps({"name":"dsh-completion-guard","gitHead":"a"*40}).encode())
            with patch.object(module.native,"verify_exact_source"), patch.object(module.native,"sha256",return_value="b"*64), patch.object(module.tarfile,"open") as opened, patch.object(module.host,"preflight_host_inputs"), patch.object(module.native,"resolve_executable"), patch.object(module.host,"preflight_execution_access"), patch.object(module.host,"preflight_link_access"), patch.object(module.subprocess,"run",return_value=MagicMock(stdout=b"consumer-ok")):
                opened.return_value.__enter__.return_value=archive
                result=module.check(args)
            self.assertEqual(result["status"],"passed"); self.assertEqual(result["stage"],"complete")
            self.assertFalse(result["acceptance_executed"])
if __name__ == "__main__": unittest.main()
