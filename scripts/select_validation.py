"""Select deterministic validation gates from an exact outgoing Git diff."""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import re
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path, PurePosixPath
from typing import Any

MAP_SCHEMA = "change-scoped-validation-map/v1"
PLAN_SCHEMA = "change-scoped-validation-plan/v1"
HEX40 = re.compile(r"^[0-9a-f]{40}$")
IDENTIFIER = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

# The short matrix is deliberately an explicit, reviewed subset. Expanding it
# requires checking platform, loader, protocol and fixture consumers. Unknown
# source or test changes keep the full matrix, even when the gate map knows the
# path. Committed build output is eligible only alongside its reviewed source.
PORTABLE_SOURCE = {"src/domain/parse-cache.ts"}
PORTABLE_TESTS = {"tests/v083-parse-cache.test.ts"}
DOCUMENT_NAMES = {"AGENTS.md", "README.md", "README.zh-CN.md", "CHANGELOG.md",
                  "CHANGELOG.zh-CN.md", "LICENSE"}
MATRIX_HIGH_RISK_RULES = {
    "shared_conformance", "core_v2_conformance", "conformance_tests", "host_lock",
    "host_version_contract", "host_lock_tests", "packaging", "repository_identity",
    "native_acceptance_infrastructure", "validation_infrastructure", "cross_end_oracle",
    "legacy_upgrade_recording", "host_audit_tooling",
}
PLATFORM_REFERENCE = re.compile(
    r"\b(?:import|require|process|globalThis|Buffer|eval|Function|WebAssembly|fetch|"
    r"XMLHttpRequest|WebSocket|Worker|Deno|Bun|module|__dirname|__filename)\b|node:|node_modules|\.node\b"
)


class SelectionError(ValueError):
    """Raised when a map or requested diff is unsafe."""


def safe_path(value: str, label: str) -> str:
    if not value or "\\" in value or value.startswith("/") or "\x00" in value:
        raise SelectionError(f"{label} must be a repository-relative POSIX path")
    if any(part in {"", ".", ".."} for part in PurePosixPath(value).parts):
        raise SelectionError(f"{label} contains an unsafe component")
    return value


def ids(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or len(value) > 128:
        raise SelectionError(f"{label} must be a bounded list")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str) or not IDENTIFIER.fullmatch(item):
            raise SelectionError(f"{label} contains an invalid ID")
        if item in result:
            raise SelectionError(f"{label} contains duplicate IDs")
        result.append(item)
    return result


def load_map(path: Path) -> tuple[dict[str, Any], str]:
    try:
        raw = path.read_bytes()
        value = json.loads(raw.decode("utf-8", errors="strict"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise SelectionError(f"cannot read validation map: {exc}") from exc
    if not isinstance(value, dict) or set(value) != {"schema", "full_gate", "default", "rules"}:
        raise SelectionError("validation map must contain schema, full_gate, default, and rules")
    if value["schema"] != MAP_SCHEMA:
        raise SelectionError(f"validation map schema must be {MAP_SCHEMA}")
    if not isinstance(value["full_gate"], str) or not IDENTIFIER.fullmatch(value["full_gate"]):
        raise SelectionError("full_gate must be a valid ID")
    default = value["default"]
    if not isinstance(default, dict) or set(default) != {"gates", "invalidates"}:
        raise SelectionError("validation map default is invalid")
    default_gates = ids(default["gates"], "default.gates")
    ids(default["invalidates"], "default.invalidates")
    if value["full_gate"] not in default_gates:
        raise SelectionError("default.gates must include full_gate for fail-closed selection")
    rules = value["rules"]
    if not isinstance(rules, list) or not rules or len(rules) > 256:
        raise SelectionError("validation map rules must be a non-empty bounded list")
    seen: set[str] = set()
    for index, rule in enumerate(rules):
        if not isinstance(rule, dict) or set(rule) != {"id", "paths", "gates", "invalidates", "contracts", "peer_gates"}:
            raise SelectionError(f"rules[{index}] has unexpected fields")
        if not isinstance(rule["id"], str) or not IDENTIFIER.fullmatch(rule["id"]) or rule["id"] in seen:
            raise SelectionError(f"rules[{index}].id is invalid or duplicate")
        seen.add(rule["id"])
        if not isinstance(rule["paths"], list) or not rule["paths"] or len(rule["paths"]) > 128:
            raise SelectionError(f"rules[{index}].paths must be a non-empty bounded list")
        if len(rule["paths"]) != len(set(rule["paths"])):
            raise SelectionError(f"rules[{index}].paths contains duplicates")
        for pattern in rule["paths"]:
            if not isinstance(pattern, str):
                raise SelectionError(f"rules[{index}].paths contains non-text")
            safe_path(pattern, f"rules[{index}].paths")
        ids(rule["gates"], f"rules[{index}].gates")
        ids(rule["invalidates"], f"rules[{index}].invalidates")
        ids(rule["contracts"], f"rules[{index}].contracts")
        if not isinstance(rule["peer_gates"], dict) or len(rule["peer_gates"]) > 32:
            raise SelectionError(f"rules[{index}].peer_gates is invalid")
        for peer, gates in rule["peer_gates"].items():
            if not isinstance(peer, str) or not IDENTIFIER.fullmatch(peer):
                raise SelectionError(f"rules[{index}].peer_gates has an invalid peer")
            ids(gates, f"rules[{index}].peer_gates.{peer}")
    return value, hashlib.sha256(raw).hexdigest()


def changed_paths(root: Path, base: str, head: str) -> list[str]:
    if not HEX40.fullmatch(base) or not HEX40.fullmatch(head):
        raise SelectionError("base and head must be full lowercase Git SHA-1 values")
    result = subprocess.run(["git", "-C", str(root), "diff", "--name-only", "--no-renames", "--diff-filter=ACDMRTUXB", base, head, "--"], text=True, capture_output=True, check=False)
    if result.returncode:
        raise SelectionError(result.stderr.strip() or "git command failed")
    return sorted({safe_path(line, "changed path") for line in result.stdout.splitlines() if line})


def classify(mapping: dict[str, Any], paths: list[str], *, map_sha256: str, base: str | None, head: str | None) -> dict[str, Any]:
    for label, value in (("base", base), ("head", head)):
        if value is not None and not HEX40.fullmatch(value):
            raise SelectionError(f"{label} must be a full lowercase Git SHA-1")
    if not re.fullmatch(r"[0-9a-f]{64}", map_sha256):
        raise SelectionError("map_sha256 is invalid")
    normalized = sorted({safe_path(path, "changed path") for path in paths})
    gates: set[str] = set()
    invalidates: set[str] = set()
    contracts: set[str] = set()
    matched: set[str] = set()
    peer_gates: dict[str, set[str]] = {}
    unknown: list[str] = []
    for path in normalized:
        matches = [rule for rule in mapping["rules"] if any(fnmatch.fnmatchcase(path, pattern) for pattern in rule["paths"])]
        if not matches:
            unknown.append(path)
            gates.update(mapping["default"]["gates"])
            invalidates.update(mapping["default"]["invalidates"])
            continue
        for rule in matches:
            matched.add(rule["id"])
            gates.update(rule["gates"])
            invalidates.update(rule["invalidates"])
            contracts.update(rule["contracts"])
            for peer, values in rule["peer_gates"].items():
                peer_gates.setdefault(peer, set()).update(values)
    return {"schema": PLAN_SCHEMA, "map_sha256": map_sha256, "base_sha": base, "head_sha": head, "changed_paths": normalized, "matched_rules": sorted(matched), "gates": sorted(gates), "invalidates": sorted(invalidates), "contracts": sorted(contracts), "peer_gates": {peer: sorted(values) for peer, values in sorted(peer_gates.items())}, "unknown_paths": unknown, "full_required": mapping["full_gate"] in gates or bool(unknown)}


def portable_changes_are_safe(root: Path | None, plan: dict[str, Any], paths: set[str]) -> bool:
    """Reject new platform references and unreadable base/head objects.

    This conservative lexical screen complements the explicit file allowlist;
    it does not replace review of the actual code and test changes.
    """
    base, head = plan.get("base_sha"), plan.get("head_sha")
    if root is None or not isinstance(base, str) or not isinstance(head, str):
        return False
    if not HEX40.fullmatch(base) or not HEX40.fullmatch(head):
        return False
    try:
        for path in paths.intersection(PORTABLE_SOURCE):
            for revision in (base, head):
                source = subprocess.run(["git", "-C", str(root), "show", f"{revision}:{path}"],
                                        capture_output=True, check=True, text=True, encoding="utf-8")
                if PLATFORM_REFERENCE.search(source.stdout):
                    return False
        for path in paths.intersection(PORTABLE_TESTS):
            for revision in (base, head):
                subprocess.run(["git", "-C", str(root), "cat-file", "-e", f"{revision}:{path}"],
                               capture_output=True, check=True)
            diff = subprocess.run(["git", "-C", str(root), "diff", "--no-ext-diff", "--no-textconv",
                                   "--unified=0", base, head, "--", path],
                                  capture_output=True, check=True, text=True, encoding="utf-8")
            if any(line.startswith("-") and not line.startswith("---") for line in diff.stdout.splitlines()):
                return False
            added = "\n".join(line[1:] for line in diff.stdout.splitlines()
                              if line.startswith("+") and not line.startswith("+++"))
            if PLATFORM_REFERENCE.search(added):
                return False
    except (OSError, UnicodeError, subprocess.SubprocessError):
        return False
    return True


def full_portability_matrix(plan: dict[str, Any], root: Path | None = None) -> bool:
    """Escalate unless every changed input is in a reviewed short-matrix class."""
    if plan["full_required"] or plan["unknown_paths"] or plan["contracts"]:
        return True
    if MATRIX_HIGH_RISK_RULES.intersection(plan["matched_rules"]):
        return True
    paths = set(plan["changed_paths"])
    if paths.intersection(PORTABLE_SOURCE | PORTABLE_TESTS) and not portable_changes_are_safe(root, plan, paths):
        return True
    for path in paths:
        if path in PORTABLE_SOURCE or path in PORTABLE_TESTS or path in DOCUMENT_NAMES:
            continue
        if path.startswith("docs/") or path.startswith("assets/"):
            continue
        if path.startswith("dist/") and paths.intersection(PORTABLE_SOURCE):
            continue
        return True
    return False


def write_github_outputs(path: Path, plan: dict[str, Any], root: Path) -> None:
    values = {"plan": json.dumps(plan, separators=(",", ":"), sort_keys=True), "gates": json.dumps(plan["gates"], separators=(",", ":")), "invalidates": json.dumps(plan["invalidates"], separators=(",", ":")), "full_required": str(plan["full_required"]).lower(), "full_matrix": str(full_portability_matrix(plan, root)).lower(), "unknown_paths": json.dumps(plan["unknown_paths"], separators=(",", ":"))}
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        for key, value in values.items():
            handle.write(f"{key}={value}\n")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--map", dest="map_path", type=Path)
    parser.add_argument("--base")
    parser.add_argument("--head")
    parser.add_argument("--path", action="append", default=[])
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args(argv)
    root = args.repo_root.resolve()
    try:
        mapping, map_sha256 = load_map((args.map_path or root / "validation-map.json").resolve())
        paths = args.path
        if not paths:
            if not args.base or not args.head:
                raise SelectionError("provide --path or both --base and --head")
            paths = changed_paths(root, args.base, args.head)
        plan = classify(mapping, paths, map_sha256=map_sha256, base=args.base, head=args.head)
        if args.github_output:
            write_github_outputs(args.github_output, plan, root)
        print(json.dumps(plan, indent=2, sort_keys=True))
    except SelectionError as exc:
        print(f"validation_selection=invalid: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
