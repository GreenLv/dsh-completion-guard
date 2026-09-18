#!/usr/bin/env python3
"""Record the Codex Context Guard cross-end oracle facts (0.6.2 D062-04).

This script EXECUTES the real Codex Context Guard entry points against a locally
installed module and writes the measured result to
`tests/fixtures/cross-end/codex-<version>.facts.json`. It never imports a
hand-written expectation: the recorded file is what the entry points actually
returned.

Read-only contract: the script imports the plugin module (which has no
import-time side effects) and calls `clause_metadata` and
`verification_contract` with synthetic, in-memory inputs. It does not read or
write Codex private state, sessions, transcripts, or credentials, and the contract/behaviour modes do not invoke lifecycle hooks. Lifecycle
mode creates disposable synthetic ledgers through product-owned hooks, never
reads a user session, and exports only stable sanitized observations.

The module path may be given explicitly; otherwise the script searches the
default Codex plugin cache for the requested version.

Usage:
  python3 scripts/record_cross_end_oracle.py --codex-version 0.13.9
  python3 scripts/record_cross_end_oracle.py --module /path/to/context_guard.py

Exit codes: 0 recorded (or already-current), 1 module not found, 2 shape drift
(the installed module no longer exposes the audited entry points).
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = REPO_ROOT / "tests" / "fixtures" / "cross-end"


def display(path: Path) -> str:
    """Show a repository-relative path when it is inside the repo, and an
    absolute path otherwise (an explicit --output is not required to be)."""
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path)

# Synthetic inputs only: neutral task families, no private session content.
CASES: list[tuple[str, str]] = [
    ("cleanup-zh", "清理构建缓存目录"),
    ("cleanup-en", "delete the build output directory"),
    ("archive-zh", "把工作树归档到 backup/archived"),
    ("readonly-check", "运行 pnpm test"),
    ("commit-push-zh", "提交并推送变更"),
    ("prohibition-zh", "不要推送"),
]

REQUIRED_FUNCTIONS = ("clause_metadata", "verification_contract")

# Result-behaviour entry points (0.6.2 review): the comparison needs more than
# contract derivation. Each entry declares what it needs to run at all, so a
# version whose private-state machinery follows a different contract records an
# explicit `not_executed` instead of a fabricated success.
BEHAVIOUR_REQUIRING_VALID_INTEGRITY = ("derive_ordinary_proofs", "_auto_complete_checkpoint")
BEHAVIOUR_REQUIRING_PROMPT_LEDGER = ("handle_stop",)


def find_module(explicit: str | None, version: str) -> Path | None:
    if explicit:
        candidate = Path(explicit).expanduser()
        return candidate if candidate.is_file() else None
    cache = Path.home() / ".codex" / "plugins" / "cache" / "codex-context-guard" / "context-guard"
    direct = cache / version / "scripts" / "context_guard.py"
    if direct.is_file():
        return direct
    if not cache.is_dir():
        return None
    return None  # Never substitute another installed version for the requested one.


def load(path: Path):
    spec = importlib.util.spec_from_file_location("codex_context_guard_oracle_probe", path)
    if spec is None or spec.loader is None:
        print(f"cannot load module at {path}", file=sys.stderr)
        raise SystemExit(2)
    module = importlib.util.module_from_spec(spec)
    # The module guards its CLI behind `if __name__ == "__main__"`, so importing
    # it executes no command.
    spec.loader.exec_module(module)
    return module


def synthetic_state(module) -> dict:
    """A structurally valid, in-memory state: enabled mode, usable integrity, one
    pending requirement whose contract is derived by the module's OWN classifier
    and contract builder. Nothing is read from or written to Codex storage."""
    text = "Run pnpm test and verify /repo/report.md exists."
    clauses = module.clause_metadata(text)
    contract = module.verification_contract("R001", text, {"assets": []}, [], clauses=clauses)
    return {
        "mode": {"active": True, "manual_off": False},
        "integrity": {"status": "ok"},
        "session": {"id": "synthetic-cross-end", "format_version": getattr(module, "SCHEMA_VERSION", 0)},
        "requirements": [{
            "id": "R001", "status": "open", "text": text, "prompt_id": "P1",
            "evidence": [], "verification_contract": contract,
        }],
        "acceptance_items": [],
        "proofs": [],
        "evidence": [],
        "prompts": [{"id": "P1", "origin": "human", "text": text, "turn_id": "t1"}],
        "completion_attempt": None,
    }


def unusable_integrity_state(module) -> dict:
    """The same shape with an integrity status the product has declared
    unusable. This is the one stop-path state that needs no durable ledger, so
    the hard-stop branch is measurable in every environment."""
    state = synthetic_state(module)
    state["integrity"] = {"status": "corrupt", "issue": "synthetic cross-end probe"}
    return state


def record_behaviour(module, path: Path) -> dict:
    """Measure the result-behaviour entry points on synthetic in-memory states.

    `derive_ordinary_proofs` and `_auto_complete_checkpoint` run on a synthetic
    state because they are pure over it. `handle_stop` needs the durable
    authoritative prompt ledger that a real session owns, so its correction,
    pending and wait behaviour is recorded as NOT executed here: this probe never
    creates or reads a Codex session, and a fabricated correction result would be
    worse than an honest gap.
    """
    cases = []

    def add(case_id: str, entry: str, run) -> None:
        try:
            result, note = run()
            cases.append({"id": case_id, "entry": entry, "status": "executed", "result": result, "note": note})
        except Exception as exc:  # noqa: BLE001 - the recorded failure IS the fact
            cases.append({
                "id": case_id, "entry": entry, "status": "not_executed",
                "error": f"{type(exc).__name__}: {exc}",
                "note": "the entry point is present but this environment cannot satisfy its preconditions",
            })

    for name in BEHAVIOUR_REQUIRING_VALID_INTEGRITY:
        if not hasattr(module, name):
            cases.append({"id": name, "entry": name, "status": "absent", "note": "entry point not exposed"})
            continue
        if name == "derive_ordinary_proofs":
            # A requirement with an enforced contract but no bound evidence: the
            # derivation must return nothing rather than invent a proof.
            add("proofs-without-bound-evidence", name, lambda: (
                module.derive_ordinary_proofs(synthetic_state(module)),
                "an enforced contract with NO bound evidence derives zero proofs",
            ))
        else:
            # The private-state checkpoint must refuse completion when nothing
            # uniquely binds the scoped item.
            add("checkpoint-without-unique-evidence", name, lambda: (
                module._auto_complete_checkpoint(synthetic_state(module), {"R001"}),
                "no unique evidence: completion is refused (None), never fabricated",
            ))

    for name in BEHAVIOUR_REQUIRING_PROMPT_LEDGER:
        # Only the hard-stop branch is reachable without a durable ledger. The
        # correction / pending / wait behaviour needs the authoritative prompt
        # ledger a real session owns, so it stays explicitly unmeasured.
        if hasattr(module, name):
            add("stop-on-unusable-state", name, lambda: (
                module.handle_stop(Path("/nonexistent-synthetic-session"), unusable_integrity_state(module), {"text": "", "turn_id": "t1"}),
                "an unusable private state is a hard stop: the module refuses to certify anything",
            ))
        cases.append({
            "id": name, "entry": name, "status": "not_executed",
            "note": (
                "requires the durable authoritative prompt ledger owned by a real session; this probe creates and "
                "reads no Codex session, so correction, pending and wait behaviour stays unmeasured here and is NOT "
                "claimed as compared."
            ),
        })

    return {
        "recordingVersion": "1",
        "product": "codex-context-guard",
        "productVersion": module.PRODUCT_VERSION,
        "moduleSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "stateConstruction": "in-memory synthetic state; the requirement's contract is built by the module's own clause_metadata/verification_contract",
        "cases": cases,
    }


def record(module, path: Path) -> dict:
    missing = [name for name in REQUIRED_FUNCTIONS if not hasattr(module, name)]
    if missing:
        print(f"audited entry points missing from {path}: {missing}", file=sys.stderr)
        raise SystemExit(2)
    cases = []
    for case_id, text in CASES:
        clauses = module.clause_metadata(text)
        contract = module.verification_contract("R001", text, {"assets": []}, [], clauses=clauses)
        cases.append({
            "id": case_id,
            "text": text,
            "contract_mode": contract.get("mode"),
            "contract_reason": contract.get("reason"),
            "obligations": len(contract.get("obligations") or []),
            "clause_operations": [clause.get("operation") for clause in clauses.get("clauses", [])],
        })
    return {
        "recordingVersion": "1",
        "product": "codex-context-guard",
        "productVersion": module.PRODUCT_VERSION,
        "stopProtocolVersion": module.STOP_PROTOCOL_VERSION,
        "proofProtocolVersion": module.PROOF_PROTOCOL_VERSION,
        "clauseClassifierVersion": module.CLASSIFIER_VERSION,
        "moduleSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "entryPoints": {
            "contract": "verification_contract(item_id, text, state, asset_ids, clauses=clause_metadata(text))",
            "proofs": "derive_ordinary_proofs(state)",
            "checkpoint": "_auto_complete_checkpoint(...)",
            "stop": "handle_stop(...)",
        },
        "executedHere": ["clause_metadata", "verification_contract"],
        "readOnly": ["derive_ordinary_proofs", "_auto_complete_checkpoint", "handle_stop"],
        "note": (
            "Facts measured by executing the real entry points against an installed module. "
            "This is a function-level probe, not a native Codex task acceptance, and it does not "
            "generalise to every phrasing."
        ),
        "cases": cases,
    }


LIFECYCLE_CASES = [
    ("silent-pending", "清理构建缓存目录", "已报告可观察结果，未认证。", None),
    ("correction", "Verify /repo/report.md exists.", "Everything is complete.", None),
    ("user-wait", "等待我确认后再推送。", "等待你的确认。", None),
    ("mixed-results", "清理工作树", "部分移除，仍有失败对象，未认证。", {
        "command": "git worktree remove a; git worktree remove b; git worktree list",
        "output": "removed a\nremove of b failed\n", "exit_code": 0,
    }),
]


def record_lifecycle(module, path: Path) -> dict:
    """Use only product-owned entrypoints and disposable synthetic ledgers.

    Never load an existing session or emit tokens/raw ledger files. Only the
    stable observed facts below leave the temporary directory.
    """
    cases = []
    for case_id, prompt, reply, run in LIFECYCLE_CASES:
        with tempfile.TemporaryDirectory(prefix="dsh-cross-end-") as directory:
            root = Path(directory)
            state = module.new_state({"session_id": "synthetic-cross-end", "cwd": directory})
            module.handle_user_prompt(root, state, {"prompt": "context-guard on", "turn_id": "setup"})
            module.handle_user_prompt(root, state, {"prompt": prompt, "turn_id": "t1"})
            if not module.latest_requirement_text(root, state):
                raise ValueError("synthetic prompt ledger did not verify")
            if run:
                module.handle_post_tool(root, state, {
                    "tool_name": "exec_command", "turn_id": "t1",
                    "tool_input": {"command": run["command"]},
                    "tool_response": {"output": run["output"], "exit_code": run["exit_code"]},
                })
            proofs = module.derive_ordinary_proofs(state)
            checkpoint = module._auto_complete_checkpoint(state, {item["id"] for item in state["requirements"]})
            result = module.handle_stop(root, state, {"last_assistant_message": reply, "turn_id": "t1"})
            decision = state["decision_log"][-1]
            cases.append({
                "id": case_id, "prompt": prompt, "reply": reply, "run": run,
                "promptVerified": True, "toolEvidenceCount": len(state["evidence"]),
                "proofCount": len(proofs), "checkpoint": checkpoint,
                "silent": result == {}, "correction": result.get("decision") == "block",
                "pending": sum(item["status"] == "pending" for item in state["requirements"]),
                "outcome": decision["outcome"], "reasonCodes": decision["reason_codes"],
            })
    return {"recordingVersion": "1", "productVersion": module.PRODUCT_VERSION,
            "moduleSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "stateConstruction": "product-owned prompt entrypoint in disposable synthetic ledger",
            "cases": cases}


# 0.6.3 T08: the shared semantic inputs of the core-alignment batch. Each is run
# through the module's OWN reply-only delivery judge and clause classifier, so
# the DSH side can be compared against a measured Codex fact instead of a claim.
SHAPE_CASES: list[tuple[str, str]] = [
    ("mixed-comma-run-zh", "更新插件，检查是否存在更新，安装新主题，记录变更。"),
    ("mixed-comma-run-en", "Install the package, check whether an update exists, and write a report."),
    ("mixed-conjunction-zh", "检查是否有更新并安装新主题。"),
    ("mixed-conjunction-en", "Check whether an update exists and install the package."),
    ("pure-question-zh", "检查一下插件是否有更新吗？"),
    ("pure-question-en", "Is there any update for the plugin?"),
    ("suggestion-particle-zh", "安装新主题吧。"),
    ("conditional-tail-en", "Install the package if available."),
    ("quoted-command-zh", "说明 `git push origin main` 的作用，然后更新 README。"),
    ("plain-directive-zh", "更新插件。"),
    ("plain-directive-en", "Install the package."),
    ("unnamed-repository-zh", "提交并推送变更"),
]


def record_shape(module, path: Path) -> dict:
    """Measure the reply-only delivery judgement and the clause classifier.

    `_reply_only_request_shape` is the module's own gate for closing a request
    through the turn's final answer alone. Recording it per input is what makes
    the DSH/Codex comparison a measured fact rather than an inference: an input
    the DSH side keeps executable while Codex would close it is the dangerous
    direction, and it must be visible as such.
    """
    if not hasattr(module, "_reply_only_request_shape"):
        print(f"the audited delivery judge is missing from {path}", file=sys.stderr)
        raise SystemExit(2)
    cases = []
    for case_id, text in SHAPE_CASES:
        clauses = module.clause_metadata(text)
        contract = module.verification_contract("R001", text, {"assets": []}, [], clauses=clauses)
        cases.append({
            "id": case_id,
            "text": text,
            "reply_only_request_shape": bool(module._reply_only_request_shape(text)),
            "contract_mode": contract.get("mode"),
            "contract_reason": contract.get("reason"),
            "obligations": len(contract.get("obligations") or []),
            "clause_operations": [clause.get("operation") for clause in clauses.get("clauses", [])],
        })
    return {
        "recordingVersion": "1",
        "product": "codex-context-guard",
        "productVersion": module.PRODUCT_VERSION,
        "moduleSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "entryPoint": "_reply_only_request_shape(text) plus clause_metadata/verification_contract",
        "executedHere": ["_reply_only_request_shape", "clause_metadata", "verification_contract"],
        "note": (
            "Facts measured by executing the real entry points against an installed module. "
            "The delivery judgement decides only whether the turn's final answer may close the "
            "request; it is not an obligation projection, and this is a function-level probe, "
            "not a native Codex task acceptance."
        ),
        "cases": cases,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--module", help="path to the Codex context_guard.py to probe")
    parser.add_argument("--codex-version", default="0.13.9", help="version to look up in the Codex plugin cache")
    parser.add_argument("--output", help="output path (default tests/fixtures/cross-end/codex-<version>.facts.json)")
    parser.add_argument("--check", action="store_true", help="compare without writing; exit 1 on drift")
    parser.add_argument("--mode", choices=("contract", "behaviour", "lifecycle", "shape"), default="contract",
                        help="contract facts (default), result-behaviour facts, lifecycle facts, or the reply-only shape probe")
    args = parser.parse_args()

    path = find_module(args.module, args.codex_version)
    if path is None:
        print(f"codex-context-guard {args.codex_version} is not installed; nothing recorded", file=sys.stderr)
        return 1

    module = load(path)
    payload = record(module, path)
    if args.mode == "lifecycle":
        payload = record_lifecycle(module, path)
        default_name = f"codex-{payload['productVersion']}.lifecycle.json"
    elif args.mode == "behaviour":
        payload = record_behaviour(module, path)
        default_name = f"codex-{payload['productVersion']}.behaviour.json"
    elif args.mode == "shape":
        payload = record_shape(module, path)
        default_name = f"codex-{payload['productVersion']}.shape.json"
    else:
        default_name = f"codex-{payload['productVersion']}.facts.json"
    output = Path(args.output) if args.output else OUTPUT_DIR / default_name
    rendered = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    previous = output.read_text() if output.is_file() else None
    if args.check:
        if previous == rendered:
            print(f"current: {output} matches codex-context-guard {payload['productVersion']}")
            return 0
        print("DRIFT: the recorded facts do not match this module", file=sys.stderr)
        if previous is None:
            print(f"  the recording does not exist at {output}", file=sys.stderr)
        return 1
    output.parent.mkdir(parents=True, exist_ok=True)
    if previous == rendered:
        print(f"already current: {display(output)} (codex-context-guard {payload['productVersion']})")
        return 0
    output.write_text(rendered)
    print(f"recorded {display(output)} from codex-context-guard {payload['productVersion']} ({path})")
    return 0


if __name__ == "__main__":
    os.environ.setdefault("PYTHONHASHSEED", "0")
    raise SystemExit(main())
