"""Read-only preflight producer for the warm-scope native runner.

This is not an execution entrypoint or acceptance result.  It preserves a
redacted failure record even when a same-invocation capability check fails.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
from pathlib import Path
import native_acceptance as native
import native_host_acceptance as host

FILES = ("native_acceptance.py", "native_host_acceptance.py", "native_host_probe.mjs",
         "native_warm_acceptance.py", "native_warm_guard_adapter.mjs", "native_warm_guard_plugin.mjs",
         "native_warm_host_probe.mjs", "native_warm_runtime_copy.py", "native_warm_scope_consumer.mjs",
         "native_warm_scope_core.mjs",
         "native_warm_scope_preflight.py", "native_warm_scope_validate.py", "../schemas/native-warm-scope-v1.schema.json")

def driver_digest(scripts: Path) -> str:
    digest = hashlib.sha256(b"dsh.native-warm-scope-preparation/v1\n")
    for name in FILES:
        path = scripts / name
        if path.is_symlink() or not path.is_file():
            raise RuntimeError("driver input unavailable")
        digest.update(name.encode("ascii") + b"\0" + hashlib.sha256(path.read_bytes()).hexdigest().encode("ascii") + b"\n")
    return digest.hexdigest()

def consumer_controls(host_version: str, source_commit: str, artifact_sha256: str, driver_sha256: str) -> dict:
    """Synthetic control rows exercise the result consumer, never a host run."""
    expected = {"source_commit": source_commit, "artifact_sha256": artifact_sha256, "driver_sha256": driver_sha256}
    def profile(pid: int) -> dict:
        rows = [
            {"stage": "warm", "status": "passed", "resident_pid": pid, "oracle_pid": pid + 10},
            {"stage": "baseline", "status": "completed", "effect_count": 1, "reason_code": "action_completed",
             "audit_before": 1, "audit_after": 2, "lock_status": "supported", "lock_reason": None},
        ]
        for index, mode in enumerate(("redirect", "deny")):
            ticket, count = ("a" if index == 0 else "b") * 24, index + 1
            rows.extend([
                {"stage": mode + "_prepared", "status": "passed", "ticket_id": ticket, "effect_count": count},
                {"stage": mode + "_oracle", "status": "passed", "oracle_pid": pid + 11 + index, "kind": mode},
                {"stage": mode, "status": "unavailable", "effect_count": count, "ticket_id": ticket,
                 "audit_before": 2 + index * 2, "audit_after": 3 + index * 2, "reason_code": "host_capability_unavailable",
                 "lock_status": "unsupported", "lock_reason": "host_lock_installed_graph_drift"},
                {"stage": mode + "_restored", "status": "completed", "effect_count": count + 1, "ticket_id": ticket,
                 "audit_before": 3 + index * 2, "audit_after": 4 + index * 2, "reason_code": "action_completed",
                 "lock_status": "supported", "lock_reason": None},
            ])
        return {"pid": pid, "host_lock_digest": "d" * 64, "steps": rows}
    valid = {"schema": "dsh-native-warm-scope/v1", "status": "passed", **expected,
             "platform": "windows" if sys.platform == "win32" else "macos",
             "host": {"version": host_version, "node_version": "v24.9.0", "runtime_sha256": "e" * 64, "node_sha256": "f" * 64},
             "profiles": {"web": profile(101), "headless": profile(201)}, "cleanup": {"status": "passed", "remaining_ids": []}}
    missing, leaked, old = (copy.deepcopy(valid) for _ in range(3))
    missing["profiles"]["web"]["steps"].pop()
    leaked["profiles"]["headless"]["steps"][4]["effect_count"] += 1
    old["host"]["version"] = "0.2.2-rc.2"
    return {"expected": expected, "valid": valid, "refusals": [missing, leaked, old]}

def verify_consumer(consumer: Path, controls: dict) -> None:
    if not consumer.is_file():
        raise ValueError("consumer unavailable")
    code = "import {pathToFileURL} from 'node:url';let s='';for await(const c of process.stdin)s+=c;const x=JSON.parse(s),m=await import(pathToFileURL(process.argv[1]).href);if(typeof m.validateWarmResult!=='function'||!m.validateWarmResult(x.valid,x.expected)||x.refusals.length!==3||x.refusals.some(r=>m.validateWarmResult(r,x.expected)))process.exit(2);process.stdout.write('consumer-ok')"
    checked = subprocess.run([native.resolve_executable("node"),"--input-type=module","-e",code,str(consumer)],input=json.dumps(controls).encode(),capture_output=True,timeout=15,check=True)
    if checked.stdout != b"consumer-ok":
        raise RuntimeError("consumer capability mismatch")

def check(args: argparse.Namespace) -> dict:
    result = {"schema": "dsh-native-warm-preflight/v1", "status": "failed",
              "source_commit": args.source_commit, "artifact_sha256": args.artifact_sha256,
              "driver_sha256": None, "stage": "initial", "failure_type": None,
              "acceptance_executed": False}
    try:
        result["stage"] = "identity"
        if not re.fullmatch(r"[0-9a-f]{40}", args.source_commit) or not re.fullmatch(r"[0-9a-f]{64}", args.artifact_sha256):
            raise ValueError("invalid expected identity")
        root = args.repo_root.resolve(strict=True)
        runtime = args.runtime_root.resolve(strict=True)
        artifact = args.artifact.resolve(strict=True)
        if not runtime.is_dir() or not artifact.is_file():
            raise ValueError("required inputs missing")
        result["stage"] = "platform"
        if sys.platform not in ("darwin", "win32"):
            raise ValueError("native warm acceptance requires macOS or Windows")
        result["stage"] = "identity"
        result["driver_sha256"] = driver_digest(Path(__file__).resolve().parent)
        native.verify_exact_source(root, args.source_commit)
        if native.sha256(artifact) != args.artifact_sha256:
            raise ValueError("artifact identity mismatch")
        result["stage"] = "artifact_manifest"
        with tarfile.open(artifact, "r:gz") as archive:
            members = archive.getmembers()
            native.safe_tar_entries("\n".join(x.name for x in members))
            if any(not (member.isfile() or member.isdir()) for member in members):
                raise ValueError("unsupported artifact entry")
            member = archive.getmember("package/package.json")
            if not member.isfile() or member.size > 1024 * 1024:
                raise ValueError("bad package manifest")
            with archive.extractfile(member) as stream:
                manifest = json.load(stream)
            if manifest.get("name") != "dsh-completion-guard" or manifest.get("gitHead") != args.source_commit:
                raise ValueError("manifest identity mismatch")
        result["stage"] = "host_inputs"
        runtime_manifest, _selected = host.preflight_host_inputs(root, runtime, {"web": args.web_cohort, "headless": args.headless_cohort}, "v070")
        for name in ("node", "npm", "tar"):
            native.resolve_executable(name)
        result["stage"] = "child_and_process_query"
        host.preflight_execution_access()
        result["stage"] = "link_capability"
        host.preflight_link_access()
        result["stage"] = "consumer"
        consumer = Path(__file__).resolve().parent / "native_warm_scope_consumer.mjs"
        controls = consumer_controls(runtime_manifest["version"], args.source_commit, args.artifact_sha256, result["driver_sha256"])
        verify_consumer(consumer, controls)
        result.update(status="passed", stage="complete")
    except (Exception, KeyboardInterrupt) as error:
        result["failure_type"] = type(error).__name__
    return result

def reserve_result(path: Path, root: Path, runtime: Path):
    # Reject result paths inside either subject, including via symlinked parents.
    target = path.resolve(strict=False)
    if target.is_relative_to(root.resolve()) or target.is_relative_to(runtime.resolve()):
        raise ValueError("result path inside source or runtime")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    return os.fdopen(fd, "w+", encoding="utf-8", newline="\n")

def argument_parser() -> argparse.ArgumentParser:
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--repo-root",type=Path,required=True); p.add_argument("--runtime-root",type=Path,required=True)
    p.add_argument("--artifact",type=Path,required=True); p.add_argument("--artifact-sha256",required=True)
    p.add_argument("--source-commit",required=True); p.add_argument("--output",type=Path,required=True)
    p.add_argument("--web-cohort",default="dsh-0.2.2-rc.3-core-v1"); p.add_argument("--headless-cohort",default="dsh-0.2.2-rc.3-core-v1")
    return p

def main(argv=None) -> int:
    args=argument_parser().parse_args(argv)
    # Reserve an unused external result first. A collision never overwrites evidence.
    placeholder = {"schema":"dsh-native-warm-preflight/v1","status":"started"}
    with reserve_result(args.output,args.repo_root,args.runtime_root) as stream:
        json.dump(placeholder,stream,indent=2,sort_keys=True);stream.write("\n");stream.flush()
        result=check(args)
        stream.seek(0);stream.truncate()
        json.dump(result,stream,indent=2,sort_keys=True);stream.write("\n");stream.flush()
    return 0 if result["status"]=="passed" else 1
if __name__ == "__main__":
    raise SystemExit(main())
