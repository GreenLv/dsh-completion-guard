import importlib.util
import json
import secrets
import shutil
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch
SCRIPTS=Path(__file__).resolve().parents[1]/"scripts";sys.path.insert(0,str(SCRIPTS))
spec=importlib.util.spec_from_file_location("warm_validate",SCRIPTS/"native_warm_scope_validate.py");module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
@contextmanager
def directory():
    root=Path(tempfile.gettempdir())/("dcg-validator-test-"+secrets.token_hex(12));root.mkdir()
    try:yield root
    finally:shutil.rmtree(root)
class ValidateTests(unittest.TestCase):
    def test_duplicate_keys_rejected_at_any_depth(self):
        with directory() as root:
            path=root/"result.json";path.write_text('{"a":{"x":1,"x":2}}',encoding="utf8")
            with self.assertRaises(ValueError):module.load_result(path)
    def test_subject_checks_precede_consumer(self):
        with directory() as root:
            artifact=root/"a";artifact.write_bytes(b"x");result=root/"r";result.write_text('{}',encoding='utf8')
            argv=[str(result),'--repo-root',str(root),'--artifact',str(artifact),'--source-commit','a'*40,'--artifact-sha256','b'*64,'--driver-sha256','c'*64,'--expected-platform','windows']
            result.write_text('{"platform":"windows"}',encoding='utf8')
            with patch.object(module.native,'verify_exact_source'),patch.object(module.native,'sha256',return_value='d'*64),patch.object(module.runner,'validate_result') as validate:
                self.assertEqual(module.main(argv),1);validate.assert_not_called()
    def test_platform_cannot_be_reused_as_another_native_host(self):
        with directory() as root:
            result=root/'r';result.write_text('{"platform":"windows"}',encoding='utf8')
            argv=[str(result),'--repo-root',str(root),'--artifact',str(root/'absent'),'--source-commit','a'*40,'--artifact-sha256','b'*64,'--driver-sha256','c'*64,'--expected-platform','macos']
            with patch.object(module.native,'verify_exact_source') as source,patch.object(module.runner,'validate_result') as validate:
                self.assertEqual(module.main(argv),1);source.assert_not_called();validate.assert_not_called()
if __name__=="__main__":unittest.main()
