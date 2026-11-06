import importlib.util
import json
import sys
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/"scripts"))
import native_warm_acceptance as runner
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
    def test_schema_and_consumer_agree_on_complete_and_missing_stage(self):
        schema=json.loads((ROOT/'schemas'/'native-warm-scope-v1.schema.json').read_text(encoding='utf8'))
        jsonschema.Draft202012Validator.check_schema(schema)
        expected={'source_commit':'a'*40,'artifact_sha256':'b'*64,'driver_sha256':'c'*64}
        result={'schema':'dsh-native-warm-scope/v1','status':'passed',**expected,'platform':'windows','host':{'version':'0.2.2-rc.1','node_version':'v24.18.0','runtime_sha256':'e'*64,'node_sha256':'f'*64},'profiles':{'web':profile(101),'headless':profile(201)},'cleanup':{'status':'passed','remaining_ids':[]}}
        jsonschema.validate(result,schema);self.assertTrue(runner.validate_result(result,expected))
        for version in ('0.2.0-rc.2', '0.2.1-rc.3', '0.2.1-rc.5', '0.2.1', '0.2.2-rc.0', '0.2.2-rc.2'):
            result['host']['version']=version
            with self.assertRaises(jsonschema.ValidationError):jsonschema.validate(result,schema)
            self.assertFalse(runner.validate_result(result,expected))
        result['host']['version']='0.2.2-rc.1'
        result['profiles']['web']['steps'].pop()
        with self.assertRaises(jsonschema.ValidationError):jsonschema.validate(result,schema)
        self.assertFalse(runner.validate_result(result,expected))
if __name__=='__main__':unittest.main()
