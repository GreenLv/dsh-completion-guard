import importlib.util
import io
import json
import secrets
import shutil
import sys
import tarfile
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch, MagicMock
SCRIPTS=Path(__file__).resolve().parents[1]/"scripts";sys.path.insert(0,str(SCRIPTS))
spec=importlib.util.spec_from_file_location("warm_runner",SCRIPTS/"native_warm_acceptance.py")
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
@contextmanager
def directory():
    root=Path(tempfile.gettempdir())/("dcg-runner-test-"+secrets.token_hex(12));root.mkdir()
    try:yield root
    finally:shutil.rmtree(root)
class RunnerTests(unittest.TestCase):
    def test_inert_fixture_only_and_unpack(self):
        with directory() as root:
            artifact=root/"inert.tgz";sri=module.inert_fixture(artifact)
            self.assertTrue(sri.startswith("sha512-"));unpacked=module.unpack_frozen(artifact,root/"extract")
            manifest=json.loads((unpacked/"package.json").read_text(encoding="utf8"))
            self.assertEqual(manifest["name"],module.FIXTURE_NAME);self.assertEqual(manifest["gitHead"],module.FIXTURE_HEAD)
    def test_rejects_tar_links_before_writing_link(self):
        with directory() as root:
            artifact=root/"bad.tgz"
            with tarfile.open(artifact,"w:gz") as tar:
                member=tarfile.TarInfo("package/escape");member.type=tarfile.SYMTYPE;member.linkname="../../outside";tar.addfile(member)
            with self.assertRaises(ValueError):module.unpack_frozen(artifact,root/"extract")
            self.assertFalse((root/"outside").exists())
    def test_composition_requires_one_disabled_original_and_one_active_wrapper(self):
        wrapper=Path(__file__).resolve();uri=wrapper.as_uri()
        original="- id: context-guard\n  name: dsh-completion-guard\n  disabled: true\n"
        active="- id: warm-guard-wrapper\n  name: >-\n    "+uri+"\n  config: {}\n"
        view=module.validate_composition(original+active,wrapper)
        self.assertTrue(view.startswith("- id: context-guard\n"))
        for value in (original+active+active,original+active+"- id: context-guard\n  config: {}\n",original+active+"- id: warm-guard-wrapper\n  config: {}\n",original.replace("disabled: true","disabled: false")+active,original+active.replace(uri,"file:///other"),active):
            with self.assertRaises(ValueError):module.validate_composition(value,wrapper)
    def test_failed_copy_retains_fixture_and_result(self):
        with directory() as root:
            repo=root/"repo";repo.mkdir();runtime=root/"runtime";runtime.mkdir();artifact=root/"guard.tgz";artifact.write_bytes(b"x");fixture=root/"fixture";fixture.mkdir()
            args=module.argparse.Namespace(repo_root=repo,runtime_root=runtime,artifact=artifact,source_commit="a"*40,artifact_sha256="b"*64,output=root/"result.json",web_cohort="x",headless_cohort="x")
            def fail_copy(source,dest):dest.mkdir();raise PermissionError("private")
            with patch.object(module.host,"host_temporary_root",return_value=fixture),patch.object(module.tempfile,"gettempdir",return_value=str(root)),patch.object(module.native,"sha256",return_value="b"*64),patch.object(module.copier,"copy_runtime",side_effect=fail_copy):
                result=module.execute(args,"c"*64,root/"progress")
            self.assertEqual(result["status"],"failed");self.assertEqual(result["failure"]["stage"],"runtime_copy")
            self.assertEqual(result["cleanup"]["status"],"failed");self.assertTrue((fixture/"runtime").exists());self.assertTrue(Path(str(args.output)+".recovery.json").exists())
            self.assertNotIn("private",json.dumps(result))
    def test_timed_out_host_preserves_fixture_and_marks_unknown(self):
        with directory() as root:
            repo=root/"repo";repo.mkdir();runtime=root/"runtime";runtime.mkdir();artifact=root/"guard.tgz";artifact.write_bytes(b"x");fixture=root/"fixture";fixture.mkdir()
            args=module.argparse.Namespace(repo_root=repo,runtime_root=runtime,artifact=artifact,source_commit="a"*40,artifact_sha256="b"*64,output=root/"result.json",web_cohort="x",headless_cohort="x")
            selected={name:{"id":"x","packages":[]} for name in ("web","headless")}
            def copy(_src,dest):dest.mkdir();return {"inventory_sha256":"e"*64}
            def unpack(_artifact,dest):dest.mkdir();p=dest/"package";p.mkdir();return p
            def cmd(_work,_env,*args):
                if "--version" in args:return "v24.18.0"
                if "inspect-graph" in args:return json.dumps({"packages":[]})
                if "inject" in args:return json.dumps({"status":"supported","cohort_id":"x","host_lock_digest":"d"*64})
                return ""
            process=MagicMock();process.pid=123;process.poll.return_value=None
            with patch.object(module.host,"host_temporary_root",return_value=fixture),patch.object(module.tempfile,"gettempdir",return_value=str(root)),patch.object(module.native,"sha256",return_value="b"*64),patch.object(module.copier,"copy_runtime",side_effect=copy),patch.object(module.host,"isolated_environment",return_value={}),patch.object(module.native,"resolve_executable",return_value=shutil.which("node")),patch.object(module.host,"preflight_host_inputs",return_value=({"version":"0.2.1-rc.5"},selected)),patch.object(module,"unpack_frozen",side_effect=unpack),patch.object(module.native,"tree_digest",return_value="same"),patch.object(module.host,"run_host_command",side_effect=cmd),patch.object(module.host,"verify_target_graph"),patch.object(module,"validate_composition",return_value="view"),patch.object(module.host,"free_loopback_port",return_value=65534),patch.object(module.subprocess,"Popen",return_value=process),patch.object(module.host,"wait_until",side_effect=module.host.HostProbeDeadline("timeout")),patch.object(module.host,"cleanup_owned_processes",return_value=[]),patch.object(module.host,"discover_owned_hosts",return_value={}):
                result=module.execute(args,"c"*64,root/"progress")
            self.assertEqual(result["status"],"failed");self.assertIn("child_state_unknown",result["cleanup"]["remaining_ids"])
            self.assertTrue(fixture.exists());self.assertTrue(Path(str(args.output)+".recovery.json").exists())
    def test_simulated_two_profile_producer_and_consumer_gate(self):
        from tests.test_native_warm_schema import profile as evidence_profile
        for corrupt in (False,True):
            with self.subTest(corrupt=corrupt), directory() as root:
                repo=root/"repo";repo.mkdir();runtime=root/"runtime";runtime.mkdir();artifact=root/"guard.tgz";artifact.write_bytes(b"x");fixture=root/"fixture";fixture.mkdir()
                args=module.argparse.Namespace(repo_root=repo,runtime_root=runtime,artifact=artifact,source_commit="a"*40,artifact_sha256="b"*64,output=root/"result.json",web_cohort="x",headless_cohort="x")
                selected={name:{"id":"x","packages":[]} for name in ("web","headless")};current={}
                def copy(_src,dest):dest.mkdir();return {"inventory_sha256":"e"*64}
                def unpack(_artifact,dest):dest.mkdir();p=dest/"package";p.mkdir();return p
                def cmd(_work,_env,*values):
                    if "--version" in values:return "v24.18.0"
                    if "inspect-graph" in values:return json.dumps({"packages":[]})
                    if "inject" in values:return json.dumps({"status":"supported","cohort_id":"x","host_lock_digest":"d"*64})
                    return ""
                def popen(argv,**kwargs):
                    patch_path=Path(argv[argv.index("--patch")+1]);overlay=json.loads(patch_path.read_text(encoding="utf8"))
                    config=next(entry['insert'][0]['config'] for entry in overlay if 'insert' in entry and entry['insert'][0]['id']=='native-guard-probe')
                    pid=101 if config['profile']=='web' else 201;current.update(config=config,pid=pid)
                    process=MagicMock();process.pid=pid;return process
                def wait(_callback,timeout):
                    if timeout!=900:return True
                    c=current['config'];pid=current['pid'];row=evidence_profile(pid);steps=row['steps']
                    if corrupt and c['profile']=='headless':steps.pop()
                    return {'schema':'dsh-native-warm-probe/v1','status':'passed','cleanup':'passed','nonce':c['nonce'],'profile':c['profile'],'pid':pid,'source_commit':c['sourceCommit'],'artifact_sha256':c['artifactSha256'],'driver_sha256':c['driverSha256'],'host_lock_digest':c['hostLockDigest'],'steps':steps}
                with patch.object(module.host,"host_temporary_root",return_value=fixture),patch.object(module.tempfile,"gettempdir",return_value=str(root)),patch.object(module.native,"sha256",return_value="b"*64),patch.object(module.copier,"copy_runtime",side_effect=copy),patch.object(module.host,"isolated_environment",return_value={}),patch.object(module.native,"resolve_executable",return_value=shutil.which("node")),patch.object(module.host,"preflight_host_inputs",return_value=({"version":"0.2.1-rc.5"},selected)),patch.object(module,"unpack_frozen",side_effect=unpack),patch.object(module.native,"tree_digest",return_value="same"),patch.object(module.host,"run_host_command",side_effect=cmd),patch.object(module.host,"verify_target_graph"),patch.object(module,"validate_composition",return_value="view"),patch.object(module.host,"free_loopback_port",return_value=65534),patch.object(module.subprocess,"Popen",side_effect=popen),patch.object(module.host,"wait_until",side_effect=wait),patch.object(module.host,"cleanup_owned_processes",return_value=[]),patch.object(module.host,"discover_owned_hosts",return_value={}):
                    # Isolate runner branching; the real consumer is tested separately.
                    with patch.object(module,"validate_result",side_effect=lambda result,expected: not corrupt):
                        result=module.execute(args,"c"*64,root/"progress")
                self.assertEqual(result['status'],'failed' if corrupt else 'passed')
                self.assertEqual(fixture.exists(),corrupt)
    def test_interruption_and_atomic_replace_preserve_result(self):
        with directory() as root:
            repo=root/"repo";repo.mkdir();runtime=root/"runtime";runtime.mkdir();artifact=root/"a";artifact.write_bytes(b"x")
            def argv(output):return ["--repo-root",str(repo),"--runtime-root",str(runtime),"--artifact",str(artifact),"--source-commit","a"*40,"--artifact-sha256","b"*64,"--driver-sha256","c"*64,"--output",str(output),"--preflight"]
            out=root/"interrupt.json"
            with patch.object(module.preflight,"check",side_effect=KeyboardInterrupt):self.assertEqual(module.main(argv(out)),1)
            self.assertEqual(json.loads(out.read_text(encoding="utf8"))["failure_type"],"KeyboardInterrupt")
            out2=root/"replace.json"
            with patch.object(module.preflight,"check",return_value={"status":"failed","driver_sha256":"c"*64}),patch.object(module.os,"replace",side_effect=PermissionError):
                with self.assertRaises(PermissionError):module.main(argv(out2))
            self.assertEqual(json.loads(out2.read_text(encoding="utf8"))["status"],"started")
            self.assertEqual(json.loads(Path(str(out2)+".pending").read_text(encoding="utf8"))["status"],"failed")
    def test_cleanup_rejects_fixture_outside_temp_parent(self):
        with directory() as root:
            fixture=root/"fixture";fixture.mkdir();other=root/"other";other.mkdir()
            with patch.object(module.tempfile,"gettempdir",return_value=str(other)):
                with self.assertRaises(ValueError):module.safe_remove_fixture(fixture)
            self.assertTrue(fixture.exists())
    def test_final_consumer_rejects_missing_evidence(self):
        self.assertFalse(module.validate_result({"schema":"dsh-native-warm-scope/v1","status":"passed"},{"source_commit":"a"*40,"artifact_sha256":"b"*64,"driver_sha256":"c"*64}))
if __name__=="__main__":unittest.main()
