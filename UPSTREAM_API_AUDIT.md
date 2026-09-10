# Upstream API audit: DSH 0.1.2-rc.1 → 0.1.5-rc.1

This audit is the P0 deliverable of the 0.5.1 adaptation. It records, for every
upstream change that reaches this plugin, the old interface, the new interface,
the files that consume it, the failure the change would let through, and the test
entry that closes it. It is a comparison of **published package metadata and type
surfaces**, not a runtime acceptance result.

One caveat about that fourth column, because an earlier heading overpromised it.
It is headed "Failure this guards against" rather than "Minimal failure
reproduction" for a reason: many rows describe a *counterfactual* or *past*
behaviour — what the old code used to do, or what a wrong assumption could be
mistaken for — rather than a command you can paste and watch fail. Where a row
does name runnable shapes (a malformed snapshot, a header version), those are the
inputs the named test feeds in. Rows marked `n/a` are changes with no consumer in
this repository; their search scope is recorded in the zero-reference list below
rather than left implied.

## How the evidence was produced

| Input | Exact source |
| --- | --- |
| Old surface | two throwaway `pnpm install` trees outside the repository: one with the 0.1.2-rc.1 package set, one with the full `@deepseek-ai/dsh@0.1.2-rc.1` dependency tree |
| New surface | two throwaway `pnpm install` trees outside the repository: one with the 0.1.5-rc.1 package set, one created by the runtime setup script at `--version 0.1.5-rc.1` |
| Method | Concatenate every `lib/types/*.d.ts` (and, for UI-less packages, `lib/*.d.ts`) per package per version, strip doc comments, and diff. Renderer behaviour was read from the shipped `lib/index.js` of `dsh-tool-bash`, `dsh-tool-bash-persistent`, `dsh-fs-observation-policy`, and `dsh-compaction-basic` in both trees. |
| Registry identity | `https://registry.npmjs.org/<name>/0.1.5-rc.1` `dist.integrity` for the 33 core rows, recorded in `src/domain/rc015-host.ts` and cross-checked row for row against the installed runtime graph |

No daily runtime, profile, or session was read as a compatibility input, and no
host was started for this audit. Workspace-local scratch paths are deliberately
not recorded here.

## 1. Session format V2 → V3 (`@deepseek-ai/dsh-session`)

| Old | New | Consumers | Failure this guards against | Test entry |
| --- | --- | --- | --- | --- |
| `SESSION_FORMAT_VERSION = 0` | `SESSION_FORMAT_VERSION = 3` | `src/runtime.ts` (`sessionHeaderForDigest`), `src/domain/digest.ts` | A header written by the old code carries `version: 0`; `sessionHeaderForDigest` used to hash it as a valid identity instead of refusing it. | `tests/domain/v051-dsh015-adaptation.test.ts` → "refuses a pre-V3 header …" |
| public `events` getter (V2) and `snapshotEvents()` (rc.1) | `snapshotEvents(fromSeq?, toSeqExclusive?)` only | `src/domain/session-events.ts`, `src/runtime.ts` | `snapshotSessionEvents({ events: [] })` used to return the legacy array. | `tests/domain/v041-session-events.test.ts` |
| V3 reader obligation: a snapshot is a contiguous sequence of event envelopes | Guard validates the snapshot it is handed: a non-object event, a missing event type, a missing/negative/fractional/NaN/string `seq`, or a sequence gap raises `SessionApiError` with code `session_event_envelope_invalid`; a non-V3 host raises `session_api_unsupported`. `runtime.ts` catches either and reports integrity `unknown`, so a damaged log cannot be projected into contract state. | `src/domain/session-events.ts`, `src/runtime.ts` | A snapshot of `[{seq: 0, type: 'turn/start'}, {seq: 2, type: 'turn/end'}]` used to derive normally. | `tests/domain/v041-session-events.test.ts` → "refuses a damaged log instead of projecting it" and "reports a damaged log as unsupported integrity" |
| `SessionHeader.seedLength?: number` | header keeps `isSeeded: boolean`; the inherited prefix length moved to `Session.inheritedEventCount` (durable via `session/end-seed`) | `src/runtime.ts`, `src/domain/digest.ts` | Resuming a fork used to hash a header field V3 no longer writes. | `tests/domain/v051-dsh015-adaptation.test.ts` → "keeps the digest stable across a persistence round-trip …" |
| `SurfaceOp` replace variant `{ op: 'replace', start, end }` | `{ op: 'replace', startSeq, endSeq }`, and `surfaceOp` is now REQUIRED on `system/message`, `user/message`, `assistant/message`, `tool/result` | `src/runtime.ts`, `scripts/native_host_probe.mjs` | Appending a surface event without `surfaceOp` now throws at the append site. | `tests/runtime.test.ts`, `tests/lifecycle.test.ts` (all appends already pass `{ surfaceOp: 'append' }`) |
| no `system/message` surface event; the system prompt lived in `EpochHeader.system` | `system/message` is surface node 0; `EpochHeader.system` is gone | `src/domain/derive.ts` (unknown types are ignored) | A V3 system prompt is a plugin-sourced message that could be mistaken for authority. | `tests/domain/v051-dsh015-adaptation.test.ts` → "never treats a V3 system message … as root authority" |
| `assistant/chunk` event stream | streams are embedded in `assistant/message.stream`; new `assistant/attempt` | none (Guard never read chunk events) | n/a — recorded so a future reader does not reintroduce a chunk scan. | `tests/domain/v030-stop-boundary.test.ts` covers the only assistant-text reader, which reads `assistant/message` |
| `session/end-seed: Record<string, never>` | `session/end-seed: { inherited?: true }` | none | n/a | covered indirectly by the digest round-trip test |
| `Session.fromRestore(id, seed, header, inherited)`; `RestoredSessionOptions.seedSource` | `fromRestore(id, seed, header, inherited, eventState)`; `RestoredSessionOptions.eventState: 'detached' \| 'shared-frozen'` | tests only | Type error at the call site. | `tests/runtime.test.ts`, `tests/tools/evidence.test.ts` |
| `chunk-rows` module (`packChunkRuns`, `decodeStorageRecord`) | removed | none | n/a | n/a |

**Reader obligation, and the half Guard deliberately does not implement.**
The V3 contract asks a reader that meets an unrecognized event type WITHOUT
`ignorable: true` to refuse the session rather than skip the event. Guard
implements the envelope half (above) and not the unknown-required-event half, on
purpose. The host's own persistence reader already refuses such a log before a
`Session` is ever published, so on a live session the check would be redundant;
and a whitelist of "event types Guard knows" would FALSE-REFUSE a valid host
whose composition registers a required event type through a third-party plugin —
a real risk given this plugin is loaded beside community bundles. Refusing
correctly-shaped logs on a healthy host is a functional regression, whereas an
unknown required event would have to survive the host's own gate first. If a
future host surfaces such a log to Guard directly, this is the decision to
revisit, not an oversight to patch.

**Digest decision (bounded shared-semantics impact).** `sessionRefDigest`
keeps its `ccg.sessionRefDigest.v3` domain and its exact field set. The V3
inherited-prefix length is fed into the existing `seedLength` token, because it
is the *same durable fact* under a new owner. V3's `isSeeded` marker was
deliberately **not** added: an absent optional field still encodes a presence-0
row, so adding any field would change every digest and invalidate the
byte-mirrored cross-language vectors pinned by
`tests/fixtures/conformance/UPSTREAM_PIN.json`. `parentSession`,
`seedLength`, `delegationDepth`, `origin`, `id`, and `createdAt` already bind
session identity. Consequence: **no** `digest_v3` vector changed, and
`tests/domain/digest-v3.test.ts` (29 golden vectors) still passes byte-for-byte.
Cross-repository parity therefore needs no re-mirror for this round; the
`isSeeded` omission is recorded as a deliberate, documented decision rather
than an unnoticed divergence.

## 2. Persistence and lifecycle (`ctx.sessions`)

| Old | New | Consumers | Failure this guards against | Test entry |
| --- | --- | --- | --- | --- |
| `flush(session): Promise<boolean>` | unchanged | `src/runtime.ts` (7 call sites) | n/a | `tests/flush.test.ts`, `tests/domain/v051-dsh015-adaptation.test.ts` |
| no `prepare`/`enter`/`announce` split | `prepare` / `enter` / `announce` added; `create` stays the one-call convenience | none (Guard only reads, appends, and flushes) | n/a | `tests/flush.test.ts` |
| `Session` constructed via `SessionStore.create` | same public shape | tests | n/a | `tests/runtime.test.ts` |

Guard adds no second persistence owner and no private session lock: it depends
on `ctx.sessions.flush()` participation, which is the contract that also drives
`boundary_flush_failed`.

## 3. Agent, Inbox, and Goal (`@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-goal`)

| Old | New | Consumers | Failure this guards against | Test entry |
| --- | --- | --- | --- | --- |
| `ctx.agent?: Agent` augmentation | removed (only `ctx.agents: AgentRegistry`) | none — `grep -rn "ctx\.agent\b" src` returns nothing | n/a | recorded as "not used" |
| `class Inbox` with public `claim()` / `hasPending` / `notifications` | `interface Inbox` without `claim`/`hasPending`; `agent.inbox` is the typed accessor | none — `grep -rn "hasPending\|\.claim(" src` returns nothing | n/a | recorded as "not used" |
| `agent.steer/send/followup/inject/cancel/whenIdle/runMaintenance`, `agent.session`, `agent.ctx` | unchanged | `src/runtime.ts` | n/a | `tests/runtime.test.ts` |
| `agent/session-start` sources `'startup' \| 'resume' \| 'clear' \| 'compact'` | unchanged | `src/runtime.ts` (re-arms recovery on `resume` and `compact`) | n/a | `tests/lifecycle.test.ts` |
| `agent/pre-step` waterfall payload `{agent, messages, turn, step, signal}` | unchanged | `src/runtime.ts`, `scripts/native_host_probe.mjs` | n/a | `tests/lifecycle.test.ts` |
| `agent/turn-stopping` serial payload `{agent, turn, signal}` | unchanged | `src/runtime.ts` | n/a | `tests/runtime.test.ts` |
| `GoalService.get/disarm` | unchanged; `pause` disarms, only `resume` re-arms | `src/runtime.ts`, `src/domain/boundary.ts` | A paused Goal with a still-pending persistence-authorized item used to reach the correction steer. | `tests/domain/v051-dsh015-adaptation.test.ts` → "never spends the correction steer while a Goal is paused …" |
| new `goal/activation-changed` Cordis event | added | none (Guard reads durable `goal/change` and live `get()`) | n/a | recorded as "not used" |

**Behaviour change made here.** `decideTurnBoundary` now refuses to spend its
one correction steer whenever a current Goal reference exists but is not the
active+armed continuation owner, and reports
`goal_paused_by_user_safe_yield` / `goal_not_continuable_safe_yield`. DSH
0.1.5-rc.1 pauses a Goal immediately, so Guard must never restart user-stopped
work. `GoalBoundaryAccess` exposes only `get` and `disarm`; there is no resume
path in Guard at all.

## 4. Tools (`@deepseek-ai/dsh-tools`)

| Old | New | Consumers | Failure this guards against | Test entry |
| --- | --- | --- | --- | --- |
| `ToolDefinition.output` required, `defineTool` returns canonical values | **unchanged** in 0.1.5-rc.1 (already required at 0.1.2-rc.1) | `src/tools/*.ts` | n/a | `pnpm run typecheck` |
| `tool/code-dispatch-start`, `tool/code-dispatch` session events | renamed `tool/ptc-dispatch-start`, `tool/ptc-dispatch` (payload identical) | `src/domain/derive.ts` | Under 0.1.5-rc.1 the old names produce **no** evidence. | `tests/domain/v051-dsh015-adaptation.test.ts` → "folds the renamed PTC dispatch events and ignores the retired names" |
| `tools.register/restrict/guard/get/schemas/execute` | unchanged | `src/runtime.ts` | n/a | `tests/domain/v030-stop-boundary.test.ts` (goal gate), `tests/loader.test.ts` |

## 5. Shell and filesystem result surfaces

Verified against the shipped renderer sources, not against documentation prose.

This section deliberately uses a different table shape from §1–§4: the question
here is not "what is the new signature" but "does this renderer's marker logic
still mean what Guard assumes", so the columns compare the two host versions
marker by marker. The consumer is `src/domain/evidence.ts` in every row, and the
covering cases are the `v051` shell and filesystem cases named in
`IMPLEMENTATION_RESULT.md` under T08 (11 marker shapes including the two new
`0.1.5-rc.1` markers, `FS_NOT_OBSERVED`, cancellation, permission denial, and
`evidence_outcome_not_success`). The per-row "Failure this guards against"
column of §1–§4 has no analogue here because a marker change fails by
misclassifying a result rather than by throwing.

| Renderer | 0.1.2-rc.1 markers | 0.1.5-rc.1 markers | Guard handling |
| --- | --- | --- | --- |
| `dsh-tool-bash` / `dsh-tool-pwsh` (the two registered by `@deepseek-ai/dsh-base`) | `[exit code: N]` (non-zero only), `[killed by signal: S]`, `[timed out after Nms]`, `[sandbox: …]` | **byte-identical marker logic** | the "completed foreground result with no marker is a clean success" rule remains valid for exactly these two names |
| `dsh-tool-bash-persistent` (not in the default bundle) | `[shell exited: code N]`, `[shell killed by signal: S]`, `[shell exited]`, reset prose, timeout intro | adds `[Command finished with exit code N]` and `[Command timed out or OOM]` | both new markers are now recognized, so a persistent-renderer result is classified by its own marker and never rides the unmarked rule (the audited cohort does not admit that package, so such a host also fails the whole lock closed) |
| `dsh-tool-fs` `read`/`write`/`edit` | names and parameter keys unchanged (`file_path`, `content`, `old_string`, `new_string`, `replace_all`, `offset`, `limit`) | identical | `dsh.fs-tools.v1` stays accurate |
| `dsh-fs-observation-policy` | `FS_NOT_OBSERVED` on an unobserved edit | unchanged | an unobserved write stays a failure, never a success |

**Rule change and its exact scope.** The scanner now reports an explicit
`marked` flag and recognizes the two new persistent-renderer markers, so a
0.1.5-rc.1 persistent result is classified by its own marker instead of falling
through the unmarked rule: `[Command finished with exit code N]` becomes an
explicit exit code (success or failure) and `[Command timed out or OOM]`
becomes a failure. What did NOT change: for the two renderer names the audited
cohort actually registers (`bash`, `pwsh`), a completed foreground result with
no marker remains a clean success — that renderer appends a marker only for
negative facts and non-zero exits, in both versions. That rule is reachable
only under a supported host lock, because `capabilityGatedSubject` forces
`outcome: unknown` with `adapter_unavailable` whenever the terminal surface
capability is not supported; the cohort's `terminal_posix` /
`terminal_windows` group admits `dsh-tool-bash` / `dsh-tool-pwsh` and never
`dsh-tool-bash-persistent`, so a persistent renderer cannot ride the unmarked
rule through a certified host. The generic `shell` alias keeps no verified
renderer contract and stays fail-closed without an explicit exit marker.
`tests/domain/v051-dsh015-adaptation.test.ts` closes the family, including the
quoted-marker, backgrounded-call, and unverified-alias cases.

## 6. Package graph and host identity

| Old | New | Consumers | Failure this guards against | Test entry |
| --- | --- | --- | --- | --- |
| 34-row rc.1 cohort including `dshmarket 1.41.0` | 33-row 0.1.5-rc.1 core cohort, `dshmarket` excluded by design; row-name set unchanged | `src/domain/rc015-host.ts`, `src/domain/host-lock.ts`, `manifests/supported-host.v1.json` | Injecting an rc.1 graph now selects no consistent cohort. | `tests/domain/v032-host-cohort.test.ts` |
| `auditedPlatforms` gated evaluation on both axes | `auditedPlatforms` (native audit fact) split from `acceptedPlatforms` (evaluation gate); `auditProvenance` bound into `hostLockDigest` | `src/domain/host-lock.ts`, `src/domain/host-resolver.ts` | A registry-derived cohort could otherwise be reported as a native pass. | `tests/domain/v032-host-cohort.test.ts` → "records the 0.1.5-rc.1 active cohort as registry-derived …" |
| `CRITICAL_NAMES` order inherited from cohort row order | sorted | `src/domain/host-resolver.ts` | A cohort re-order used to change lock-reading output order. | `tests/domain/v030-manifests.test.ts` |
| hardcoded `'0.1.2-rc.1'` and `'dsh-0.1.2-rc.1-core-v1'` in the resolver | `ACTIVE_HOST_COHORT_ID` / `ACTIVE_HOST_LAUNCHER_VERSION` derived from the cohort | `src/domain/host-resolver.ts` | A cohort bump used to leave a stale literal behind. | `tests/domain/host-target-preflight.test.ts` |
| `@deepseek-ai/dsh-jobs`, `dsh-jobs-local`, `dsh-user-approval`, `dsh-fs-observation-policy` | type surfaces unchanged | `src/runtime.ts` (jobs readback) | n/a | `tests/domain/v030-host-lock.test.ts` |
| `dsh-attachment` gains `FileAttachmentRef`; `dsh-llm` gains `FileBlock` | additive | none (Guard reads text parts; a file part counts as real non-text input) | n/a | `tests/lifecycle.test.ts` (attachment-only activation) |

## 7. Version policy

`>=0.1.5-rc.1` is the published peer range. The npm prerelease rule is narrower
than the policy, and the difference is documented and tested rather than
hidden:

| Candidate | `>=0.1.5-rc.1` resolves | Policy verdict |
| --- | --- | --- |
| `0.1.5-rc.1` | yes | supported |
| `0.1.5-rc.2` (same base) | yes | supported |
| `0.1.5` (release) | yes | supported |
| `0.1.6`, `0.2.0` | yes | supported |
| `0.1.6-rc.1`, `0.2.0-rc.1`, `1.0.0-rc.1` | **no** | ordered above the bound, but an install needs an explicit request |
| `0.1.4`, `0.1.5-alpha.9` | no | below the minimum, refused |

`src/domain/host-version.ts` implements one comparison used by the decision
tests, the diagnostics, and the documented semantics; `tests/domain/v032-host-cohort.test.ts`
reads the published `peerDependencies` and pins them to `SUPPORTED_HOST_RANGE`,
so the advertised range and the enforced range cannot drift apart while still
not being narrowed to one exact RC.

## 8. Native probe driver: host contracts re-verified for 0.1.5-rc.1

`scripts/native_host_probe.mjs` is the driver the native acceptance gate runs
inside a real host, and it is plain JavaScript — nothing type-checks it. Its host
contracts were therefore audited by reading the INSTALLED 0.1.5-rc.1 trees
against what the script assumes. **This is source comparison, not a test:** of the
ten items below, only item 6 is additionally pinned by an automated case
(`tests/tools/host-registry.test.ts` reads `error.info.code` at the exact path and
asserts the three real codes); the other nine rest on the reads named in their own
row, and the script itself still only runs in the gate this batch is forbidden to
execute.

| # | Contract the probe relies on | Verified how | Result |
| --- | --- | --- | --- |
| 1 | `session.snapshotEvents()` and `{ surfaceOp: 'append' }` on both appends | read of the script against the V3 surface | intact |
| 2 | Checkpoint result fields `open_items`, `available_evidence`, `rejected_bindings`, `detail_id`, `binding_template`, `omitted`, `parse_status`, `adapter_disposition`, `reason_code`, `semantic_action`, `detail_chunk`, `snapshot` | each name located in Guard's own source | 12/12 exist |
| 3 | Shell value `{ kind: 'foreground', exitCode, timedOut, aborted }` from `dsh-tool-bash` / `dsh-tool-pwsh` | read of the installed tools' declared `output.schema` — all four are `required`, `kind` is `const: "foreground"` | intact |
| 4 | `agent.ctx.waterfall('agent/pre-step', { agent, messages, turn, step, signal }, next)` | §3 of this audit | intact |
| 5 | `agent.ctx.tools.execute({ callId, name, arguments, agent, signal })` | read of the installed `dsh-tools` declaration for `tools.execute`, together with §4's row recording that `register/restrict/guard/get/schemas/execute` are unchanged | intact |
| 6 | Failure envelope `result.error.info.code` | read from the installed registry's response shape, and additionally pinned by `tests/tools/host-registry.test.ts` | intact |
| 7 | `ctx.sessions.flush(session)` resolving `true` | §2 of this audit | intact |
| 8 | `inject: ['agents', 'sessions', 'sessionPersistence', 'appReady']` | `appReady` is provided by the LAUNCHER (`ctx.provide("appReady", host.ready)` in `dsh-cmdline`), not by a plugin, so a service-name grep does not find it; the registration code is **byte-identical** between 0.1.2-rc.1 and 0.1.5-rc.1 | intact |
| 9 | `ctx.get('agentPresets')` with `resolve(id?)` and `mount(agentCtx, id?)` | installed declarations, compared across both host versions | identical |
| 10 | `ctx.agents.create({ sessionId, meta, setup })` / `resume({ resumeSessionId, setup })` and `handle.agent.whenIdle()` | read of the installed `dsh-agent` option declarations for `create` and `resume`, compared across both host versions | intact |

Item 8 is worth calling out because it looked like a defect at first: searching for
the service name `appReady` in the 0.1.5-rc.1 tree returns nothing from a plugin,
which reads as "the probe injects a service that no longer exists". It is provided
by the launcher and is declared optional on the context, so the probe would simply
not load outside an app command line. Comparing the registration line across both
host versions showed it unchanged, which is the check that settles it.

## APIs explicitly NOT used

Searched with `grep -rn` over `src/`, `tests/`, `scripts/`, and `bin/`:

- `ctx.agent` — removed upstream, **zero** references.
- `Inbox.claim` / `Inbox.hasPending` — removed upstream, **zero** references.
- Web Detail/Slot APIs, client-side surfaces — **zero** references. `scripts/native_host_probe.mjs` uses only the host-side `agent.ctx.waterfall('agent/pre-step')` and `agent.ctx.tools.execute()` seams plus Guard's own `detail_id` paging; its complete set of host contracts is audited item by item in §8.
- `assistant/chunk` — **zero** code references (the only occurrence is a doc comment in `src/domain/session-events.ts` explaining why there is no legacy fallback).
- `chunk-rows` exports (`packChunkRuns`, `decodeStorageRecord`) — **zero** references.
- `EpochHeader.system` — **zero** references.
- `goal/activation-changed`, `agent/assistant-stream`, `request/header`, `request/context`, raw `session/event` firehose — **zero** references; Guard reads only the durable log.

## Not closed by this audit

- No 0.1.5-rc.1 host has been started by Guard: the graph rows are
  registry-derived and `auditProvenance` says so.
- Windows behaviour, Web/Headless lifecycle, real-model behaviour, and the
  third-party context gate interaction are **unverified** here.
- `@deepseek-ai/cordis` is unchanged at `4.0.2`, so no Cordis diff was required.
