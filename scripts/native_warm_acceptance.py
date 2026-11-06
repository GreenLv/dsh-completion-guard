#!/usr/bin/env python3
"""Run versioned warm-scope acceptance against a supplied frozen Guard tgz.

--preflight performs no install or host launch. Actual runs use an isolated
copy and retain the fixture if process ownership or cleanup is uncertain.
"""
from __future__ import annotations
import argparse
import base64
import hashlib
import io
import json
import os
import platform
import re
import secrets
import shutil
import socket
import subprocess
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
import native_acceptance as native
import native_host_acceptance as host
import native_warm_runtime_copy as copier
import native_warm_scope_preflight as preflight

HEX64=re.compile(r"^[a-f0-9]{64}$")
FIXTURE_NAME="warm-inert-fixture"
FIXTURE_VERSION="1.0.0"
FIXTURE_HEAD="f"*40

def unpack_frozen(artifact: Path,destination: Path) -> Path:
    destination.mkdir()
    seen=set();total=0
    with tarfile.open(artifact,"r:gz") as archive:
        for member in archive:
            raw=member.name.rstrip("/");path=PurePosixPath(raw)
            if not raw or "\\" in raw or path.is_absolute() or path.parts[0]!="package" or any(x in (".","..") for x in path.parts) or raw in seen:
                raise ValueError("invalid artifact member")
            seen.add(raw)
            if not(member.isfile() or member.isdir()):raise ValueError("unsupported artifact member")
            total+=member.size
            if total>1_000_000_000:raise ValueError("artifact size bound")
            target=destination.joinpath(*path.parts)
            if member.isdir():target.mkdir(parents=True,exist_ok=True);continue
            target.parent.mkdir(parents=True,exist_ok=True)
            with archive.extractfile(member) as source, target.open("xb") as output:
                shutil.copyfileobj(source,output)
    return destination/"package"

def frozen_guard_version(package: Path, expected_commit: str) -> str:
    manifest=json.loads((package/"package.json").read_text(encoding="utf-8"))
    if not isinstance(manifest,dict) or manifest.get("name")!="dsh-completion-guard" or manifest.get("gitHead")!=expected_commit:
        raise ValueError("frozen package identity mismatch")
    version=manifest.get("version")
    if not isinstance(version,str) or not version:
        raise ValueError("frozen package version missing")
    return version

def inert_fixture(path: Path) -> str:
    manifest={"name":FIXTURE_NAME,"version":FIXTURE_VERSION,"files":["index.js"],"gitHead":FIXTURE_HEAD,
              "repository":{"type":"git","url":"https://github.com/GreenLv/dsh-completion-guard.git"}}
    with tarfile.open(path,"w:gz") as archive:
        for name,data in (("package/package.json",json.dumps(manifest).encode()),("package/index.js",b"x\n\n")):
            item=tarfile.TarInfo(name);item.size=len(data);item.mode=0o644;archive.addfile(item,io.BytesIO(data))
    h=hashlib.sha512(path.read_bytes()).digest()
    return "sha512-"+base64.b64encode(h).decode("ascii")

def safe_remove_fixture(path: Path) -> None:
    """Delete only our physical temp child; never follow a reparse point."""
    parent=Path(tempfile.gettempdir()).resolve(strict=True)
    resolved=path.resolve(strict=True)
    if resolved.parent!=parent or path.is_symlink() or (hasattr(path,"is_junction") and path.is_junction()):
        raise ValueError("fixture ownership is ambiguous")
    stack=[resolved]
    while stack:
        current=stack.pop()
        with os.scandir(current) as iterator:
            for entry in iterator:
                child=Path(entry.path)
                if entry.is_symlink() or (hasattr(child,"is_junction") and child.is_junction()):
                    target=child.resolve(strict=True)
                    if target!=resolved and not target.is_relative_to(resolved):raise ValueError("fixture link escapes root")
                elif entry.is_dir(follow_symlinks=False):stack.append(child)
    if path.resolve(strict=True)!=resolved:raise ValueError("fixture identity changed")
    shutil.rmtree(resolved)

def validate_composition(text: str, wrapper: Path) -> str:
    # rc.5 patches cannot change an entry name. Keep the original disabled,
    # insert exactly one active wrapper, and verify the actual wrapper config.
    lines=text.splitlines();starts=[i for i,line in enumerate(lines) if line.startswith("- id:")]
    entries=[];identities=[]
    for j,start in enumerate(starts):
        end=starts[j+1] if j+1<len(starts) else len(lines)
        block=lines[start:end]
        identity=block[0].split(":",1)[1].strip().strip("'\"")
        identities.append(identity)
        names=[i for i,line in enumerate(block) if re.match(r"^  name:",line)]
        if len(names)!=1:continue
        i=names[0];value=block[i].split(":",1)[1].strip()
        if value in (">-","|-"):
            parts=[]
            for line in block[i+1:]:
                if not line.startswith("    "):break
                parts.append(line[4:])
            value=(" " if value==">-" else "\n").join(parts)
        elif value.startswith("'") and value.endswith("'"):
            value=value[1:-1].replace("''", "'")
        elif value.startswith('"') and value.endswith('"'):
            value=json.loads(value)
        entries.append((identity,value,block))
    original=[block for identity,value,block in entries if identity=="context-guard" and value=="dsh-completion-guard"]
    active=[block for identity,value,block in entries if identity=="warm-guard-wrapper" and value==wrapper.as_uri()]
    relevant=[row for row in entries if row[1] in ("dsh-completion-guard",wrapper.as_uri())]
    if identities.count("context-guard")!=1 or identities.count("warm-guard-wrapper")!=1 or len(original)!=1 or len(active)!=1 or len(relevant)!=2 or original[0].count("  disabled: true")!=1 or any(line.strip()=="disabled: true" for line in active[0]):
        raise ValueError("Guard wrapper composition mismatch")
    # The existing host-lock consumer selects id=context-guard. This read-only
    # view substitutes the independently verified id/name expected by that
    # consumer; all actual wrapper config lines remain unchanged.
    block=active[0];name_index=next(i for i,line in enumerate(block) if re.match(r"^  name:",line))
    name_end=name_index+1
    if block[name_index].split(":",1)[1].strip() in (">-","|-"):
        while name_end<len(block) and block[name_end].startswith("    "):name_end+=1
    view=["- id: context-guard",*block[1:name_index],"  name: dsh-completion-guard",*block[name_end:]]
    return "\n".join(view)+"\n"

def validate_result(result: dict, expected: dict) -> bool:
    consumer=Path(__file__).resolve().parent/"native_warm_scope_consumer.mjs"
    code="import {pathToFileURL} from 'node:url'; let s='';for await(const c of process.stdin)s+=c;const m=await import(pathToFileURL(process.argv[1]).href);const x=JSON.parse(s);process.stdout.write(m.validateWarmResult(x.result,x.expected)?'valid':'invalid')"
    process=subprocess.run([native.resolve_executable("node"),"--input-type=module","-e",code,str(consumer)],
        input=json.dumps({"result":result,"expected":expected}).encode(),capture_output=True,timeout=15,check=False)
    return process.returncode==0 and process.stdout==b"valid"

def execute(args, driver_sha: str, progress: Path) -> dict:
    root=args.repo_root.resolve(strict=True);artifact=args.artifact.resolve(strict=True)
    runtime_source=args.runtime_root.resolve(strict=True)
    temporary=host.host_temporary_root();processes=[];logs=[];overlays=[];ports=[];uncertain=False
    result={"schema":"dsh-native-warm-scope/v1","status":"failed","source_commit":args.source_commit,
            "artifact_sha256":args.artifact_sha256,"driver_sha256":driver_sha,"platform":"windows" if os.name=="nt" else "macos",
            "host":{},"profiles":{},"cleanup":{"status":"failed","remaining_ids":[]}}
    stage="runtime_copy"
    try:
        snapshot=temporary/"guard-input.tgz"
        with artifact.open("rb") as src, snapshot.open("xb") as dst:shutil.copyfileobj(src,dst)
        if native.sha256(snapshot)!=args.artifact_sha256:raise ValueError("artifact snapshot mismatch")
        artifact=snapshot
        copied=temporary/"runtime"; copy=copier.copy_runtime(runtime_source,copied)
        environment=host.isolated_environment(temporary);work=temporary/"work";work.mkdir()
        node=native.resolve_executable("node"); node_version=host.run_host_command(work,environment,node,"--version").strip()
        cli=copied/"node_modules"/"@deepseek-ai"/"dsh"/"lib"/"bin.js"
        runtime_manifest,selected=host.preflight_host_inputs(root,copied,{"web":args.web_cohort,"headless":args.headless_cohort},"v070")
        result["host"]={"version":runtime_manifest["version"],"node_version":node_version,"runtime_sha256":copy["inventory_sha256"],"node_sha256":native.sha256(Path(node).resolve(strict=True))}
        extracted=unpack_frozen(artifact,temporary/"extracted");guard_version=frozen_guard_version(extracted,args.source_commit);artifact_tree=native.tree_digest(extracted)
        release=temporary/"inert-release.tgz";integrity=inert_fixture(release)
        wrapper=root/"scripts"/"native_warm_guard_plugin.mjs";probe=root/"scripts"/"native_warm_host_probe.mjs"
        for profile in ("web","headless"):
            stage=profile+"_install"
            if native.sha256(artifact)!=args.artifact_sha256:raise ValueError("artifact changed")
            host.run_host_command(work,environment,node,str(cli),"plugin","--profile",profile,"add","--ignore-scripts","--config.auto-install-peers=false",str(artifact))
            if native.sha256(artifact)!=args.artifact_sha256:raise ValueError("artifact changed")
            profile_root=temporary/"dsh"/"profiles"/profile;installed=profile_root/"node_modules"/"dsh-completion-guard"
            if native.tree_digest(installed)!=artifact_tree:raise ValueError("installed package parity")
            locker=installed/"bin"/"dsh-completion-guard-host-lock.mjs"
            lock_args=["--runtime-root",str(copied),"--profile-root",str(profile_root)]
            stage=profile+"_host_lock"
            graph=json.loads(host.run_host_command(work,environment,node,str(locker),"inspect-graph",*lock_args))
            host.verify_target_graph(graph["packages"],selected[profile]["packages"],profile)
            readback=json.loads(host.run_host_command(work,environment,node,str(locker),"inject",*lock_args))
            lock=readback.get("host_lock_digest")
            if readback.get("status")!="supported" or readback.get("cohort_id")!=selected[profile]["id"] or not isinstance(lock,str) or not HEX64.fullmatch(lock):raise ValueError("host lock identity")
            nonce=secrets.token_hex(12);receipt=temporary/(profile+"-warm-result.json");overlay=temporary/(profile+"-warm.patch.yml")
            overlays.append(overlay)
            guard={"activation":"always","policy":"release","hostLockPackages":selected[profile]["packages"],"hostLockPlatform":"windows" if os.name=="nt" else "posix",
                   "hostLockProfile":profile,"hostLockPolicy":"dsh-core/v1","hostLockRuntimeRoot":str(copied),"hostLockProfileRoot":str(profile_root)}
            guard["warm"]={"nonce":nonce,"fixtureRoot":str(temporary),"guardVersion":guard_version,"sourceCommit":args.source_commit,
                "releaseTgz":str(release),"packageName":FIXTURE_NAME,"packageVersion":FIXTURE_VERSION,"integrity":integrity}
            config={"fixtureRoot":str(temporary),"runtimeRoot":str(copied),"profileRoot":str(profile_root),"workRoot":str(work),"nonce":nonce,"profile":profile,
                    "sourceCommit":args.source_commit,"artifactSha256":args.artifact_sha256,"driverSha256":driver_sha,"hostLockDigest":lock,
                    "releaseTgz":str(release),"packageName":FIXTURE_NAME,"packageVersion":FIXTURE_VERSION,"fixtureGitHead":FIXTURE_HEAD,"integrity":integrity,
                    "importer":str(copied/"node_modules"/"@deepseek-ai"/"dsh-session"/"lib"/"index.js"),"output":str(receipt),"progress":str(progress)}
            patches=[{"id":"context-guard","disabled":True},{"insert":[{"id":"warm-guard-wrapper","name":wrapper.as_uri(),"config":guard}]},host.native_probe_patch(probe,config),{"id":"goal-round-driver","disabled":True}]
            if profile=="headless":patches.extend([{"id":"headless-runner","disabled":True},{"id":"headless-startup","disabled":True}])
            overlay.write_text(json.dumps(patches),encoding="utf-8",newline="\n")
            stage=profile+"_composition"
            dump=host.run_host_command(work,environment,node,str(cli),"--profile",profile,"--patch",str(overlay),"--dump-config")
            view=validate_composition(dump,wrapper)
            composed=temporary/(profile+"-active-wrapper-view.yml");composed.write_text(view,encoding="utf-8",newline="\n")
            host.run_host_command(work,environment,node,str(locker),"verify-dump",*lock_args,"--dump-config",str(composed))
            argv=[node,str(cli),"--profile",profile,"--patch",str(overlay)];port=None
            if profile=="web":port=host.free_loopback_port();ports.append(port);argv.extend(["--host","127.0.0.1","--port",str(port),"--no-open"])
            log=(temporary/(profile+"-host.log")).open("wb");logs.append(log);stage=profile+"_probe"
            proc=subprocess.Popen(argv,cwd=work,env=environment,stdout=log,stderr=log,start_new_session=os.name!="nt");processes.append(proc)
            def collect():
                if receipt.is_file():return json.loads(receipt.read_text(encoding="utf-8"))
                if proc.poll() is not None:raise RuntimeError("host exited before receipt")
                return None
            value=host.wait_until(collect,timeout=900)
            owned=host.discover_owned_hosts(cli,overlays)
            if value.get("pid")!=proc.pid and value.get("pid") not in owned:raise RuntimeError("unowned probe process")
            if value.get("schema")!="dsh-native-warm-probe/v1" or value.get("cleanup")!="passed" or value.get("status")!="passed" or value.get("nonce")!=nonce or value.get("profile")!=profile or value.get("source_commit")!=args.source_commit or value.get("artifact_sha256")!=args.artifact_sha256 or value.get("driver_sha256")!=driver_sha or value.get("host_lock_digest")!=lock:
                uncertain=value.get("cleanup")=="failed_preserved" or bool((value.get("failure",{}).get("scope") or {}).get("child_state_unknown"))
                result["probe_failure"]={"profile":profile,"failure":value.get("failure"),"cleanup":value.get("cleanup")}
                raise RuntimeError("warm probe failed")
            result["profiles"][profile]={"pid":value["pid"],"host_lock_digest":lock,"steps":value["steps"]}
            stage=profile+"_stop"
            if host.cleanup_owned_processes([proc]):raise RuntimeError("owned host did not stop")
            remaining_for_profile=host.discover_owned_hosts(cli,[overlay])
            if remaining_for_profile:raise RuntimeError("owned host descendant remains")
            if port:
                def closed():
                    with socket.socket() as connection:
                        connection.settimeout(0.5);return connection.connect_ex(("127.0.0.1",port))!=0
                host.wait_until(closed,timeout=15)
        result["status"]="passed"
        result["cleanup"]={"status":"passed","remaining_ids":[]}
        stage="consumer_precleanup"
        if not validate_result(result,{"source_commit":args.source_commit,"artifact_sha256":args.artifact_sha256,"driver_sha256":driver_sha}):
            raise ValueError("consumer rejected provisional result")
    except (Exception,KeyboardInterrupt) as error:
        uncertain=uncertain or host.unknown_child_state(error) or stage.endswith("_probe")
        result["status"]="failed";result["failure"]={"stage":stage,"type":type(error).__name__}
    finally:
        remaining=["child_state_unknown"] if uncertain else []
        if result["status"]!="passed":remaining.append("failed_fixture_retained")
        remaining.extend(host.cleanup_owned_processes(processes))
        try:
            found=host.discover_owned_hosts((temporary/"runtime"/"node_modules"/"@deepseek-ai"/"dsh"/"lib"/"bin.js"),overlays) if overlays else {}
            if found:remaining.append("owned_host_still_live")
        except Exception:remaining.append("process_query_unknown")
        for log in logs:
            try:log.close()
            except OSError:remaining.append("log_close_failed")
        for port in ports:
            try:
                with socket.socket() as connection:
                    connection.settimeout(.5)
                    if connection.connect_ex(("127.0.0.1",port))==0:remaining.append("owned_listener_still_open")
            except OSError:remaining.append("listener_state_unknown")
        if not remaining:
            try:safe_remove_fixture(temporary)
            except (OSError,ValueError):remaining.append("fixture_removal_failed")
        if remaining:
            result["status"]="failed"
            recovery=Path(str(args.output)+".recovery.json")
            with recovery.open("x",encoding="utf-8",newline="\n") as f:json.dump({"fixture":str(temporary),"reason":remaining},f);f.write("\n")
        result["cleanup"]={"status":"failed" if remaining else "passed","remaining_ids":list(dict.fromkeys(remaining))}
    return result

def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--repo-root",type=Path,required=True);p.add_argument("--runtime-root",type=Path,required=True);p.add_argument("--artifact",type=Path,required=True)
    p.add_argument("--source-commit",required=True);p.add_argument("--artifact-sha256",required=True);p.add_argument("--driver-sha256",required=True)
    p.add_argument("--web-cohort",default="dsh-0.2.2-rc.1-core-v1");p.add_argument("--headless-cohort",default="dsh-0.2.2-rc.1-core-v1")
    p.add_argument("--output",type=Path,required=True);p.add_argument("--preflight",action="store_true")
    args=p.parse_args(argv)
    # Preserve a valid started record if interrupted before terminal result.
    with preflight.reserve_result(args.output,args.repo_root,args.runtime_root) as stream:
        json.dump({"schema":"dsh-native-warm-run/v1","status":"started"},stream);stream.write("\n");stream.flush();os.fsync(stream.fileno())
        original=os.fstat(stream.fileno())
    pending=Path(str(args.output)+".pending")
    fd=os.open(pending,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,"w",encoding="utf-8",newline="\n") as staged:
        try:
            result=preflight.check(args)
            if result["driver_sha256"]!=args.driver_sha256:
                result.update(status="failed",stage="driver_identity",failure_type="DriverDigestMismatch")
            if result["status"]=="passed" and not args.preflight:
                progress=Path(str(args.output)+".progress.jsonl")
                recovery=Path(str(args.output)+".recovery.json")
                if recovery.exists() or recovery.is_symlink():raise FileExistsError("recovery path exists")
                with progress.open("x",encoding="utf-8"):pass
                result=execute(args,args.driver_sha256,progress)
        except (Exception,KeyboardInterrupt) as error:
            result={"schema":"dsh-native-warm-run/v1","status":"failed","failure_type":type(error).__name__,"stage":"runner"}
        json.dump(result,staged,indent=2,sort_keys=True);staged.write("\n");staged.flush();os.fsync(staged.fileno())
    current=args.output.lstat()
    if (current.st_dev,current.st_ino)!=(original.st_dev,original.st_ino):raise RuntimeError("result reservation changed")
    os.replace(pending,args.output)

    return 0 if result.get("status")=="passed" else 1
if __name__=="__main__":raise SystemExit(main())
