"""Fail-closed dependency advisory gate (F10).

Runs `pnpm audit --json` and applies one fixed policy:

* Any `high` or `critical` advisory — production OR development — fails the
  gate. A test-chain advisory is still an unaccepted high/critical finding;
  accepting one requires the documented exception process, not a silent pass.
* `moderate` and `low` advisories are reported but do not block; they are
  development-chain noise unless separately accepted.
* A scan that cannot run (network failure, registry outage, malformed output)
  FAILS CLOSED: a missing scan must never read as "zero vulnerabilities".

Scanner severity is not product severity: reachability decides priority, and
an accepted exception must record advisory id, reachability rationale, owner
and expiry in docs/DEPENDENCY_SCAN.md before the underlying advisory can be
handled outside this gate.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

BLOCKING_SEVERITIES = ("critical", "high")
REPORTED_SEVERITIES = ("moderate", "low")


class AuditUnavailable(RuntimeError):
    """The advisory scan itself could not be completed."""


EXCEPTIONS_SCHEMA = "dsh-dependency-scan-exceptions/v1"
DATE = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"


def load_exceptions(path: Path) -> dict[tuple[str, str, str], dict[str, str]]:
    """Load the accepted-exception table keyed by (id, module, version).

    Malformed, unparseable or expired entries raise AuditUnavailable — the
    exception mechanism can only ever REMOVE a documented, current, matching
    advisory from the blocking set, never weaken the fail-closed default.
    """
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AuditUnavailable(f"cannot read exception table {path}: {exc}") from exc
    if not isinstance(raw, dict) or raw.get("schema") != EXCEPTIONS_SCHEMA or not isinstance(raw.get("exceptions"), list):
        raise AuditUnavailable("exception table is not a valid dsh-dependency-scan-exceptions/v1 document")
    import datetime as _dt
    import re as _re

    today = _dt.date.today()
    table: dict[tuple[str, str, str], dict[str, str]] = {}
    for entry in raw["exceptions"]:
        if not isinstance(entry, dict):
            raise AuditUnavailable("exception entry is not an object")
        required = ("id", "module", "version", "severity", "rationale", "owner", "expires")
        if any(not isinstance(entry.get(field), str) or not entry[field] for field in required):
            raise AuditUnavailable("exception entry is missing a required field")
        if not _re.match(DATE, entry["expires"]):
            raise AuditUnavailable(f"exception {entry['id']} expiry is not a YYYY-MM-DD date")
        try:
            expiry = _dt.date.fromisoformat(entry["expires"])
        except ValueError as exc:
            raise AuditUnavailable(f"exception {entry['id']} expiry is not a real date") from exc
        if expiry < today:
            raise AuditUnavailable(f"exception {entry['id']} ({entry['module']}) EXPIRED on {entry['expires']}; the advisory is blocking again")
        table[(entry["id"], entry["module"], entry["version"])] = entry
    return table


def evaluate_audit(report: Any) -> dict[str, list[dict[str, str]]]:
    """Classify one parsed `pnpm audit --json` report.

    Returns per-severity rows. Raises AuditUnavailable for any shape this
    reader cannot interpret — unknown shapes fail closed like scan errors.
    """
    if not isinstance(report, dict):
        raise AuditUnavailable("audit report is not a JSON object")
    advisories = report.get("advisories")
    if not isinstance(advisories, dict):
        raise AuditUnavailable("audit report has no advisories object")
    rows: dict[str, list[dict[str, str]]] = {severity: [] for severity in (*BLOCKING_SEVERITIES, *REPORTED_SEVERITIES)}
    for advisory in advisories.values():
        if not isinstance(advisory, dict):
            raise AuditUnavailable("advisory entry is not an object")
        severity = str(advisory.get("severity", "")).lower()
        findings = advisory.get("findings")
        installed = findings[0].get("version") if isinstance(findings, list) and findings and isinstance(findings[0], dict) else None
        if not isinstance(installed, str) or not installed:
            raise AuditUnavailable(f"advisory for {advisory.get('module_name', '?')} has no installed version")
        row = {
            "module": str(advisory.get("module_name", "?")),
            "version": installed,
            "title": str(advisory.get("title", "?"))[:120],
            "id": str(advisory.get("id", advisory.get("url", "?"))),
            "dev": "dev" if advisory.get("dev") else "prod",
        }
        if severity in rows:
            rows[severity].append(row)
        # Unknown severities (future scanner vocabulary) fail closed at the
        # caller via the missing-severity check below.
        else:
            raise AuditUnavailable(f"unknown advisory severity: {severity!r}")
    return rows


def run_audit(repo_root: Path) -> Any:
    completed = subprocess.run(
        ["pnpm", "audit", "--json"],
        cwd=repo_root,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    raw = completed.stdout.strip()
    if not raw:
        raise AuditUnavailable(
            f"pnpm audit produced no JSON (exit={completed.returncode}, stderr={completed.stderr.strip()[:200]!r})"
        )
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise AuditUnavailable(f"pnpm audit output is not valid JSON: {exc}") from exc


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path("."))
    parser.add_argument(
        "--report",
        type=Path,
        default=None,
        help="Evaluate a saved `pnpm audit --json` report instead of running pnpm (CI and tests).",
    )
    parser.add_argument("--exceptions", type=Path, default=None)
    args = parser.parse_args(argv)
    if args.exceptions is None:
        args.exceptions = args.repo_root / "scripts" / "dependency-scan-exceptions.json"
    try:
        exceptions = load_exceptions(args.exceptions)
        if args.report is not None:
            report = json.loads(args.report.read_text(encoding="utf-8"))
        else:
            report = run_audit(args.repo_root)
        rows = evaluate_audit(report)
    except (AuditUnavailable, OSError, json.JSONDecodeError) as exc:
        print(f"dependency-scan: FAILED CLOSED — the scan did not complete: {exc}", file=sys.stderr)
        return 2
    blocking: list[tuple[str, dict[str, str]]] = []
    accepted: list[tuple[str, dict[str, str]]] = []
    for severity in BLOCKING_SEVERITIES:
        for row in rows[severity]:
            entry = exceptions.get((row["id"], row["module"], row["version"]))
            if entry is not None and entry["severity"] == severity:
                accepted.append((severity, row))
            else:
                blocking.append((severity, row))
    for severity in REPORTED_SEVERITIES:
        for row in rows[severity]:
            print(f"dependency-scan: reported {severity} ({row['dev']}): {row['module']} — {row['title']} [{row['id']}]")
    for severity, row in accepted:
        print(f"dependency-scan: ACCEPTED {severity} ({row['dev']}): {row['module']}@{row['version']} — {row['title']} [{row['id']}] (documented exception)")
    if blocking:
        for severity, row in blocking:
            print(f"dependency-scan: BLOCKING {severity} ({row['dev']}): {row['module']}@{row['version']} — {row['title']} [{row['id']}]")
        print(
            "dependency-scan: FAILED — unaccepted high/critical advisories block the candidate. "
            "Upgrade the affected chain, or record an exception (advisory, reachability, owner, expiry) in "
            "docs/DEPENDENCY_SCAN.md.",
            file=sys.stderr,
        )
        return 1
    print("dependency-scan: PASS — no unaccepted high/critical advisories.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
