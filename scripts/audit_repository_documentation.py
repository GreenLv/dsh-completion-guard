#!/usr/bin/env python3
"""Audit deterministic structure of repository Markdown documentation."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import urlsplit

MARKDOWN_SUFFIXES = {".md", ".markdown"}
EXCLUDED_PARTS = {".git", "node_modules", "dist"}
LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
ANCHOR_RE = re.compile(r"^<a id=[\"']([^\"']+)[\"']", re.IGNORECASE)
HEADING_RE = re.compile(r"^#{1,6}\s+(.+?)\s*$")
VERSION_RE = re.compile(r"\b(?:v)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b")


@dataclass(frozen=True)
class Finding:
    level: str
    code: str
    path: str
    line: int | None
    message: str


def markdown_files(root: Path) -> list[Path]:
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file()
        and path.suffix.lower() in MARKDOWN_SUFFIXES
        and not EXCLUDED_PARTS.intersection(path.relative_to(root).parts)
    )


def anchor(value: str) -> str:
    return re.sub(r"[^a-z0-9 -]", "", value.lower()).strip().replace(" ", "-")


def audit(root: Path) -> dict[str, object]:
    root = root.resolve()
    findings: list[Finding] = []
    docs = markdown_files(root)
    known_paths = {path.resolve() for path in docs}

    if not (root / "README.md").is_file():
        findings.append(Finding("error", "missing-readme", "README.md", None, "README.md is missing"))
    if (root / "README.md").is_file() and (root / "README.zh-CN.md").is_file():
        findings.append(Finding("info", "localized-readme", "README.zh-CN.md", None, "English and Chinese README editions are present"))

    for path in docs:
        relative = path.relative_to(root).as_posix()
        text = path.read_text(encoding="utf-8")
        headings = {anchor(match.group(1)) for match in map(HEADING_RE.match, text.splitlines()) if match}
        headings.update(match.group(1).lower() for match in map(ANCHOR_RE.match, text.splitlines()) if match)
        for number, line in enumerate(text.splitlines(), 1):
            for raw_target in LINK_RE.findall(line):
                target = raw_target.strip().split(" ", 1)[0].strip("<>")
                if not target or target.startswith(("#", "mailto:", "http://", "https://")):
                    if target.startswith("#") and anchor(target[1:]) not in headings:
                        findings.append(Finding("error", "missing-anchor", relative, number, f"local anchor does not resolve: {target}"))
                    continue
                parsed = urlsplit(target)
                if parsed.scheme or parsed.netloc:
                    continue
                target_path, _, target_fragment = target.partition("#")
                candidate = (path.parent / target_path).resolve()
                if candidate.is_dir():
                    candidate = candidate / "README.md"
                if candidate not in known_paths and not candidate.is_file():
                    findings.append(Finding("error", "missing-link-target", relative, number, f"local link target does not exist: {target}"))
                elif target_fragment and candidate.suffix.lower() in MARKDOWN_SUFFIXES:
                    target_text = candidate.read_text(encoding="utf-8")
                    target_anchors = {anchor(match.group(1)) for match in map(HEADING_RE.match, target_text.splitlines()) if match}
                    target_anchors.update(match.group(1).lower() for match in map(ANCHOR_RE.match, target_text.splitlines()) if match)
                    if anchor(target_fragment) not in target_anchors:
                        findings.append(Finding("error", "missing-anchor", relative, number, f"local link anchor does not resolve: {target}"))

        if relative in {"CHANGELOG.md", "CHANGELOG.zh-CN.md"}:
            if "Unreleased" in text:
                findings.append(Finding("warning", "unreleased-section", relative, None, "changelog contains an Unreleased section"))
            versions = VERSION_RE.findall(text)
            if not versions:
                findings.append(Finding("warning", "missing-version", relative, None, "changelog contains no semantic version"))

    return {
        "root": str(root),
        "markdown_files": [path.relative_to(root).as_posix() for path in docs],
        "findings": [asdict(finding) for finding in findings],
        "errors": sum(finding.level == "error" for finding in findings),
        "warnings": sum(finding.level == "warning" for finding in findings),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="repository root to audit")
    parser.add_argument("--json", action="store_true", dest="as_json", help="emit JSON instead of a text summary")
    args = parser.parse_args(argv)
    if not args.root.is_dir():
        parser.error(f"repository root is not a directory: {args.root}")
    result = audit(args.root)
    if args.as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"Documentation audit: {result['root']}")
        print(f"Markdown files: {len(result['markdown_files'])}")
        print(f"Errors: {result['errors']}; warnings: {result['warnings']}")
        for finding in result["findings"]:
            location = finding["path"] + (f":{finding['line']}" if finding["line"] else "")
            print(f"{finding['level'].upper()} [{finding['code']}] {location}: {finding['message']}")
    return 1 if result["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
