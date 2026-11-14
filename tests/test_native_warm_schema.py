import importlib.util
import json
import sys
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/"scripts"))
import native_warm_acceptance as runner
import native_warm_scope_preflight as preflight
try: import jsonschema
except ImportError: jsonschema=None

def profile(pid):
    steps=[{'stage':'warm','status':'passed','resident_pid':pid,'oracle_pid':pid+10},
           {'stage':'baseline','status':'completed','effect_count':1,'reason_code':'action_completed','audit_before':1,'audit_after':2,'lock_status':'supported','lock_reason':None}]
    for index,mode in enumerate(('redirect','deny')):
        ticket=('a' if index==0 else 'b')*24;count=index+1
        steps.extend([{'stage':mode+'_prepared','status':'passed','ticket_id':ticket,'effect_count':count},
          {'stage':mode+'_oracle','status':'passed','oracle_pid':pid+11+index,'kind':mode},
          {'stage':mode,'status':'unavailable','effect_count':count,'ticket_id':ticket,'audit_before':2+index*2,'audit_after':3+index*2,'reason_code':'host_capability_unavailable','lock_status':'unsupported','lock_reason':'host_lock_installed_graph_drift'},
          {'stage':mode+'_restored','status':'completed','effect_count':count+1,'ticket_id':ticket,'audit_before':3+index*2,'audit_after':4+index*2,'reason_code':'action_completed','lock_status':'supported','lock_reason':None}])
    return {'pid':pid,'host_lock_digest':'d'*64,'steps':steps}

class SchemaTests(unittest.TestCase):
    @unittest.skipIf(jsonschema is None,'jsonschema unavailable')
    def test_current_package_cohort_defaults_schema_and_consumer_remain_aligned(self):
        package=json.loads((ROOT/'package.json').read_text(encoding='utf8'))
        manifest=json.loads((ROOT/'manifests'/'supported-host.v1.json').read_text(encoding='utf8'))
        self.assertEqual(len(manifest['cohorts']),1)
        cohort=manifest['cohorts'][0]
        versions=[row['version'] for row in cohort['packages'] if row['name']=='@deepseek-ai/dsh']
        self.assertEqual(len(versions),1)
        version=versions[0]
        self.assertEqual(package['engines']['dsh'],'>='+version)
        self.assertEqual(package['dsh']['engines']['dsh'],'>='+version)
        base=['--repo-root','.', '--runtime-root','.', '--artifact','x', '--source-commit','a'*40,
              '--artifact-sha256','b'*64, '--output','x']
        for parser, args in [(preflight.argument_parser(),base), (runner.argument_parser(),base+['--driver-sha256','c'*64])]:
            selected=parser.parse_args(args)
            self.assertEqual((selected.web_cohort,selected.headless_cohort),(cohort['id'],cohort['id']))
        schema=json.loads((ROOT/'schemas'/'native-warm-scope-v1.schema.json').read_text(encoding='utf8'))
        controls=preflight.consumer_controls(version,'a'*40,'b'*64,'c'*64)
        jsonschema.validate(controls['valid'],schema)
        self.assertTrue(runner.validate_result(controls['valid'],controls['expected']))
        for invalid in controls['refusals']:
            self.assertFalse(runner.validate_result(invalid,controls['expected']))
        old=next(row['version'] for row in manifest['historicalCohorts'][0]['packages'] if row['name']=='@deepseek-ai/dsh')
        self.assertNotEqual(version,old)
        controls['valid']['host']['version']=old
        with self.assertRaises(jsonschema.ValidationError):jsonschema.validate(controls['valid'],schema)
        self.assertFalse(runner.validate_result(controls['valid'],controls['expected']))

    @unittest.skipIf(jsonschema is None,'jsonschema unavailable')
    def test_schema_and_consumer_agree_on_complete_and_missing_stage(self):
        schema=json.loads((ROOT/'schemas'/'native-warm-scope-v1.schema.json').read_text(encoding='utf8'))
        jsonschema.Draft202012Validator.check_schema(schema)
        expected={'source_commit':'a'*40,'artifact_sha256':'b'*64,'driver_sha256':'c'*64}
        result={'schema':'dsh-native-warm-scope/v1','status':'passed',**expected,'platform':'windows','host':{'version':'0.2.2-rc.3','node_version':'v24.18.0','runtime_sha256':'e'*64,'node_sha256':'f'*64},'profiles':{'web':profile(101),'headless':profile(201)},'cleanup':{'status':'passed','remaining_ids':[]}}
        jsonschema.validate(result,schema);self.assertTrue(runner.validate_result(result,expected))
        for version in ('0.2.0-rc.2', '0.2.1-rc.3', '0.2.1-rc.5', '0.2.1', '0.2.2-rc.0', '0.2.2-rc.1', '0.2.2-rc.2', '0.2.2'):
            result['host']['version']=version
            with self.assertRaises(jsonschema.ValidationError):jsonschema.validate(result,schema)
            self.assertFalse(runner.validate_result(result,expected))
        result['host']['version']='0.2.2-rc.3'
        result['host']['node_version']=''
        with self.assertRaises(jsonschema.ValidationError):jsonschema.validate(result,schema)
        self.assertFalse(runner.validate_result(result,expected))
        result['host']['node_version']='v24.18.0'
        result['profiles']['web']['steps'].pop()
        with self.assertRaises(jsonschema.ValidationError):jsonschema.validate(result,schema)
        self.assertFalse(runner.validate_result(result,expected))
if __name__=='__main__':unittest.main()
