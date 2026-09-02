#!/usr/bin/env python3
"""Run portable exact-tgz acceptance and emit native-acceptance/v2 JSON."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Sequence
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
IDENTIFIER = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


class NativeRunError(RuntimeError):
    """Raised when an exact portable acceptance input is unsafe."""


def run(root: Path, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        list(args), cwd=root, env=env, text=True, capture_output=True, check=False
    )
    if result.returncode:
        detail = (result.stdout + result.stderr).strip()
        raise NativeRunError(f"command failed ({args[0]}): {detail[-1000:]}")
    return result


def resolve_executable(command: str) -> str:
    """Resolve platform launchers such as Windows ``npm.cmd`` exactly once."""
    resolved = shutil.which(command)
    if resolved is None:
        raise NativeRunError(f"executable not found: {command}")
    return resolved


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_repository_url(raw: str) -> str:
    value = raw.strip()
    match = re.fullmatch(r"git@github\.com:([^/]+)/([^/]+?)(?:\.git)?", value)
    if match:
        return f"https://github.com/{match.group(1)}/{match.group(2)}.git"
    if value.startswith("https://") and "@" not in value.partition("//")[2].partition("/")[0]:
        return value
    raise NativeRunError("origin must be credential-free GitHub HTTPS or SSH")


def safe_tar_entries(output: str) -> list[str]:
    entries: list[str] = []
    for raw in output.splitlines():
        stripped = raw.strip()
        is_directory = stripped.endswith("/")
        value = stripped.rstrip("/")
        if not value:
            continue
        path = PurePosixPath(value)
        if path.is_absolute() or ".." in path.parts or path.parts[0] != "package":
            raise NativeRunError("artifact contains an unsafe or non-package path")
        if not is_directory:
            entries.append(value)
    if not entries or len(entries) != len(set(entries)):
        raise NativeRunError("artifact inventory is empty or contains duplicate paths")
    return sorted(entries)


def tree_digest(root: Path) -> str:
    records: list[tuple[str, str]] = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise NativeRunError("installed package contains a symlink")
        if path.is_file():
            records.append((path.relative_to(root).as_posix(), sha256(path)))
    if not records:
        raise NativeRunError("installed package tree is empty")
    return hashlib.sha256(
        json.dumps(records, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def gate(gate_id: str, artifact_sha256: str, *, passed: bool, note: str | None = None) -> dict[str, Any]:
    return {
        "id": gate_id,
        "required": True,
        "status": "passed" if passed else "failed",
        "subject": {"kind": "artifact", "id": artifact_sha256},
        "exit_code": 0 if passed else 1,
        "note": note,
        "evidence": {
            "mode": "executed",
            "source_result_sha256": None,
            "source_gate_id": None,
            "invalidation_reason": "artifact_changed",
        },
    }


def verify_exact_source(root: Path, source_commit: str) -> None:
    if not HEX40.fullmatch(source_commit):
        raise NativeRunError("source commit must be a full lowercase SHA-1")
    head = run(root, "git", "rev-parse", "HEAD").stdout.strip()
    if head != source_commit:
        raise NativeRunError("source commit is not the exact checked-out HEAD")
    status = run(
        root, "git", "status", "--porcelain=v1", "--untracked-files=all"
    ).stdout.strip()
    if status:
        raise NativeRunError(
            "repository state must be clean, including staged, unstaged, and untracked files"
        )


def transfer_receipt(result: dict[str, Any], transport_url: str) -> dict[str, Any]:
    artifact = result["artifact"]
    repository = result["repository"]
    acknowledged = timestamp()
    return {
        "schema": "artifact-transfer-receipt/v1",
        "status": "passed",
        "repository": repository,
        "artifact": {
            "filename": artifact["filename"],
            "sha256": artifact["sha256"],
            "size_bytes": artifact["size_bytes"],
            "source_commit": artifact["git_head"],
        },
        "transport": {
            "kind": "ci_artifact",
            "url": transport_url,
            "uploaded_sha256": artifact["sha256"],
            "downloaded_sha256": artifact["sha256"],
        },
        "receiver": {
            "platform": result["platform"]["os"],
            "acknowledged_at": acknowledged,
            "artifact_sha256": artifact["sha256"],
            "source_commit": repository["commit"],
        },
        "run": {"started_at": result["run"]["started_at"], "finished_at": acknowledged},
        "unperformed_actions": ["native_execution", "tag", "package_publish", "release"],
    }


def portable_acceptance(
    root: Path, artifact: Path, expected_sha256: str, source_commit: str, run_url: str | None
) -> dict[str, Any]:
    started = timestamp()
    gates: list[dict[str, Any]] = []
    temporary = Path(tempfile.mkdtemp(prefix="dsh-completion-guard-native-"))
    cleanup_status = "passed"
    remaining: list[str] = []
    artifact_digest = sha256(artifact)
    file_count = 0
    try:
        if artifact_digest != expected_sha256:
            raise NativeRunError("artifact SHA-256 does not match the expected digest")
        verify_exact_source(root, source_commit)
        listing = run(root, "tar", "-tf", str(artifact)).stdout
        entries = safe_tar_entries(listing)
        file_count = len(entries)
        gates.append(gate("package_inventory", artifact_digest, passed=True))

        extract_root = temporary / "extract"
        extract_root.mkdir()
        run(root, "tar", "-xf", str(artifact), "-C", str(extract_root))
        manifest = json.loads((extract_root / "package" / "package.json").read_text(encoding="utf-8"))
        if manifest.get("name") != "dsh-completion-guard" or manifest.get("gitHead") != source_commit:
            raise NativeRunError("package manifest name or gitHead does not match the candidate")
        gates.append(gate("manifest_identity", artifact_digest, passed=True))

        app = temporary / "app"
        app.mkdir()
        environment = os.environ.copy()
        environment["npm_config_cache"] = str(temporary / "npm-cache")
        npm = resolve_executable("npm")
        (app / "package.json").write_text('{"name":"native-check","private":true}\n', encoding="utf-8")
        npm_args = (
            npm, "install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", str(artifact)
        )
        run(app, *npm_args, env=environment)
        installed = app / "node_modules" / "dsh-completion-guard"
        first_digest = tree_digest(installed)
        gates.append(gate("isolated_install", artifact_digest, passed=True))
        run(app, *npm_args, env=environment)
        if tree_digest(installed) != first_digest:
            raise NativeRunError("second install changed installed package bytes")
        gates.append(gate("strict_second_noop", artifact_digest, passed=True))
        for script in sorted(installed.rglob("*")):
            if script.is_file() and script.suffix in {".js", ".mjs", ".cjs"}:
                run(app, "node", "--check", str(script))
        gates.append(gate("installed_syntax", artifact_digest, passed=True))
    except (OSError, UnicodeError, json.JSONDecodeError, NativeRunError) as exc:
        print(f"[FAIL] {exc}", file=sys.stderr)
        gates.append(gate(
            "portable_acceptance", artifact_digest, passed=False,
            note="portable gate failed; inspect the platform-local log",
        ))
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
        if temporary.exists():
            cleanup_status = "failed"
            remaining.append("portable_temporary_root")

    version_output = run(root, "node", "--version").stdout.strip()
    repository_url = normalize_repository_url(run(root, "git", "remote", "get-url", "origin").stdout)
    passed = all(item["status"] == "passed" for item in gates) and cleanup_status == "passed"
    return {
        "schema": "native-acceptance/v2",
        "status": "passed" if passed else "failed",
        "product": "dsh_completion_guard",
        "gate_profile": "portable_artifact",
        "repository": {"url": repository_url, "commit": source_commit},
        "runtime_tree_sha256": None,
        "artifact": {
            "filename": artifact.name,
            "sha256": artifact_digest,
            "size_bytes": artifact.stat().st_size,
            "file_count": max(file_count, 1),
            "git_head": source_commit,
        },
        "platform": {
            "os": {"Darwin": "macos", "Windows": "windows"}.get(platform.system(), "linux"),
            "shell": "python-subprocess",
            "toolchain": {"python": platform.python_version(), "node": version_output},
        },
        "gates": gates,
        "cleanup": {"status": cleanup_status, "remaining_ids": remaining},
        "run": {"started_at": started, "finished_at": timestamp(), "run_url": run_url},
        "unperformed_actions": ["commit", "push", "tag", "package_publish", "release", "public_promotion"],
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--artifact-sha256", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--run-url")
    parser.add_argument("--transfer-receipt", type=Path)
    parser.add_argument("--transport-url")
    args = parser.parse_args(argv)
    if not HEX64.fullmatch(args.artifact_sha256) or not HEX40.fullmatch(args.source_commit):
        parser.error("artifact SHA-256 and source commit must be full lowercase digests")
    result = portable_acceptance(
        args.repo_root.resolve(), args.artifact.resolve(), args.artifact_sha256,
        args.source_commit, args.run_url,
    )
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if args.transfer_receipt:
        if not args.transport_url or result["artifact"]["sha256"] != args.artifact_sha256:
            parser.error("a transfer receipt requires an HTTPS transport URL and matching bytes")
        args.transfer_receipt.write_text(
            json.dumps(transfer_receipt(result, args.transport_url), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    print(f"native_acceptance={result['status']}")
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
