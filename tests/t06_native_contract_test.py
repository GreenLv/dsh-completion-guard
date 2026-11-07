"""Explicit T06 variants preserve base and enforce exact native evidence."""
from __future__ import annotations
import copy, hashlib, io, json, sys, tarfile, tempfile, unittest
from pathlib import Path
from unittest import mock
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
import native_acceptance as native
import native_host_acceptance as host
import native_desktop_acceptance as desktop
import validate_native_desktop as vd
import validate_native_v070 as vh
from native_cleanup_probe import valid_t06_gate
try:
    import jsonschema
except ImportError:
    jsonschema = None

class T06Contracts(unittest.TestCase):
    def fixture(self, directory, kind, platform='macos'):
        artifact=Path(directory)/'guard.tgz';commit='a'*40;driver='b'*64
        payload=json.dumps({'name':'dsh-completion-guard','version':'0.13.0','gitHead':commit}).encode()
        with tarfile.open(artifact,'w:gz') as tar:
            member=tarfile.TarInfo('package/package.json');member.size=len(payload);tar.addfile(member,io.BytesIO(payload))
        digest=hashlib.sha256(artifact.read_bytes()).hexdigest()
        validator=vd if kind=='desktop' else vh
        locks={'desktop':'c'*64} if kind=='desktop' else {'web':'c'*64,'headless':'d'*64}
        profile='dsh-desktop-bound/v2' if kind=='desktop' else 'dsh-host-bound/v4'
        value={'schema':'native-acceptance/v2','status':'passed','product':'dsh_completion_guard','gate_profile':profile,
            'repository':{'url':'https://example.invalid/repo.git','commit':commit},'runtime_tree_sha256':None,
            'artifact':{'filename':artifact.name,'sha256':digest,'size_bytes':artifact.stat().st_size,'file_count':1,'git_head':commit},
            'platform':{'os':platform,'shell':'python-subprocess','toolchain':{'node':'v24'}},
            'gates':[native.gate(name,digest,passed=True) for name in sorted(validator.EXPECTED_GATES)],
            'cleanup':{'status':'passed','remaining_ids':[]},'run':{'started_at':'2026-01-01','finished_at':'2026-01-02'},
            'unperformed_actions':['tag','package_publish','release'],'capability_skips':['real_model_request','graphical_shell'] if kind=='desktop' else ['real_model_request'],
            'host_lock_policy':'dsh-core/v1','host_driver_sha256':driver,'host_lock_digests':locks}
        if kind=='desktop':
            value['desktop_noop_contract']=copy.deepcopy(vd.NOOP_CONTRACT)
            value['desktop_runtime']={'manifest_sha256':'f'*64,'header_sha256':'a'*64,'metadata_sha256':'b'*64,'host_version':'0.2.2-rc.1','desktop_version':'0.2.0','payload_file_count':1}
        else:value['market_interface']={'status':'not_requested'}
        note={'removalAttempts':1,'dependencyStatus':'in_use','unknownCandidateRetained':True,
              'metadataRemoved':'no' if platform=='windows' else 'yes','contentRemoved':'partial' if platform=='windows' else 'yes',
              'directoryRemoved':'no' if platform=='windows' else 'yes','commandSucceeded':platform!='windows',
              'certificate':None,'scope':'owned disposable OS fixture; not an automatic removal policy','cleanup':'passed'}
        ext=copy.deepcopy(value);ext['gate_profile']=profile+'-t06';ext['gates'].append(native.gate('t06_owned_handle_cleanup',digest,passed=True,note=json.dumps(note)))
        check=validator.valid_desktop_v2_annex if kind=='desktop' else validator.valid_v070_annex
        return artifact,commit,driver,locks,value,ext,check

    def test_profiles_and_full_gate_identity_for_each_platform(self):
        for kind in ('desktop','host'):
            for platform in ('macos','windows'):
                with self.subTest(kind=kind,platform=platform), tempfile.TemporaryDirectory() as directory:
                    artifact,commit,driver,locks,base,ext,check=self.fixture(directory,kind,platform)
                    validate=lambda obj,mode=False:check(obj,artifact,commit,driver,platform,locks,t06=mode)
                    self.assertTrue(validate(base));self.assertFalse(validate(base,True));self.assertTrue(validate(ext,True));self.assertFalse(validate(ext))
                    old_r5=copy.deepcopy(ext);old_r5['gate_profile']=base['gate_profile']
                    self.assertFalse(validate(old_r5));self.assertFalse(validate(old_r5,True))
                    def remove_base(v):v['gates'].pop(0)
                    def remove_t06(v):v['gates'].pop()
                    def duplicate(v):v['gates'].append(copy.deepcopy(v['gates'][-1]))
                    def replace_base(v):v['gates'][0]=copy.deepcopy(v['gates'][-1])
                    def extra(v):v['gates'].append(native.gate('unknown',v['artifact']['sha256'],passed=True))
                    for mutate in (remove_base,remove_t06,duplicate,replace_base,extra,
                        lambda v:v['gates'][-1].update(status='failed'),lambda v:v['gates'][-1].update(exit_code=False),
                        lambda v:v['gates'][-1].update(required=False),lambda v:v['gates'][-1].update(subject={'kind':'artifact','id':'f'*64}),
                        lambda v:v['gates'][-1].update(evidence={'mode':'borrowed'}),lambda v:v['gates'][0].update(id=[]),
                        lambda v:v['artifact'].update(git_head='f'*40),lambda v:v['cleanup'].update(status='failed')):
                        altered=copy.deepcopy(ext);mutate(altered);self.assertFalse(validate(altered,True),str(mutate))

    def test_t06_note_is_exact_strict_and_os_specific(self):
        for platform in ('macos','windows'):
            with tempfile.TemporaryDirectory() as directory:
                *_,ext,_check=self.fixture(directory,'desktop',platform);row=ext['gates'][-1];sha=ext['artifact']['sha256'];self.assertTrue(valid_t06_gate(row,sha,platform))
                for key,bad in [('removalAttempts',True),('dependencyStatus','unknown'),('unknownCandidateRetained',False),('metadataRemoved',[]),
                                ('contentRemoved','unknown'),('directoryRemoved','unknown'),('commandSucceeded',None),('certificate',{}),('scope','other'),('cleanup','failed')]:
                    changed=copy.deepcopy(row);note=json.loads(changed['note']);note[key]=bad;changed['note']=json.dumps(note)
                    self.assertFalse(valid_t06_gate(changed,sha,platform),key)
                for note in ('{}','not json','{"cleanup":"passed","cleanup":"failed"}','x'*4097):
                    changed={**row,'note':note};self.assertFalse(valid_t06_gate(changed,sha,platform))
                self.assertFalse(valid_t06_gate(row,sha,'windows' if platform=='macos' else 'macos'))

    @unittest.skipIf(jsonschema is None, 'jsonschema unavailable')
    def test_new_schemas_require_every_gate_and_reject_base_or_unbound_t06(self):
        for kind,schema_name in [('desktop','native-desktop-bound-v2-t06.schema.json'),('host','native-host-bound-v4-t06.schema.json')]:
            with tempfile.TemporaryDirectory() as directory:
                *_,base,ext,_check=self.fixture(directory,kind)
                schema=json.loads((ROOT/'schemas'/schema_name).read_text(encoding='utf-8'))
                jsonschema.Draft202012Validator.check_schema(schema);validator=jsonschema.Draft202012Validator(schema)
                self.assertTrue(validator.is_valid(ext));self.assertFalse(validator.is_valid(base))
                for mutate in (lambda v:v['gates'].pop(),lambda v:v['gates'][0].update(id=v['gates'][1]['id']),
                               lambda v:v['gates'][-1].update(id='unknown'),lambda v:v['gates'][-1].update(status='failed')):
                    changed=copy.deepcopy(ext);mutate(changed);self.assertFalse(validator.is_valid(changed))

    def test_producers_declare_selected_profile_before_failure_return(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with mock.patch.object(desktop,'desktop_driver_digest',return_value='b'*64):
                for selected in (False,True):
                    result=desktop.desktop_acceptance(None,root,root/'x','a'*64,root/'x',{'status':'failed'},'0.2.2-rc.1',root/'diag',t06=selected)
                    self.assertEqual(result['gate_profile'],'dsh-desktop-bound/v2-t06' if selected else 'dsh-desktop-bound/v2')
            for selected in (False,True):
                result=host.host_acceptance(None,root,root/'x','a'*64,root,{'status':'failed'},protocol='v070',t06=selected)
                self.assertEqual(result['gate_profile'],'dsh-host-bound/v4-t06' if selected else 'dsh-host-bound/v4')
            with self.assertRaises(ValueError):host.host_acceptance(None,root,root/'x','a'*64,root,{'status':'failed'},protocol='legacy',t06=True)

    def test_entrypoint_declares_t06_profile_and_preserves_portable_legacy_routes(self):
        from types import SimpleNamespace
        for selection in ("desktop_bound", "host_bound_v070", "portable_artifact", "host_bound"):
            with self.subTest(selection=selection), tempfile.TemporaryDirectory() as directory:
                root=Path(directory)/"repo";root.mkdir(); artifact=Path(directory)/"guard.tgz";artifact.write_bytes(b"fixture");output=Path(directory)/"out.json"
                args=["--repo-root",str(root),"--artifact",str(artifact),"--artifact-sha256","a"*64,
                      "--source-commit","b"*40,"--output",str(output),"--t06","--gate-profile",selection]
                if selection=="desktop_bound":args += ["--runtime-root",str(root),"--desktop-cohort","0.2.2-rc.1"]
                if selection in ("host_bound_v070","host_bound"):
                    args += ["--runtime-root",str(root),"--web-cohort","x","--headless-cohort","y","--web-market-version","none"]
                seen={}
                def desktop_runner(*values,**kwargs):
                    seen.update(kwargs);return {"status":"passed","gate_profile":"dsh-desktop-bound/v2-t06" if kwargs.get("t06") else "dsh-desktop-bound/v2","gates":[]}
                def host_runner(*values,**kwargs):
                    seen.update(kwargs);return {"status":"passed","gate_profile":"dsh-host-bound/v4-t06" if kwargs.get("t06") else "host_bound_core","gates":[]}
                module=SimpleNamespace(desktop_acceptance=desktop_runner,host_acceptance=host_runner)
                loader=SimpleNamespace(exec_module=lambda value:None)
                fake_spec=SimpleNamespace(loader=loader)
                portable={"status":"passed","gate_profile":"portable_artifact","gates":[]}
                with mock.patch.object(native,"preflight_inputs",return_value=module),mock.patch.object(native,"portable_acceptance",return_value=portable),mock.patch.object(native.importlib.util,"spec_from_file_location",return_value=fake_spec),mock.patch.object(native.importlib.util,"module_from_spec",return_value=SimpleNamespace(run_probe=lambda:{"cleanup":"passed"})),mock.patch('builtins.print'):
                    self.assertEqual(native.main(args),0)
                result=json.loads(output.read_text(encoding="utf-8"))
                expected={"desktop_bound":"dsh-desktop-bound/v2-t06","host_bound_v070":"dsh-host-bound/v4-t06", "portable_artifact":"portable_artifact","host_bound":"host_bound_core"}[selection]
                self.assertEqual(result["gate_profile"],expected)
                self.assertEqual([row["id"] for row in result["gates"]],["t06_owned_handle_cleanup"])
                self.assertEqual(bool(seen.get("t06")),selection in ("desktop_bound","host_bound_v070"))

    def test_t06_preflight_never_runs_acceptance_or_cleanup_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/"repo";root.mkdir();artifact=Path(directory)/"guard.tgz";artifact.write_bytes(b"fixture")
            args=["--repo-root",str(root),"--artifact",str(artifact),"--artifact-sha256","a"*64,"--source-commit","b"*40,
                  "--output",str(Path(directory)/"out.json"),"--t06","--preflight","--gate-profile","desktop_bound","--runtime-root",str(root),"--desktop-cohort","0.2.2-rc.1"]
            with mock.patch.object(native,"preflight_inputs") as preflight,mock.patch.object(native,"portable_acceptance") as run,mock.patch.object(native.importlib.util,"spec_from_file_location") as cleanup,mock.patch('builtins.print'):
                self.assertEqual(native.main(args),0);preflight.assert_called_once();run.assert_not_called();cleanup.assert_not_called()
            self.assertFalse((Path(directory)/"out.json").exists())

    def test_cli_explicit_t06_is_forwarded_to_consumer(self):
        for module,locks in [(vd,['--desktop-host-lock-digest','c'*64]),(vh,['--web-host-lock-digest','c'*64,'--headless-host-lock-digest','d'*64])]:
            with tempfile.TemporaryDirectory() as directory:
                annex=Path(directory)/'annex.json';annex.write_text('{}',encoding='utf-8')
                argv=['consumer',str(annex),'--artifact',str(Path(directory)/'x.tgz'),'--repo-root',directory,'--expected-platform','macos',*locks,'--t06']
                target='valid_desktop_v2_annex' if module is vd else 'valid_v070_annex'
                digest='desktop_driver_digest' if module is vd else 'probe_driver_digest'
                with mock.patch.object(sys,'argv',argv),mock.patch.object(module.subprocess,'check_output',side_effect=['a'*40,'']),mock.patch.object(module,digest,return_value='b'*64),mock.patch.object(module,target,return_value=True) as check,mock.patch('builtins.print'):
                    self.assertEqual(module.main(),0);self.assertIs(check.call_args.kwargs['t06'],True)

if __name__=='__main__':unittest.main()
