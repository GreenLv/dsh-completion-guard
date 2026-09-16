# Cross-end result contract (0.6.2 D062-04)

The planned bounded function-level comparison is now measured. Native T06 and
exact-artifact host acceptance remain separate release gates. This is not full
product parity, and no upstream fixture or digest pin changes.

## Inputs and measured paths

Codex Context Guard 0.13.9 is loaded from the installed module. Each recording
binds its `moduleSha256`. Only synthetic inputs are used; the lifecycle mode
creates and removes its own temporary ledger through `new_state` and
`handle_user_prompt`. It never reads a user's session or exports raw ledgers,
control tokens, timestamps or temporary paths.

| Recording | Executed paths | Evidence boundary |
| --- | --- | --- |
| `codex-0.13.9.facts.json` | `clause_metadata`, `verification_contract` | Six exact contract inputs; no generalization to every phrase |
| `codex-0.13.9.behaviour.json` | `derive_ordinary_proofs`, `_auto_complete_checkpoint`, corrupt-state `handle_stop` | Negative proof and checkpoint cases; its in-memory-only stop gap remains recorded honestly |
| `codex-0.13.9.lifecycle.json` | Prompt ingestion, verified durable prompt readback, optional `handle_post_tool`, proof derivation, checkpoint and `handle_stop` | Four fresh disposable-ledger cases close the previous lifecycle gap |

The earlier assumption that lifecycle checks required an existing real user
session was too restrictive. A product-created synthetic ledger satisfies the
same prompt-integrity check without touching private user state.

## Cross-end assertions

`tests/domain/v062-codex-oracle.test.ts` reads the recorded prompt and command
bytes and passes them to DSH derivation, checkpoint and boundary entrypoints.
The host-specific result wrappers remain distinct.

| Case | Codex observation | DSH observation |
| --- | --- | --- |
| Ordinary cleanup, honestly uncertified | Silent end, pending retained, zero proofs | Safe end, pending retained, incomplete checkpoint |
| Missing readback, false whole-completion reply | Visible Stop correction, pending retained | Explicit checkpoint refuses completion; DSH does not parse the same reply at Stop |
| Wait for user confirmation | Silent user boundary, pending retained | Root wait remains unreleased, incomplete checkpoint |
| Identical opaque command with intermediate failure and final success | One tool evidence, zero proofs, no automatic checkpoint, pending retained | Unknown operation attribution, no certificate, pending retained |

The mixed-result case replays observations; it does not execute the destructive
command. A structured per-operation subset is separately tested on DSH and is
never promoted to a certifying producer. Zero proof and refusal cases establish
those negative boundaries, not positive certification coverage.

## Reproduce

From the repository root, with Python 3.11+ and the installed 0.13.9 module:

```sh
python scripts/record_cross_end_oracle.py --check
python scripts/record_cross_end_oracle.py --mode behaviour --check
python scripts/record_cross_end_oracle.py --mode lifecycle --check
python -m unittest tests/record_cross_end_oracle_test.py
pnpm exec vitest run tests/domain/v062-codex-oracle.test.ts
```

`--check` compares without replacing the recording. Lifecycle mode may create
and remove temporary synthetic state even in check mode. Missing entrypoints or
prompt-integrity failure must fail the lifecycle run; never replace those facts
with hand-written successful observations. Matching reason strings, equivalent
obligation models, native Windows behaviour and application loading are not
claimed by these recordings.
