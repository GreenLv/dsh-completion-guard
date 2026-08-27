# Architecture

Context Guard separates DSH-owned execution from Guard-owned certification.

## Responsibility boundary

| Module | Owns |
| --- | --- |
| DSH Goal | Persisted objective, automatic goal rounds, pause/resume/block/complete |
| DSH Todo | Lightweight current plan display |
| DSH Compaction | Model-visible history reduction without corrupting tool-call structure |
| Context Guard | Per-item task contract, revisions, evidence binding, and completion certificate |

Context Guard does not own Goal, Todo, Compaction, or continuation. It intervenes when completion is claimed without a valid certificate.

## Durable state model

The effective plugin configuration and the DSH Session append-only log are the inputs to the rebuildable Guard projection. Context Guard **appends no custom session event types**: the persisted event vocabulary is harness-owned and the current persistence layer refuses unknown event types. The `activation` configuration supplies the initial enablement state, while all later session state is derived from the natively persisted events DSH already writes:

- effective plugin configuration — initial enablement (`opt-in` starts disabled; `always` starts enabled before log replay);
- `command/run` — later enablement (`/context-guard on|off`) and epoch transitions;
- `user/message` — captured contract clauses;
- `tool/call` + `tool/result` — bounded evidence and completion-certificate attempts.

The in-memory `GuardProjection` is a rebuildable cache: `deriveProjection` applies the effective activation configuration, replays the native log deterministically, recomputes every contract, evidence, and certificate, and flags `corrupt` when a recorded certificate no longer re-derives from the evidence in the log. Under `always`, replay begins enabled; changing an existing profile from `opt-in` to `always` can therefore bring earlier persisted user messages into the derived contract. A recorded `/context-guard off` disables capture from that point until a later `on`. Captured contracts always carry a concrete subject/surface, so no unrelated evidence can close a requirement.

## Synchronization

The runtime rebuilds the projection from the log before each step. Before evidence is produced, the runtime awaits `ctx.sessions.flush(session)`; if no durability listener participated, evidence is demoted to `unknown`, which fails closed.

Evidence is produced only from persisted `tool/call` + `tool/result` pairs. Guard never inserts context between a Code Mode sub-call and its durable result.

## Domain pipeline

1. `classifyClause` / `captureClause` classify a direct human message into requirement, acceptance, or prohibition.
2. `evidenceFromPersistedToolResult` maps a persisted tool result to bounded evidence with capability, subject, and surface, using the tool's structured `meta` and parsed arguments.
3. `evidenceMatchesItem` requires a verifying capability (filesystem-read, filesystem-edit, web-fetch, deterministic-check) and a matching subject/surface before an enforced item can close.
4. `certifyCheckpoint` binds evidence to items and emits a certificate bound to epoch, contract revision, and digests.
5. `goalCompletionDenial` rejects `update_goal(action=complete)` without a current certificate.
6. `decideTurnStopping` steers a turn that claims whole-task completion without a certificate, capped per turn.
7. `renderRecoveryPacket` re-injects open requirements after compaction, resume, enable, rejection, or integrity loss.
