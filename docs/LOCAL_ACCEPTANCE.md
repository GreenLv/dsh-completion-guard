# Local Acceptance

Deterministic checks and an isolated DSH_HOME composition smoke. These establish source correctness and load correctness, not full runtime behavior.

## Windows exact-source readback (2026-08-30)

Direct readback of the isolated Windows TEMP acceptance evidence verifies
source commit `b75868e9e73d29f50530ddaba15cfaef82e03ece` (`origin/main` at checkout
time), tested in a fresh Windows 11 checkout with Windows PowerShell 5.1,
Python 3.12.10, Node.js 24.18.0, pnpm 11.22.0, and effective
`core.autocrlf=true`.

The source and conformance matrix is verified:

- `pnpm test` -> 0; 7 test files, 170 tests passed.
- `pnpm run typecheck` -> 0.
- `pnpm run lint` -> 0.
- `pnpm run build` -> 0.
- `pnpm run pack:check` -> 0.
- `git diff --check` -> 0.
- The raw SHA-256 values of all four mirrored conformance fixture files matched
  their entries in `tests/fixtures/conformance/UPSTREAM_PIN.json`.

The exact-source artifact and load chain is also verified from the TEMP
clone/log evidence. It used a tarball built from that checkout and a fresh
isolated `DSH_HOME`:

- All six tracked `dist/` files matched across the HEAD blobs, local build,
  tarball, and isolated installation.
- `dsh --profile web --dump-config` read back the `context-guard` bundle, and a
  Node import smoke loaded the installed package.
- `dsh --profile web --dump-config`, Web startup logging, process stop, and
  cleanup completed. An HTTP 200 appeared only in the first-run stdout; that
  response was not persisted and the readback did not rerun the GET, so HTTP
  200 itself is not independently confirmed.

With effective `core.autocrlf=true`, the build made all six tracked `dist/`
paths appear as `M` even though `git hash-object` matched the corresponding
HEAD blob for 6/6 files and `git diff` contained no content changes. This was
an EOL status phantom, not an artifact mismatch; `dist/** text eol=lf` now
pins the generated files to LF while preserving the existing conformance
fixture LF rule.

Evidence boundary: source checks and the exact-source install/load/startup and
cleanup chain are verified. A real model-session smoke was not run, and the
HTTP response lacks independently persisted/read-back evidence. This does not
establish v0.3 runtime behavior, npm publication, a tag, or a GitHub Release.

## v0.3.0 source candidate gates (2026-08-30)

Source commit `4f079499509822425c80e0b5ab98d1ebc58da9d5` on
`codex/v0.3.0-sequence-2` passed the deterministic source matrix on macOS and
native Windows. The commit remains an unpublished source candidate; it is not
a tag, npm artifact, GitHub Release, or public-package readback.

The macOS source matrix used Node.js 25.1.0 and pnpm 11.22.0:

- `pnpm install --frozen-lockfile` -> 0.
- `pnpm run typecheck` -> 0.
- `pnpm test` -> 0; 19 test files, 351 tests passed and the one Windows-only
  command-shim test was capability-skipped.
- `pnpm run lint` -> 0 with no warnings.
- `pnpm run build` -> 0; a second build produced the same generated file names
  and SHA-256 values.
- `pnpm run pack:check` -> 0; package identity is
  `dsh-completion-guard@0.3.0`, and the action, Git command, and supported-host
  manifests plus the host-lock CLI are included.
- The portable runner executed all 37 mirrored semantic cases without skips.
- The DSH digest runner re-derived all 29 digest-v3 vectors; the four mirror
  file SHA-256 values remain identical to `UPSTREAM_PIN.json`.

The native Windows matrix used a fresh Windows 11 checkout, Windows PowerShell
5.1, Python 3.12.10, Node.js 24.18.0, pnpm 11.22.0, Git 2.53.0.windows.2, and
effective `core.autocrlf=true`:

- The focused host-lock/evidence suite passed 33/33 tests with no skips. It
  executed a `.cmd` shim from a path containing spaces and parentheses, bound
  both the shim and canonical `SystemRoot\\System32\\cmd.exe` identities,
  ignored later `PATH`/`ComSpec` substitution, rejected expansion characters,
  detected a fake `git.cmd` identity swap, and completed the real Git
  commit/push/fetch/pull round trip within its Windows timeout.
- `pnpm test` -> 0; all 19 test files and all 352 tests passed with no skips.
- Typecheck, lint, build, package dry-run, documentation audit, documentation
  unit tests, `git diff --check`, generated-`dist` parity, and final clean-tree
  readback passed.
- All 37 portable semantic cases, all 29 digest-v3 vectors, the four pinned
  mirror hashes, and cross-repository fixture byte equality passed.

Each platform built and recorded its own local exact-source tarball. The macOS
artifact SHA-256 is
`d613d88edbc44ccc020ad48dff6d180e79c04ed5bcabb73d7fae09d449500890`;
the Windows artifact SHA-256 is
`397975f720f0c6d734e7faf7279fab3feee1f92433ff457122755d9296adb19f`.
These raw archive hashes are platform-local build provenance, not a requirement
that independently packed gzip/tar containers be byte-identical. Both were
built from a clean checkout of the exact commit, reported the same package
identity and 26-file package list, retained build-to-`dist` parity, and were
installed from the artifact that was hashed on that platform. A future release
must instead freeze one canonical tarball, bind it to the release commit, tag,
npm `gitHead`, and registry integrity, and verify that same artifact on every
required native platform.

Both platform-local exact-source artifacts were installed into fresh isolated
Web and Headless profiles without modifying the user profile. For both
profiles, the packaged host-lock CLI completed `inspect -> inject -> inject
(idempotence) -> dsh --dump-config -> verify-dump` against the active
runtime/profile graphs. The Web tuple contained 34 exact package rows with Web
control available; the Headless tuple contained 33 rows with Web control
unavailable by profile while the other applicable capabilities remained
supported.

On both macOS and Windows, an isolated Web profile loaded real
`dshmarket@1.36.0`, returned HTTP 200, accepted the correct restart request
with HTTP 202, replaced the process, and returned a different boot ID after
restart. The Windows run also verified that a wrong restart origin was rejected.
Each replacement process returned HTTP 200 before teardown; the temporary
listener, helper, and profile processes were then read back as stopped. Each
isolated Headless profile loaded the plugin and advanced to the expected
`MISSING_CREDENTIAL` boundary with `DEEPSEEK_API_KEY` removed from the child
environment.

This establishes deterministic source behavior plus native macOS and Windows
package composition, host-lock readback, load, and Web restart lifecycle for
commit `4f079499509822425c80e0b5ab98d1ebc58da9d5`. It is not a credentialed
model-session Goal/checkpoint/boundary round. CI, a canonical release artifact,
npm/GitHub publication, tag identity, and a real model-session smoke remain
independent pending release gates.

## macOS v0.2.0 acceptance (2026-08-28)

Verified source commit: `c107cd8ead97988f6a71cab8182edb16b23b086b`, on `main`, with a clean worktree and `main == origin/main` at the release preflight. Node v25.1.0 and pnpm 11.22.0 were used on macOS.

Repository gates passed before publication:

- `pnpm install --frozen-lockfile` -> 0.
- `pnpm test` -> 0; 5 test files, 124 tests passed.
- `pnpm run typecheck` -> 0.
- `pnpm run lint` -> 0 errors / 0 warnings.
- `pnpm run build` -> 0.
- `pnpm run pack:check` -> 0.
- `validateManifest()` returned no errors. The semantic checks covered informational receipt filtering, deterministic-check classification, `2>&1` support, and rejection of compound `&&` syntax.

Live Web acceptance after installing `dsh-context-guard@0.2.0` into the managed `web` profile and restarting DSH:

- The live profile reads installed version `0.2.0`; `dsh --profile web --dump-config` includes the `context-guard` bundle.
- A real Web session in this repository executed one foreground Bash `pnpm test` call. The persisted result reported 5 test files and 124 tests passed.
- The next checkpoint bound the successful evidence (`E0001`) to the two current session items. The checkpoint returned `status: certified`, `contract_revision: 4`, with `rejected_bindings: []` and `open_items: []`.

Publication and consumer readback:

- `npm view dsh-context-guard dist-tags.latest` -> `0.2.0`.
- npm `gitHead` for `0.2.0` -> `c107cd8ead97988f6a71cab8182edb16b23b086b`.
- The official `dsh-context-guard-0.2.0.tgz` unpacks to version `0.2.0`; all six packaged `dist/` files are byte-identical to the local build by md5. The local-only `dist/.DS_Store` is not part of the npm package and is excluded from this comparison.
- Annotated tag `v0.2.0` was pushed. Remote readback returned tag object `dc1b13e00b2e1adadacb2c8de0a533ec8f51ac22` peeling to commit `c107cd8ead97988f6a71cab8182edb16b23b086b`.
- codex-sync update discovery reported exactly `dsh-context-guard 0.1.2 -> 0.2.0`; the dry run planned one update, apply succeeded, the installed profile package reads `0.2.0`, the bundle contains `context-guard`, and the follow-up dry run returned `No DSH plugin changes needed`.

Evidence boundaries:

- The live 0.2.0 checkpoint certifies the real `pnpm test` workflow and its bound session items. It does not certify every release requirement in the recovered handoff contract.
- The rejected compound-command case with an actionable `rejected_bindings[].hint`, and informational receipt filtering, are covered by the 0.2.0 semantic/regression checks and earlier real-session evidence; they were not re-created as additional live Web calls in this acceptance run.
- Windows native acceptance remains the documented 0.1.x bounded PowerShell result; no Windows 0.2.0 run is claimed here.

## macOS v0.2.1 acceptance (2026-08-28)

Verified source commit: `ba8f05dc6a922b8a12f4dc211d9a888d2ece526a` (= annotated tag
`v0.2.1`, tag object `5bccac9dd77549a929137befd808dc1701d77093`). Repository gates
and package verification ran on a clean worktree at that commit; the npm
publication ran from `806aa863234a064b5c42391fa1288998abfc846e` as recorded
below. Node v25.1.0, pnpm 11.22.0, npm 11.17.0 on macOS 26.6.2 (arm64). The
pre-publish artifact `dsh-context-guard-0.2.1.tgz` had SHA-256
`ea2b6a0bc1db82150af9d88494b6c9d2a1e0243d33ed21df48d3c23d7c52a895`.

Repository gates passed at `ba8f05d` (each exit code recorded at run time; the
untracked `docs/PROBLEM_REPORT_v0.2.1.md` was moved out of the worktree for the
pack steps and restored afterwards):

- `pnpm install --frozen-lockfile` -> 0.
- `pnpm run typecheck` -> 0.
- `pnpm test` -> 0; 6 test files, 138 tests passed (`tests/domain/conversation.test.ts`
  is the new v0.2.1 conversational-capture matrix with 7 tests).
- `pnpm run lint` -> 0; 0 warnings / 0 errors (26 files, 96 rules).
- `pnpm run build` -> 0; 6 files, 151.33 kB total.
- `pnpm run pack:check` -> 0; `dsh-context-guard-0.2.1.tgz`, 19 files, and the
  untracked problem report is not part of the package.

Installed-state verification: the tgz above was added to the real `web` profile
(`dsh plugin --profile web add file:...`) and to the `headless` profile; both
installed packages read `0.2.1`, `dsh --profile web --dump-config` still composes
the `context-guard` bundle, and DSH web was restarted after the install (new
process PID 97136 started 09:55, listening on 127.0.0.1:3080, after the 09:53
install) so the live instance loads 0.2.1.

### Live multi-turn Web session (one guarded session, all steps)

A brand-new guarded session in the real Web UI (workspace `dsh-context-guard`,
DeepSeek-V4-Flash-Vision-Exp, workspace-write), driven through a dedicated
Chrome instance over the Chrome DevTools Protocol — the same browser-automation
lane this DSH install uses for its own browser skill (`chrome-devtools-mcp`).
User messages were submitted with CDP-trusted pointer events on the composer's
send control; every acceptance observable below was double-checked against the
server-side session log
(`~/.dsh/sessions/…/session-6dcd1274-d4bb-430f-a07c-bcddda8a3bca/session.jsonl.zstd`).
The profile's managed patch layer already sets `context-guard` to
`activation: always`, so the session was guarded from its first event.

1. Baseline: `/context-guard status` -> `{"enabled":true,"epoch":0,
   "contract_revision":0,"pending":0,"passed":0,"evidence":0,
   "integrity":"valid"}`.
2. Change 1, clarifying message: `这个收尾具体要做什么` was sent; the model
   answered (and explored the repository, producing 32 evidence entries). The
   next `/context-guard status` returned `pending:0`, `contract_revision:0` —
   the clarifying question was not captured as a contract item.
3. Change 1, progression phrase: `继续` was sent; the model continued its
   analysis. `/context-guard status` again returned `pending:0` (evidence 37) —
   the progression phrase was not captured.
4. Evidence production and certified checkpoint: the single-clause task
   "在本仓库前台单一命令运行 pnpm test 且不得使用管道分号或重定向，然后用本次运行产生
   的证据调用 context_guard_checkpoint 绑定全部开放项完成认证" was captured as
   `R001` (checkpoint with empty bindings returned `incomplete`,
   `open_items:["R001"]`); the model executed a clean foreground `pnpm test`
   (single command, no pipes or redirects; 6 files / 138 tests passed), which
   produced durable evidence `E0038` (bash, scope, outcome success, shell +
   deterministic-check), and the binding `{"item_id":"R001",
   "evidence_ids":["E0038"]}` returned `{"status":"certified",
   "contract_revision":1,"open_items":[],"rejected_bindings":[]}`. Both raw
   tool results are persisted in the session log.
5. Pre-clear goal-gate denial (fail-closed evidence): a verification message
   was itself captured as `R002` (revision 1 -> 2); the model's empty-binding
   checkpoint returned `incomplete, open_items:["R002"]`, and
   `update_goal(action=complete)` was denied with "Context Guard requires a
   current completion certificate before Goal completion." — the gate denies
   before checking whether a goal exists (`get_goal` returned `{"goal":null}`).
6. Clear remediation: `/context-guard clear` returned "Context Guard contract
   cleared: 1 requirement/acceptance item(s) superseded; 0 pending remain
   (prohibitions retained)." A follow-up verification (phrased as a question,
   which the conversational filter does not capture) re-ran both tools:
   the empty-binding checkpoint returned `{"status":"certified",
   "contract_revision":8,"open_items":[],"rejected_bindings":[]}`, and
   `update_goal(action=complete)` was no longer blocked by the guard — it
   reached the goal tool's own argument validation (`goal_id` placeholder
   rejected) because this session has no active goal. The final
   `/context-guard status` read `{"enabled":true,"epoch":0,
   "contract_revision":8,"pending":0,"passed":1,"evidence":43,
   "integrity":"valid"}` — the guard stayed enabled across the clear.

Headless cross-checks (fresh guarded session per run, `--patch` overlay with
`activation: always`, real model turns; server logs under `~/.dsh/sessions/`):

- Compound-command rejection: `pnpm test 2>&1 | tee …; echo …` produced
  scope-only evidence and the binding attempt was rejected with `incomplete`
  and per-item hints ("needs a scope run effect: a whitelisted executable …
  without pipes, `;` or `&&`"). No binding rule was changed for it.
- Recovery-injection dedup: across three headless sessions, six
  `context_guard_checkpoint` rejections (nonexistent evidence `E9999`, both
  missing-item and evidence-mismatch reasons) produced exactly one
  "Open task requirements (recovered after compaction or resume):" plugin
  notice per session — no duplicate recovery packet was ever injected live.
  The step-separated identical-rejection scenario is covered deterministically
  by `tests/runtime.test.ts` ("recovery injection dedup (v0.2.1)").

Evidence boundaries:

- The live Web session covers the work order's steps 1-5 (status baseline,
  clarifying message, progression phrase, supported-task evidence with a
  certified checkpoint, and clear -> empty-binding certified -> goal-gate
  release with the guard still enabled). The `update_goal` leg ends at the
  goal tool's own argument validation because the acceptance session had no
  active goal; the gate's release is nonetheless demonstrated, and the denial
  path was captured live pre-clear.
- Evidence remains session-scoped by design; cross-session evidence IDs are
  rejected and no cross-session import exists. Windows native behavior is not
  re-claimed here; the 0.2.0 Windows records stand.

### Publication and consumer readback

The npm publication was authorized and executed from
`806aa863234a064b5c42391fa1288998abfc846e` ("docs: update READMEs to v0.2.1"),
a post-release README follow-up commit that was already on local `main` (not
pushed at the time) when the release was approved. Per the maintainer's
explicit choice, the registry `gitHead` therefore points at `806aa86…` rather
than the tag commit `ba8f05d…`; the annotated tag `v0.2.1` itself was not
moved and still peels to `ba8f05d…`.

- `npm publish` -> `+ dsh-context-guard@0.2.1` (19 files, package size
  70.5 kB, shasum `2a32ce46fd00fd87d144011653bd99fe2c5a9bd5`). The account's
  npm token had expired and the publish required npm's EOTP web
  authentication, completed in the browser.
- `npm view dsh-context-guard dist-tags.latest` -> `0.2.1`; versions sequence
  `0.1.2, 0.2.0, 0.2.1`.
- `npm view dsh-context-guard@0.2.1 gitHead` -> `806aa863234a064b5c42391fa1288998abfc846e`.
- The official `dsh-context-guard-0.2.1.tgz` unpacks to version `0.2.1`; all
  six packaged `dist/` files are byte-identical (md5) to the `ba8f05d`
  gate-run build, and both README files are byte-identical to the `806aa86`
  content. No `docs/PROBLEM_REPORT_v0.2.1.md` is part of the package.

## 0.1.1 release candidate (2026-08-27)

The candidate was built on macOS from branch
`codex/0.1.1-bash-success-evidence`. The tested runtime domain bundle is
`dist/domain-DEXOzCqH.js` with SHA-256
`e8ad974b8263a2a25c7ef08ca3839097d3312c10d450b8520163c623e54881f9`.
The exact pre-commit source-tree and tgz digests are recorded in the generated
candidate manifest rather than embedded here: this document is itself part of
the npm archive, so embedding that archive's digest would change the digest.

Verified for this candidate:

- `pnpm install --frozen-lockfile`, typecheck, lint, all 106 tests, build, and
  package-content validation completed successfully on macOS.
- The candidate tgz composed into fresh isolated `web` and `headless` profiles.
  Both installed packages read back as `0.1.1`; a second identical add reported
  `Already up to date`, and hashes of the profile manifests, lockfile, composed
  patch files, and installed package manifest did not change.
- The 0.1.1 domain runtime replayed a completed real DSH Web log captured with
  `activation: always` and confirmed durability. Its foreground `bash`
  `pnpm typecheck` result contained ordinary stderr output and no
  `[exit code: 0]` marker; replay derived successful scope evidence and issued a
  certificate for all four matching open items with no rejected bindings.
- A clean Windows checkout of commit
  `16ea9e7a5d088ce6b7e09617f15acd771f57ff40` passed the frozen install,
  typecheck, lint, all 106 tests, build, and package-content validation with
  DSH `0.1.1-rc.2`. The candidate package was
  `dsh-context-guard@0.1.1` with SHA-256
  `6c0aed77a9fc7f43f6d8bc11e4355d465d1146c81fe10276ad3e523f0abd8a83`.
  Fresh isolated Web and headless profiles both read back version `0.1.1`; a
  second identical installation was a strict no-op with unchanged lockfile
  hashes.
- A separate minimal Windows real-model session loaded that candidate with
  `activation: always`. One supported foreground `pwsh Set-Content
  -LiteralPath ... -Encoding ascii -NoNewline` call created
  `D:\dsh-pwsh-acceptance\pwsh-acceptance.txt`, and an independent `read`
  returned `guard-test`. The persisted create evidence and read evidence were
  bound to the single current contract; the checkpoint returned `certified`
  at contract revision 1 with no open items or rejected bindings.

Evidence boundary:

- The macOS Web result is a candidate-runtime replay of a genuine closed Web
  log, combined with isolated Web composition. It is not a claim that the
  unpublished candidate was installed into the user's live Web profile.
- The Windows certificate covers only the documented PowerShell subset and the
  exact candidate identity above. The first workspace-confined write attempt
  was rejected because the target was outside the checkout; the same single
  command succeeded only after an explicitly approved elevated retry. The
  rejected call was not available for certification. This run does not expand
  the Windows Bash claim or certify compound PowerShell commands.
- An earlier Windows session completed its model turn without a certificate,
  and a later diagnostic session produced only scope evidence for compound
  PowerShell calls. Neither is counted as acceptance. The successful result is
  the fresh revision-1 session whose supported write and independent read
  produced artifact-matching evidence.
- These pre-release native results do not by themselves establish CI, an npm
  publication, a tag, or a GitHub Release; those publication identities require
  separate readback.

## Deterministic checks

```sh
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm test            # vitest
pnpm run lint        # oxlint
pnpm run build       # tsdown
pnpm pack --dry-run --json
```

## Isolated profile composition (macOS, no real ~/.dsh)

```sh
export DSH_HOME=/tmp/dsh-context-guard-smoke
DSH=/path/to/dsh
"$DSH" plugin --profile web add "file:/abs/path/to/dsh-context-guard"
"$DSH" --profile web --dump-config | grep context-guard
"$DSH" plugin --profile headless add "file:/abs/path/to/dsh-context-guard"
"$DSH" --profile headless --dump-config | grep context-guard
```

Verified result: both profiles contain `id: context-guard, name: dsh-context-guard` in the composed tree.

## Native load

A real headless boot loads the plugin and advances to the model call; it stops at `MISSING_CREDENTIAL` when no provider key is configured. That is the expected boundary for a load check and is unrelated to plugin correctness.

## Verified

- Web UI command rendering and the `/context-guard on|off|status|diagnose` subcommands produce the expected `command/run`/`command/done` (round-5 isolated profile); `/context-guard diagnose` was re-verified in round-8.
- A complete macOS headless task in an isolated profile created one artifact,
  read it back as durable evidence, rejected an incomplete first binding, then
  certified the complete requirement and acceptance set before `turn/end`.

## v0.2.0 Windows acceptance status

The GitHub tag `v0.2.0` resolves to release commit `c107cd8`. The GitHub
Release is published at
https://github.com/GreenLv/dsh-context-guard/releases/tag/v0.2.0.

Windows 0.2.0 native runtime acceptance completed in the separate live DSH
Web session. The loaded package version was `0.2.0`. The supported PowerShell
command

`Set-Content -LiteralPath 'D:\dsh-pwsh-acceptance\pwsh-acceptance-020.txt' -Value 'guard-test' -Encoding ascii -NoNewline`

created the artifact successfully after the documented permission-boundary
retry. An independent `read` returned exactly `guard-test` with no trailing
newline. The durable evidence IDs from that session were `E0009` for the
successful PowerShell write and `E0011` for the independent read.

The session's checkpoint attempt was `incomplete`, and a follow-up session
also rejected `E0009` and `E0011` because those IDs are not present in its
current session projection. Context Guard currently derives evidence from the
active DSH event log only; it has no cross-session evidence import or lookup
contract. The runtime actions and their outputs are therefore recorded as
completed runtime acceptance, but the v0.2.0 checkpoint remains `incomplete`
in this later session by design. To obtain a certificate, the commands and
checkpoint must be performed in one session. The Windows scope is limited to
the documented PowerShell subset and does not expand to Windows Bash or
compound PowerShell syntax.

## Native platform acceptance

- macOS: an isolated real-model headless task used a supported POSIX shell
  write and an independent read, then persisted a certified checkpoint before
  the completed turn.
- Windows: the v0.1.1 candidate had an isolated real-model task using
  `pwsh Set-Content -LiteralPath` and an independent read, with a certified
  checkpoint. The v0.2.0 runtime actions are recorded in the dedicated status
  section above, but their cross-session checkpoint repair remains incomplete.

Both final-SHA runs used clean public checkouts and isolated `DSH_HOME`
directories. They establish native behavior for the bounded v0.1 command
subset; they do not claim support for shell or PowerShell syntax outside the
subset documented in `COMPATIBILITY.md`.

## Public-package profile readback

On macOS, the published `dsh-context-guard@0.1.0` npm package was installed into a real DSH Web profile through the pinned `codex-sync` plugin reconciler. A second dry run was a strict no-op; direct package and bundle readback reported version `0.1.0`; `dsh --profile web --dump-config` included the `context-guard` bundle; and the restarted Web command directory exposed `/context-guard`, whose `status` subcommand returned a valid projection summary.

This verifies public-package consumption and real-profile loading on macOS. It does not replace the isolated model-task evidence above and does not claim a second Windows run from the public npm package.

## macOS v0.1.2 acceptance (2026-08-27)

Verified commit: `dd402fbaa5d37dd246056d8ecd66430e5f75f412` (annotated tag `v0.1.2`, clean checkout, `main` fast-forwarded to the tag). macOS, Node v25.1.0, pnpm 11.22.0.

Gate run (exit codes and summary):

- `pnpm install --frozen-lockfile` → 0.
- `pnpm test` → 0; 5 test files, 107 tests passed.
- `pnpm run typecheck` → 0.
- `pnpm run lint` → 0 errors / 0 warnings (23 files, 96 rules).
- `pnpm run build` → 0; 6 files, 123.60 kB total (`dist/index.js`, `dist/domain/index.js`, `dist/domain-CJulh_RZ.js`, `dist/index.d.ts`, `dist/domain/index.d.ts`, `dist/index-CA7Z-W_A.d.ts`).
- `pnpm run pack:check` → 0.

Artifact check: `shell exited: code` is present in `dist/`. The literal string `persistent bash shell was reset` cannot appear in any build of commit dd402fb, because the implementation parameterizes the reset line as `/^The persistent (?:bash|pwsh) shell was reset;/` to cover both persistent renderers (`src/domain/evidence.ts` `PERSISTENT_RESET_LINE`). Equivalent checks pass: the regex is present in `dist/domain-CJulh_RZ.js` (line 1059), it matches the rendered Bash and pwsh prose lines (run through `RegExp.test`), and the built `dist` module replays all eight 0.1.2 cases (`[shell exited: code 1]`, `[shell killed by signal: SIGTERM]`, `[shell exited]`, timeout intro — each with and without the reset prose; plus `[shell exited: code 0]` → success and reset-prose-only → success) with the expected outcomes.

Publication readback: `npm view dsh-context-guard dist-tags.latest` = `0.1.2`; registry `gitHead` = `dd402fbaa5d37dd246056d8ecd66430e5f75f412`; the official tarball `dsh-context-guard-0.1.2.tgz` unpacks to version `0.1.2` with both artifacts above, and all six `dist/` files are byte-identical (md5) to the local build — the published artifact matches the gate-run build.

Installed state (macOS, real `~/.dsh`, `codex-sync` managed): pin raised `0.1.1` → `0.1.2` in `config/dsh/plugins.toml`; `--check-updates` reported the pin current; the pre-apply dry run planned exactly one UPDATE; `--apply` ran the single `dsh plugin --profile web add dsh-context-guard@0.1.2` pass; `~/.dsh/profiles/web/node_modules/dsh-context-guard/package.json` reads `0.1.2`, the installed `dist/` carries both vocabulary markers, the package stays in `dsh.profile.bundles`, and a follow-up dry run is a no-op (`No DSH plugin changes needed`). DSH was restarted (process started 23:41:05, after the 23:39:17 install) so the live instance loads 0.1.2.

Smoke (in the live guarded session, 0.1.2 loaded): a clean foreground `pnpm test` in this repository completed with 5 files / 107 tests passed and produced no terminal marker; the guard-derived evidence (`E0065`, bash, repo scope) carries outcome `success`, and the checkpoint binding `{R042, [E0065]}` was accepted with no rejected bindings — the clean foreground bash result both scores `success` and certifies its matching item, confirming the 0.1.1 clean-success contract still holds under 0.1.2 (the 0.1.1 → 0.1.2 core regression point). One earlier binding was properly rejected and is recorded, not hidden: the first smoke attempt wrapped the command in `2>&1 | tail -6; echo ...`, which the guard classifies as non-deterministic with no supported operations; the binding `{R041, [E0058]}` failed the run contract, and no binding rule was changed for it. A subsequent clean run was used for the accepted binding.

This section records the live-profile acceptance of v0.1.2 on macOS. It does not claim completion of the session's full 55-item contract, which was not part of this smoke; it does not re-claim any Windows result.
