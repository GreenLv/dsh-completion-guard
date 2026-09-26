"""Tarball integrity and complete executable inventory are separate gates."""
import base64
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import unittest

spec = importlib.util.spec_from_file_location('rc017_audit', Path(__file__).parents[1] / 'scripts/verify_rc017_host_audit.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def fixture(extra=False):
    files = {'package.json': b'{"name":"fixture"}', 'lib/index.js': b'export const ok=true', 'lib/worker.cjs': b'module.exports=1'}
    target = io.BytesIO()
    with tarfile.open(fileobj=target, mode='w:gz') as archive:
        for name, content in files.items():
            header = tarfile.TarInfo('package/' + name)
            header.size = len(content)
            archive.addfile(header, io.BytesIO(content))
        if extra:
            header = tarfile.TarInfo('package/lib/hidden.js')
            header.size = 1
            archive.addfile(header, io.BytesIO(b'x'))
    payload = target.getvalue()
    row = {'name':'fixture', 'sha256':hashlib.sha256(payload).hexdigest(), 'integrity':'sha512-'+base64.b64encode(hashlib.sha512(payload).digest()).decode(), 'modules':{k:hashlib.sha256(v).hexdigest() for k,v in files.items()}}
    return row, payload


class Rc017AuditTests(unittest.TestCase):
    def test_accepts_manifest_javascript_and_commonjs_bytes(self):
        self.assertEqual(audit.verify(*fixture()), 3)

    def test_rejects_tampered_payload_even_if_one_digest_is_updated(self):
        row, payload = fixture()
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            audit.verify(row, payload + b'changed')
        row['sha256'] = hashlib.sha256(payload + b'changed').hexdigest()
        with self.assertRaisesRegex(ValueError, 'SRI'):
            audit.verify(row, payload + b'changed')

    def test_rejects_unlisted_executable_even_with_valid_tarball_digests(self):
        with self.assertRaisesRegex(ValueError, 'inventory'):
            audit.verify(*fixture(extra=True))

    def test_rejects_changed_manifest_digest(self):
        row, payload = fixture()
        row['modules']['package.json'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'byte mismatch'):
            audit.verify(row, payload)
