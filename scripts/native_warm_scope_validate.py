#!/usr/bin/env python3
"""Read-only consumer for a warm-scope result and its exact inputs."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import native_acceptance as native
import native_warm_acceptance as runner
import native_warm_scope_preflight as preflight

def reject_duplicates(pairs):
    value={}
    for key,item in pairs:
        if key in value:raise ValueError("duplicate JSON key")
        value[key]=item
    return value

def load_result(path: Path):
    if path.stat().st_size>2_000_000:raise ValueError("result too large")
    with path.open("r",encoding="utf-8") as stream:
        return json.load(stream,object_pairs_hook=reject_duplicates)

def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("result",type=Path);p.add_argument("--repo-root",type=Path,required=True)
    p.add_argument("--artifact",type=Path,required=True);p.add_argument("--source-commit",required=True)
    p.add_argument("--artifact-sha256",required=True);p.add_argument("--driver-sha256",required=True)
    p.add_argument("--expected-platform",choices=("macos","windows"),required=True)
    args=p.parse_args(argv)
    try:
        result=load_result(args.result)
        if result.get("platform") != args.expected_platform:raise ValueError("platform mismatch")
        native.verify_exact_source(args.repo_root.resolve(strict=True),args.source_commit)
        if native.sha256(args.artifact.resolve(strict=True))!=args.artifact_sha256:raise ValueError("artifact mismatch")
        if preflight.driver_digest(Path(__file__).resolve().parent)!=args.driver_sha256:raise ValueError("driver mismatch")
        expected={"source_commit":args.source_commit,"artifact_sha256":args.artifact_sha256,"driver_sha256":args.driver_sha256}
        if not runner.validate_result(result,expected):raise ValueError("consumer rejected result")
    except (Exception,KeyboardInterrupt):
        print("native_warm_scope=invalid");return 1
    print("native_warm_scope=valid");return 0
if __name__=="__main__":raise SystemExit(main())
