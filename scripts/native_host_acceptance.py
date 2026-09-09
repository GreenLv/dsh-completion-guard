"""Host-bound exact-artifact acceptance; supplied daily targets are read-only.

The entrypoint creates both profiles below one new temporary DSH_HOME. A
versioned Cordis probe drives real host services without requesting a model.
CI/artifact preconditions are supplied to native_acceptance.py by its caller.
"""
from __future__ import annotations

import io
import tarfile
import json
import os
import platform
import secrets
import shutil
import signal
import shlex
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

PROBE_CASES = {
    "nonempty_test_certificate", "package_update_rebind_certificate", "generic_pending_and_rebind_roundtrip",
    "history_pagination_roundtrip", "compact_and_persisted_resume", "qualified_pending_boundary",
}


def host_temporary_root() -> Path:
    """Create a disposable root using the host's normal directory ACL policy.

    Python 3.12.4+ implements Windows mkdir(0o700), used by mkdtemp(), with
    a protected OWNER RIGHTS DACL. A DSH restricted token cannot traverse
    that root: even its own private temp and workspace become inaccessible.
    On Windows inherit the existing temp parent's ACL, as native directory
    creation does. Do not edit an ACL or change the sandbox's grants/mode.
    POSIX retains mkdtemp's owner-only mode.
    """
    if platform.system() != "Windows":
        return Path(tempfile.mkdtemp(prefix="dsh-guard-host-"))
    parent = Path(tempfile.gettempdir())
    for _ in range(10):
        path = parent / f"dsh-guard-host-{secrets.token_hex(12)}"
        try:
            path.mkdir()
        except FileExistsError:
            continue
        return path
    raise RuntimeError("cannot allocate a unique host temporary root")


def isolated_environment(root: Path) -> dict[str, str]:
    # Deliberate allowlist: inherited API tokens, NODE_OPTIONS and provider
    # overrides never enter this credential-free acceptance driver.
    names = {"PATH", "SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT", "WINDIR", "LANG", "LC_ALL"}
    env = {key: value for key, value in os.environ.items() if key in names}
    home = root / "home"
    home.mkdir(parents=True, exist_ok=True)
    env.update({"HOME": str(home), "USERPROFILE": str(home),
                "HOMEDRIVE": home.drive, "HOMEPATH": str(home)[len(home.drive):],
                "APPDATA": str(home / "AppData" / "Roaming"), "LOCALAPPDATA": str(home / "AppData" / "Local"),
                "DSH_HOME": str(root / "dsh"), "XDG_CONFIG_HOME": str(root / "config"),
                "XDG_CACHE_HOME": str(root / "cache"), "XDG_DATA_HOME": str(root / "data"),
                "npm_config_cache": str(root / "npm-cache"), "PNPM_HOME": str(root / "pnpm"),
                "DSH_TELEMETRY_DISABLED": "1", "DSH_TOOLS_MODE": "native",
                "CHOKIDAR_USEPOLLING": "1", "TMPDIR": str(root / "tmp"),
                "TEMP": str(root / "tmp"), "TMP": str(root / "tmp")})
    for name in ("npm-user.conf", "npm-global.conf"):
        (root / name).write_text("", encoding="utf-8")
    env["npm_config_userconfig"] = str(root / "npm-user.conf")
    env["npm_config_globalconfig"] = str(root / "npm-global.conf")
    for key in ("DSH_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "npm_config_cache", "PNPM_HOME", "APPDATA", "LOCALAPPDATA", "TMPDIR"):
        Path(env[key]).mkdir(parents=True, exist_ok=True)
    return env


def run_host_command(work: Path, environment: dict[str, str], *args: str) -> str:
    """Decode Node/DSH output strictly, independently of Python's console locale."""
    executed = subprocess.run(list(args), cwd=work, env=environment, capture_output=True,
                              text=False, timeout=120, check=False)
    if executed.returncode:
        raise RuntimeError(f"host command exited with code {executed.returncode}")
    # Decode in the calling thread. text=True's Windows reader thread can lose
    # stdout on a GBK decode error and leave a misleading later None TypeError.
    output = executed.stdout.decode("utf-8", errors="strict")
    executed.stderr.decode("utf-8", errors="strict")
    return output


def write_test_fixture(work: Path) -> None:
    (work / "package.json").write_text(json.dumps({"name": "guard-native-fixture", "private": True,
                                                   "scripts": {"test": "node fixture.cjs"}}), encoding="utf-8")
    (work / "fixture.cjs").write_bytes(b"require('node:assert/strict').equal(2 + 2, 4)\n")


def package_fixture(root: Path, version: str) -> Path:
    """Local inert Cordis package for the real DSH update acceptance case."""
    path = root / f"guard-acceptance-fixture-{version}.tgz"
    files = {"package/package.json": json.dumps({"name": "guard-acceptance-fixture", "version": version,
             "type": "module", "main": "index.js"}),
             "package/index.js": "export const name = 'guard-acceptance-fixture'; export function apply() {}\n"}
    with tarfile.open(path, "w:gz") as archive:
        for name, text in files.items():
            data = text.encode("utf-8")
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(data))
    return path


def validate_probe(value: Any, nonce: str, driver_digest: str, restart: bool = False) -> bool:
    expected = {'persisted_restart_resume'} if restart else PROBE_CASES
    return (isinstance(value, dict) and value.get("schema") == "dsh-native-host-probe/v1"
            and value.get("nonce") == nonce and value.get("driver_sha256") == driver_digest
            and value.get("mode", "initial") == ("restart" if restart else "initial")
            and value.get("status") == "passed" and value.get("real_model_request") is False
            and isinstance(value.get("pid"), int) and value["pid"] > 0
            and isinstance(value.get("cases"), list)
            and len(value["cases"]) == len(expected)
            and {row.get("id") for row in value["cases"]} == expected
            and all(row.get("status") == "passed" for row in value["cases"]))


def free_loopback_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def http_json(origin: str, path: str, method: str = "GET", request_origin: str | None = None) -> tuple[int, dict[str, Any]]:
    headers = {"accept": "application/json"}
    data = None
    if method == "POST":
        headers["content-type"] = "application/json"
        data = b"{}"
    if request_origin:
        headers["origin"] = request_origin
    request = urllib.request.Request(origin + path, data=data, headers=headers, method=method)
    # Loopback is never sent through an inherited proxy; redirects cannot
    # redirect an acceptance request to another host.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=3) as response:
            return response.status, json.loads(response.read(65536))
    except urllib.error.HTTPError as exc:
        return exc.code, {}


def wait_until(callback, timeout: int = 90):
    deadline = time.monotonic() + timeout
    delay = 0.1
    while time.monotonic() < deadline:
        try:
            value = callback()
            if value:
                return value
        except (OSError, ValueError, urllib.error.URLError):
            pass
        time.sleep(delay)
        delay = min(delay * 1.5, 2)
    raise RuntimeError("host acceptance deadline exceeded")


def owns_host_command(command: str, cli: Path, overlay: Path, windows: bool = False) -> bool:
    """Require exact CLI and --patch argv, never a process-name-only match."""
    try:
        argv = shlex.split(command, posix=not windows)
    except ValueError:
        return False
    if windows:
        argv = [arg.strip('"').casefold() for arg in argv]
    expected_cli = str(cli).casefold() if windows else str(cli)
    expected_overlay = str(overlay).casefold() if windows else str(overlay)
    return expected_cli in argv and any(argv[i:i + 2] == ["--patch", expected_overlay] for i in range(len(argv) - 1))


def discover_owned_hosts(cli: Path, overlays: list[Path]) -> dict[int, Path]:
    """Find this invocation's restarted host even before its probe completes."""
    windows = platform.system() == "Windows"
    if windows:
        result = subprocess.run(["powershell", "-NoProfile", "-Command",
            "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
            capture_output=True, text=True, timeout=10, check=True)
        value = json.loads(result.stdout or "[]")
        rows = value if isinstance(value, list) else [value]
        pairs = [(row.get("ProcessId"), row.get("CommandLine") or "") for row in rows]
    else:
        result = subprocess.run(["ps", "-axo", "pid=,args="], capture_output=True, text=True, timeout=10, check=True)
        pairs = []
        for line in result.stdout.splitlines():
            fields = line.strip().split(None, 1)
            if len(fields) == 2 and fields[0].isdigit():
                pairs.append((int(fields[0]), fields[1]))
    return {pid: overlay for pid, command in pairs if isinstance(pid, int) and pid > 0 and pid != os.getpid()
            for overlay in overlays if owns_host_command(command, cli, overlay, windows)}


def native_probe_patch(probe: Path, config: dict[str, Any]) -> dict[str, Any]:
    # Node ESM treats a Windows drive letter as a URL scheme. File URLs also
    # preserve spaces, non-ASCII names and literal # characters on both hosts.
    return {"insert": [{"id": "native-guard-probe", "name": probe.as_uri(), "config": config}]}


def select_target_cohorts(cohorts: list[dict[str, Any]], runtime_version: str,
                          targets: dict[str, str]) -> dict[str, dict[str, Any]]:
    """Select exact, explicit targets; runtime version alone is ambiguous."""
    if set(targets) != {"web", "headless"}:
        raise RuntimeError("explicit Web and Headless cohort targets are required")
    selected = {}
    for profile, identity in targets.items():
        matches = [row for row in cohorts if row["id"] == identity]
        if len(matches) != 1:
            raise RuntimeError(f"unknown or ambiguous {profile} cohort: {identity}")
        cohort = matches[0]
        host = [row for row in cohort["packages"] if row["name"] == "@deepseek-ai/dsh"]
        if len(host) != 1 or host[0]["version"] != runtime_version:
            raise RuntimeError(f"{profile} cohort runtime version mismatch")
        selected[profile] = cohort
    return selected


def verify_target_graph(actual: list[dict[str, str]], expected: list[dict[str, str]], profile: str) -> None:
    def keys(rows):
        return sorted((row.get("name", ""), row.get("version", ""), row.get("integrity", "")) for row in rows)
    if keys(actual) != keys(expected):
        different = sorted({row.get("name", "") for row in actual + expected
                            if keys([row])[0] not in set(keys(actual)).intersection(keys(expected))})
        raise RuntimeError(f"{profile} target graph mismatch: {', '.join(different)}")


def preflight_host_inputs(root: Path, runtime_root: Path,
                          targets: dict[str, str]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Read launcher/cohort inputs before any package installation or host start."""
    cli = runtime_root / "node_modules" / "@deepseek-ai" / "dsh" / "lib" / "bin.js"
    if not cli.is_file():
        raise RuntimeError("runtime root has no DSH launcher")
    if not (root / "scripts" / "native_host_probe.mjs").is_file():
        raise RuntimeError("native host probe is missing")
    manifest = json.loads((cli.parent.parent / "package.json").read_text(encoding="utf-8"))
    cohorts = json.loads((root / "manifests" / "supported-host.v1.json").read_text(encoding="utf-8"))["cohorts"]
    selected = select_target_cohorts(cohorts, manifest["version"], targets)
    return manifest, selected


def host_acceptance(api, root: Path, artifact: Path, digest: str, runtime_root: Path,
                    result: dict[str, Any], targets: dict[str, str] | None = None,
                    target_profiles: dict[str, Path] | None = None,
                    web_market_version: str | None = None) -> dict[str, Any]:
    result["gate_profile"] = "host_bound_core"
    result["host_lock_policy"] = "dsh-core/v1"
    result["market_interface"] = {"status": "not_requested" if web_market_version is None else "unavailable",
                                  "target_version": web_market_version, "api_schema": None, "api_version": None,
                                  "advertised_restart": None, "loaded_instance_verified": False}
    result["capability_skips"] = ["real_model_request"]
    if result["status"] != "passed":
        return result
    temporary = host_temporary_root()
    environment = isolated_environment(temporary)
    work = temporary / "work"
    work.mkdir()
    write_test_fixture(work)
    fixture_old = package_fixture(temporary, "1.0.0")
    fixture_new = package_fixture(temporary, "2.0.0")
    cli = runtime_root / "node_modules" / "@deepseek-ai" / "dsh" / "lib" / "bin.js"
    probe = root / "scripts" / "native_host_probe.mjs"
    driver_digest = api.sha256(probe)
    processes: list[subprocess.Popen] = []
    log_handles = []
    gates = result["gates"]
    owned_ports: list[int] = []
    extra_pids: dict[int, Path] = {}
    overlays: list[Path] = []

    def command(*args: str) -> str:
        return run_host_command(work, environment, *args)

    def passed(id: str) -> None:
        gates.append(api.gate(id, digest, passed=True))

    try:
        runtime_manifest, selected = preflight_host_inputs(root, runtime_root, targets or {})
        # Optional daily targets are read-only inputs, never destinations.
        # A caller supplying one must supply both; no silent fixture fallback.
        if target_profiles and set(target_profiles) != {"web", "headless"}:
            raise RuntimeError("both target profile paths are required")
        for profile, profile_path in (target_profiles or {}).items():
            graph = json.loads(command("node", str(root / "bin" / "dsh-completion-guard-host-lock.mjs"),
                                       "inspect-graph", "--runtime-root", str(runtime_root),
                                       "--profile-root", str(profile_path)))
            verify_target_graph(graph["packages"], selected[profile]["packages"], profile)
            market_path = profile_path / "node_modules" / "dshmarket" / "package.json"
            installed_market = json.loads(market_path.read_text(encoding="utf-8")) if market_path.is_file() else None
            expected_market = web_market_version if profile == "web" else None
            if (installed_market or {}).get("version") != expected_market:
                raise RuntimeError(f"{profile} target dshmarket version mismatch")
        result["platform"]["toolchain"]["dsh"] = runtime_manifest["version"]
        result["host_driver_sha256"] = driver_digest
        result["host_lock_digests"] = {}
        extracted = temporary / "extracted"
        extracted.mkdir()
        command("tar", "-xf", str(artifact), "-C", str(extracted))
        artifact_tree = api.tree_digest(extracted / "package")
        for profile in ("web", "headless"):
            packages = selected[profile]["packages"]
            market_version = web_market_version if profile == "web" else None
            profile_root = temporary / "dsh" / "profiles" / profile
            install = ["node", str(cli), "plugin", "--profile", profile, "add", "--ignore-scripts",
                       "--config.auto-install-peers=false", str(artifact), str(fixture_old)]
            if market_version:
                install.append(f"dshmarket@{market_version}")
            command(*install)
            installed = profile_root / "node_modules" / "dsh-completion-guard"
            if api.tree_digest(installed) != artifact_tree:
                raise RuntimeError("installed package differs from exact tgz")
            passed(f"{profile}_package_parity")
            tracked = [profile_root / "package.json", profile_root / "pnpm-lock.yaml", profile_root / "cordis.patch.yml"]
            before = {path.name: api.sha256(path) for path in tracked if path.exists()}
            command(*install)
            after = {path.name: api.sha256(path) for path in tracked if path.exists()}
            if before != after or api.tree_digest(installed) != artifact_tree:
                raise RuntimeError("second host install was not a strict no-op")
            passed(f"{profile}_strict_second_noop")
            locker = installed / "bin" / "dsh-completion-guard-host-lock.mjs"
            lock_args = ["--runtime-root", str(runtime_root), "--profile-root", str(profile_root)]
            readback = json.loads(command("node", str(locker), "inject", *lock_args))
            if (readback.get("status") != "supported"
                    or readback.get("cohort_id") != selected[profile]["id"]
                    or readback.get("package_count") != len(packages)):
                raise RuntimeError("host lock unsupported")
            result["host_lock_digests"][profile] = readback["host_lock_digest"]
            composed = profile_root / "composed.yml"
            composed.write_text(command("node", str(cli), "--profile", profile, "--dump-config"), encoding="utf-8")
            command("node", str(locker), "verify-dump", *lock_args, "--dump-config", str(composed))
            passed(f"{profile}_host_lock_readback")
            if profile == "headless":
                missing = subprocess.run(["node", str(cli), "--profile", "headless", "Report the isolated acceptance status."],
                                         cwd=work, env=environment, capture_output=True, text=True,
                                         encoding="utf-8", errors="strict", timeout=60, check=False)
                if missing.returncode == 0 or "MISSING_CREDENTIAL" not in missing.stdout + missing.stderr:
                    raise RuntimeError("normal Headless missing-credential boundary not observed")
                passed("headless_missing_credential_boundary")
            nonce = secrets.token_hex(12)
            receipt = temporary / f"{profile}-probe"
            overlay = temporary / f"{profile}-probe.patch.yml"
            overlays.append(overlay)
            config = {"runtimeRoot": str(runtime_root), "workRoot": str(work), "nonce": nonce, "output": str(receipt), "profile": profile, "fixtureTgz": str(fixture_new)}
            # JSON is valid YAML. Isolated Headless loads its real base services
            # with the interactive task driver disabled; no model is requested.
            patches = [{"id": "context-guard", "config": {"activation": "always",
                         "hostLockPackages": packages, "hostLockPlatform": "windows" if platform.system() == "Windows" else "posix",
                         "hostLockProfile": profile, "hostLockPolicy": "dsh-core/v1",
                         "hostLockRuntimeRoot": str(runtime_root), "hostLockProfileRoot": str(profile_root)}},
                       native_probe_patch(probe, config)]
            if profile == "headless":
                patches.extend([{"id": "headless-runner", "disabled": True}, {"id": "headless-startup", "disabled": True}])
            overlay.write_text(json.dumps(patches), encoding="utf-8")
            # DSH overlays replace config objects; validate the effective probe
            # composition too, not only the base profile that was injected above.
            composed.write_text(command("node", str(cli), "--profile", profile, "--patch", str(overlay), "--dump-config"), encoding="utf-8")
            command("node", str(locker), "verify-dump", *lock_args, "--dump-config", str(composed))
            argv = ["node", str(cli), "--profile", profile, "--patch", str(overlay)]
            port = None
            if profile == "web":
                port = free_loopback_port()
                owned_ports.append(port)
                argv.extend(["--host", "127.0.0.1", "--port", str(port), "--no-open"])
            log = (temporary / f"{profile}-host.log").open("w", encoding="utf-8")
            log_handles.append(log)
            process = subprocess.Popen(argv, cwd=work, env=environment, stdout=log, stderr=log,
                                       start_new_session=platform.system() != "Windows")
            processes.append(process)

            def probe_result(exclude: set[int] | None = None):
                for path in temporary.glob(f"{profile}-probe.*.json"):
                    value = json.loads(path.read_text(encoding="utf-8"))
                    if exclude and value.get("pid") in exclude:
                        continue
                    if not validate_probe(value, nonce, driver_digest, restart=bool(exclude)):
                        result["host_probe_failures"] = [{"id": row.get("id"), "status": row.get("status"), "error_code": row.get("error_code"), "operation": row.get("operation"), "last_tool": row.get("last_tool")} for row in value.get("cases", []) if row.get("status") != "passed"]
                        raise RuntimeError("real host probe failed or returned an incomplete case set")
                    extra_pids[value["pid"]] = overlay
                    return value
                if not exclude and process.poll() is not None:
                    raise RuntimeError("real host exited before probe completion")
                return None
            first = wait_until(probe_result)
            for row in first["cases"]:
                passed(f"{profile}_{row['id']}")
            if port is not None:
                origin = f"http://127.0.0.1:{port}"
                # An optional protocol observation cannot decide core acceptance.
                # It is not a loaded-provider identity or Guard restart certificate.
                if web_market_version:
                    try:
                        code, capabilities = http_json(origin, "/dsh-market/api/v1/capabilities")
                        if (code == 200 and capabilities.get("schema") == "dsh-market/update-api/v1"
                                and capabilities.get("apiVersion") == 1 and capabilities.get("profile") == "web"
                                and capabilities.get("marketVersion") == web_market_version):
                            result["market_interface"] = {"status": "observed", "target_version": web_market_version,
                                "api_schema": "dsh-market/update-api/v1", "api_version": 1,
                                "advertised_restart": capabilities.get("features", {}).get("restart") is True,
                                "loaded_instance_verified": False}
                    except (OSError, ValueError, urllib.error.URLError):
                        pass
                # Restart only this driver's owned host; no optional plugin API.
                if platform.system() == "Windows":
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                                   capture_output=True, timeout=15, check=True)
                else:
                    os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=15)
                def stopped_listener():
                    with socket.socket() as connection:
                        connection.settimeout(0.2)
                        return connection.connect_ex(("127.0.0.1", port)) != 0
                wait_until(stopped_listener, timeout=15)
                process = subprocess.Popen(argv, cwd=work, env=environment, stdout=log, stderr=log,
                                           start_new_session=platform.system() != "Windows")
                processes.append(process)
                second = wait_until(lambda: probe_result({first["pid"]}))
                if second["pid"] == first["pid"]:
                    raise RuntimeError("restart did not change host process")
                passed("web_owned_restart_and_persisted_resume")
            # Exercise the installed launcher shim, with the same isolated env.
            shim = runtime_root / "node_modules" / ".bin" / ("dsh.cmd" if platform.system() == "Windows" else "dsh")
            if runtime_manifest["version"] not in command(str(shim), "--version"):
                raise RuntimeError("shell shim identity mismatch")
            passed(f"{profile}_shell_shim")
    except (OSError, ValueError, KeyError, StopIteration, subprocess.SubprocessError, RuntimeError):
        gates.append(api.gate("host_bound_acceptance", digest, passed=False,
                              note="host-bound gate failed; this is not native acceptance"))
    finally:
        remaining = []
        for process in processes:
            if process.poll() is None:
                if platform.system() != "Windows":
                    os.killpg(process.pid, signal.SIGTERM)
                else:
                    process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)
        try:
            extra_pids.update(discover_owned_hosts(cli, overlays))
        except (OSError, ValueError, subprocess.SubprocessError):
            remaining.append("restart_process_discovery_failed")
        # Restarted hosts may have detached from the original parent. Verify
        # this invocation's exact overlay argument before terminating a PID.
        for pid, overlay in extra_pids.items():
            if any(process.pid == pid for process in processes):
                continue
            try:
                if platform.system() == "Windows":
                    inspect = subprocess.run(["powershell", "-NoProfile", "-Command",
                        f"(Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}').CommandLine"],
                        capture_output=True, text=True, timeout=10, check=False)
                    if not owns_host_command(inspect.stdout.strip(), cli, overlay, platform.system() == "Windows"):
                        remaining.append("restart_process_identity_unavailable")
                        continue
                    subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=10, check=True)
                else:
                    inspect = subprocess.run(["ps", "-p", str(pid), "-o", "args="], capture_output=True, text=True, timeout=10, check=False)
                    if inspect.returncode:
                        continue
                    if not owns_host_command(inspect.stdout.strip(), cli, overlay, platform.system() == "Windows"):
                        remaining.append("restart_process_identity_unavailable")
                        continue
                    os.kill(pid, signal.SIGTERM)
                    wait_until(lambda: subprocess.run(["ps", "-p", str(pid), "-o", "pid="],
                        capture_output=True, timeout=3, check=False).returncode != 0, timeout=10)
            except (OSError, subprocess.SubprocessError, RuntimeError):
                remaining.append("restart_process_cleanup_failed")
        for log in log_handles:
            log.close()
        for port in owned_ports:
            def listener_closed():
                with socket.socket() as connection:
                    connection.settimeout(1)
                    return connection.connect_ex(("127.0.0.1", port)) != 0
            try:
                wait_until(listener_closed, timeout=10)
            except RuntimeError:
                remaining.append("owned_listener_still_open")
        shutil.rmtree(temporary, ignore_errors=True)
        if temporary.exists():
            remaining.append("host_temporary_root")
        result["cleanup"] = {"status": "failed" if remaining else "passed", "remaining_ids": remaining}
    result["status"] = "passed" if all(row["status"] == "passed" for row in gates) and result["cleanup"]["status"] == "passed" else "failed"
    result["run"]["finished_at"] = api.timestamp()
    return result
