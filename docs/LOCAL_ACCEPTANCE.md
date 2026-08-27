# Local Acceptance

Deterministic checks and an isolated DSH_HOME composition smoke. These establish source correctness and load correctness, not full runtime behavior.

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

## Native platform acceptance

- macOS: an isolated real-model headless task used a supported POSIX shell
  write and an independent read, then persisted a certified checkpoint before
  the completed turn.
- Windows: an isolated real-model task used
  `pwsh Set-Content -LiteralPath` and an independent read, then persisted a
  certified checkpoint before the completed turn.

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
