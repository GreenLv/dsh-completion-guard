# Changelog

All notable changes to this project are documented here. The project is
pre-1.0; release versions track the plugin lifecycle, not stabilised API
promises.

## 0.1.0 - 2026-08-27

Initial task-contract and completion-certification plugin for DeepSeek
Harness.

### Added

- Contract capture from direct human messages (requirement / acceptance /
  prohibition), each with a concrete verification subject and surface.
- Bounded evidence derived only from persisted `tool/call` + `tool/result`
  pairs (capability, subject, surface, bounded summary hash).
- Fail-closed completion certification: empty evidence bindings, missing or
  stale evidence, and unrelated evidence are rejected.
- Goal-completion gate (`update_goal complete` requires a current certificate
  while enabled) and turn-stopping gate with a continuation-attempt cap.
- Recovery packet injection after compaction or resume.

### Changed

- Guard state is now derived purely from natively persisted DSH session
  events (`command/run`, `user/message`, `tool/call`, `tool/result`). Context
  Guard no longer appends custom `context-guard/*` event types, which the
  current persistence layer would refuse to reload — resuming a guarded
  session no longer depends on an upstream event-registration seam.
- Capture sanitizes credentials, bearer tokens, and URL query strings before
  persisting normalized clause text, matching the privacy contract.
- Exit-code evidence uses the last recorded marker, so an echoed fake
  `[exit code: 0]` can no longer mask a real trailing failure; echoed or
  backgrounded check commands no longer count as deterministic verification.
- Replay re-verifies certificates: certification is recomputed from the
  re-derived evidence, and a certificate that no longer re-derives marks the
  projection `corrupt` (fail closed).

### Fixed

- Two captured requirements in one scan no longer collide on the same
  identifier and revision; identical re-statements supersede the earlier
  capture under a new revision.
- The Goal-completion gate no longer fires while the guard is disabled.
- Bare completion confirmations (`Done.`, `搞定了。`) now trigger the gate,
  and step-level claims followed by continuation intent are no longer treated
  as whole-task completion.
- Code-mode dispatch roots are carried through evidence instead of being
  pinned to the inner call id.

### Release materials

- Full Apache-2.0 license text, CI workflow, and this changelog; the npm
  package now includes `docs/`.
