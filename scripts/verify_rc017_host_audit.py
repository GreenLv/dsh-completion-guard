#!/usr/bin/env python3
"""Recheck the rc.2 audit against downloaded published tarballs (no installation)."""
from __future__ import annotations
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request


def verify(row: dict, payload: bytes) -> int:
    if hashlib.sha256(payload).hexdigest() != row['sha256']:
        raise ValueError(f"{row['name']}: tarball SHA-256 mismatch")
    integrity = 'sha512-' + base64.b64encode(hashlib.sha512(payload).digest()).decode()
    if integrity != row['integrity']:
        raise ValueError(f"{row['name']}: registry SRI mismatch")
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
        measured = {}
        for member in archive.getmembers():
            if not member.isfile() or not member.name.startswith('package/'):
                continue
            name = member.name.removeprefix('package/')
            if name == 'package.json' or (name.startswith('lib/') and name.endswith(('.js', '.cjs', '.mjs'))):
                if name in measured:
                    raise ValueError(f"{row['name']}: duplicate module {name}")
                measured[name] = hashlib.sha256(archive.extractfile(member).read()).hexdigest()
        if measured != row['modules']:
            raise ValueError(f"{row['name']}: module inventory or byte mismatch")
    return len(measured)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tarball-dir', type=Path, help='Each package basename contains input.tgz; omit to download exact recorded URLs')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    audit = json.loads((root / 'manifests/rc017-rc2-byte-audit.json').read_text())
    count = 0
    for row in audit['packages']:
        if args.tarball_dir:
            payload = (args.tarball_dir / row['name'].split('/')[-1] / 'input.tgz').read_bytes()
        else:
            with urllib.request.urlopen(row['tarball'], timeout=30) as response:
                payload = response.read()
        count += verify(row, payload)
    print(json.dumps({'status':'passed', 'packages':len(audit['packages']), 'module_and_manifest_files':count}))


if __name__ == '__main__':
    main()
