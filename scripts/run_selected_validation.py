#!/usr/bin/env python3
"""Run the repository-owned commands for one validated change-scope plan."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

PLAN_SCHEMA = "change-scoped-validation-plan/v1"
HEX40 = re.compile(r"^[0-9a-f]{40}$")
KNOWN_GATES = {
    "artifact_identity", "build", "contract_tests", "docs_contract",
    "focused_tests", "full_candidate", "host_lock_tests", "lint",
    "package_tests", "stats_tests", "typecheck",
}


class RunSelectionError(ValueError):
    """Raised when a plan cannot be mapped to a closed command set."""


def command_key(command: Sequence[str]) -> tuple[str, ...]:
    return tuple(command)


def unique(commands: list[list[str]]) -> list[list[str]]:
    result: list[list[str]] = []
    seen: set[tuple[str, ...]] = set()
    for command in commands:
        key = command_key(command)
        if key not in seen:
            seen.add(key)
            result.append(command)
    return result


def validate_plan(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schema") != PLAN_SCHEMA:
        raise RunSelectionError(f"plan schema must be {PLAN_SCHEMA}")
    gates = value.get("gates")
    paths = value.get("changed_paths")
    if not isinstance(gates, list) or not gates or any(gate not in KNOWN_GATES for gate in gates):
        raise RunSelectionError("plan contains an empty or unknown gate set")
    if not isinstance(paths, list) or any(not isinstance(path, str) or not path for path in paths):
        raise RunSelectionError("plan changed_paths is invalid")
    for key in ("base_sha", "head_sha"):
        if value.get(key) is not None and not HEX40.fullmatch(value[key]):
            raise RunSelectionError(f"plan {key} is invalid")
    return value


def commands_for(value: Any) -> list[list[str]]:
    plan = validate_plan(value)
    gates = set(plan["gates"])
    commands: list[list[str]] = []
    if "full_candidate" in gates:
        commands.extend([
            ["pnpm", "run", "typecheck"],
            ["pnpm", "run", "lint"],
            ["pnpm", "test"],
            ["pnpm", "run", "test:release-pack"],
            ["pnpm", "run", "test:stats"],
            ["pnpm", "run", "build"],
            ["git", "diff", "--exit-code", "--", "dist"],
            ["pnpm", "run", "pack:check"],
            [sys.executable, "scripts/audit_repository_documentation.py", "."],
            [sys.executable, "-m", "unittest", "tests/audit_repository_documentation_test.py"],
        ])
    else:
        if "docs_contract" in gates:
            commands.extend([
                [sys.executable, "scripts/audit_repository_documentation.py", "."],
                [sys.executable, "-m", "unittest", "tests/audit_repository_documentation_test.py"],
            ])
        if "typecheck" in gates:
            commands.append(["pnpm", "run", "typecheck"])
        if "lint" in gates:
            commands.append(["pnpm", "run", "lint"])
        if "contract_tests" in gates:
            commands.append([
                "pnpm", "exec", "vitest", "run",
                "tests/domain/digest-v3.test.ts",
                "tests/domain/portable-semantics.test.ts",
            ])
        if "host_lock_tests" in gates:
            commands.append([
                "pnpm", "exec", "vitest", "run",
                "tests/domain/v030-host-lock.test.ts",
                "tests/domain/v032-host-cohort.test.ts",
            ])
        if "focused_tests" in gates:
            related = [
                path for path in plan["changed_paths"]
                if path.endswith((".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"))
            ]
            commands.append(
                ["pnpm", "exec", "vitest", "related", *related, "--run"]
                if related else ["pnpm", "test"]
            )
        if "stats_tests" in gates:
            commands.append(["pnpm", "run", "test:stats"])
        if {"artifact_identity", "package_tests"} & gates:
            commands.extend([
                ["pnpm", "run", "test:release-pack"],
                ["pnpm", "run", "pack:check"],
            ])
        if "build" in gates:
            commands.extend([
                ["pnpm", "run", "build"],
                ["git", "diff", "--exit-code", "--", "dist"],
            ])
    if plan.get("base_sha") and plan.get("head_sha"):
        commands.append(["git", "diff", "--check", plan["base_sha"], plan["head_sha"], "--"])
    return unique(commands)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan-json", required=True)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--list", action="store_true", dest="list_only")
    args = parser.parse_args(argv)
    try:
        commands = commands_for(json.loads(args.plan_json))
    except (json.JSONDecodeError, RunSelectionError) as exc:
        print(f"selected_validation=invalid: {exc}", file=sys.stderr)
        return 2
    if args.list_only:
        print(json.dumps(commands, indent=2))
        return 0
    for command in commands:
        print("+ " + " ".join(command), flush=True)
        result = subprocess.run(command, cwd=args.repo_root, check=False)
        if result.returncode:
            return result.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
