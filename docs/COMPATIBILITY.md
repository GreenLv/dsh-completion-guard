# Compatibility

The current development target is pinned, not a floating claim.

## Target

- DeepSeek Harness: `0.1.1-rc.2`
- Cordis: `4.0.1`
- Node: `>= 22`
- pnpm: `>= 11`

The DSH host is a developer preview that declares breaking changes. A source build does not establish native acceptance; each profile and platform is verified separately.

## Loader contract

The package exposes a named `apply(ctx)` function and a named `inject` array (`['sessions', 'commands']`) with no default export. Its `dsh.bundle.patch` points at `cordis.patch.yml`, which inserts the `context-guard` bundle row.

The plugin accepts an `activation` configuration value of `opt-in` or `always`. The default is `opt-in`; `always` initializes the projection as enabled before the persisted session log is replayed. Invalid values fail during plugin configuration instead of silently falling back. A DSH profile can select `always` with an ID-targeted `config` override in its `cordis.patch.yml`; see the README quick start for the complete example and the replay implications for existing sessions.

## Peer dependencies

Runtime packages are host-provided and declared as peer dependencies: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-commands`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-tools`.

## Terminal outcome contract

The pinned DSH `bash` and `pwsh` renderers append terminal markers for sandbox
denial, timeout, signal termination, and non-zero exit. A completed foreground
result with none of those markers is the renderer's representation of a clean
exit; it does not append `[exit code: 0]`. Version 0.1.1 therefore accepts an
unmarked completed foreground `bash` result as successful evidence, matching the
existing `pwsh` behavior.

This does not make arbitrary shell text authoritative. A result-level error or
negative terminal marker wins over output text; background commands remain
unknown; and the generic `shell` alias remains unknown without an explicit exit
marker because no pinned host renderer contract has been verified for it.
Outcome classification also remains separate from command certification:
unsupported or malformed syntax produces no executable or operation facts and
no certifying subject/capability combination, so it cannot close a contract even
when the host execution itself succeeded.

## Verified surfaces

- `dsh --profile web --dump-config` and `--profile headless --dump-config` both include `context-guard`.
- A real headless boot loads the plugin (apply, `ctx.sessions` access, and listener registration succeed) and only stops at missing provider credentials.

The slash command renders in the Web command directory and its on/off/status/diagnose subcommands produce the expected `command/run`/`command/done`. Version 0.2.0 has 104 domain/core tests and 124 tests overall. Its macOS live acceptance includes a real Web `pnpm test` run with 5 test files and 124 tests passed, followed by a certified checkpoint at contract revision 4; the complete evidence boundary and known gaps are recorded in `LOCAL_ACCEPTANCE.md`. The published 0.1.0/0.1.1 releases retain separate historical public-package and native-platform evidence. The fail-closed invariants below are asserted as regressions.

## Certifiable command subset

Context Guard v0.2 is **not** a general Bash or PowerShell static analyzer. Only
the small, auditable grammar below can produce `executable`, `operation` and
`subject`; any other command parses as `unsupported` (unterminated quotes parse
as `malformed`) with EMPTY executables and operations, so unrecognized syntax
can never certify an operation. False negatives are preferred over false
positives: an uncertain command keeps its item incomplete.

The enumerations that define this surface (tools, executables, clause verbs)
are declared once in `src/domain/manifest.ts`; the parsers and the contract
capture read from that single data source, which test-time validation keeps
non-empty and duplicate-free with the documented verb priority order. The
manifest ships with the package and is not runtime-writable: widening the
surface lowers the evidence bar, so it changes only through a release.

### Supported POSIX shell (single foreground simple command)

- `printf … > literal-path`
- `echo … > literal-path`
- `touch literal-path`
- read-only inspection tools (`cat`, `grep`, `rg`, `head`, `tail`, `wc`,
  `sed` without in-place flags): every pathish argument counts as a read effect
  (v0.2)
- one whitelisted executable run directly, e.g. `node script.js`,
  `python tool.py`, `pnpm test`, `git pull`,
  `dsh plugin --profile web add dsh-dream-skin@0.3.1`
- a leading simple environment-assignment prefix, e.g. `CI=1 pnpm test`
  (wrappers such as `env`, `nohup`, `time`, `command` are not supported)
- diagnostic stream duplication (`2>&1`, `1>&2`, `N>&M`) in any position
  (v0.2); it is a pure fd copy with no filesystem effect

Literal paths only: no variables, globs, `~` expansion or command substitution.

### Unsupported → fail-closed (whole command, no partial results)

- unquoted LF/CRLF command boundaries, `;`, `&&`, `||`, pipelines (`|`), background (`&`), parentheses/subshells
- `$(…)`, backtick command substitution, heredoc/here-string (`<<`, `<<<`)
- unterminated quotes, dynamic `eval`/`source`/`.`-sourcing
- non-literal (variable/glob) redirect targets or arguments
- `>>`, `<`, file-target fd redirects (`2>`, `2>>`) and all other redirections
  beyond a single `>` or an `N>&M` stream copy
- in-place `sed -i`/`sed --in-place` editing
- executables outside the v0.2 whitelist

### Supported PowerShell (single directly invoked command)

- the v0.1 cmdlet set: `Set-Content`, `Add-Content`, `New-Item`, `Out-File`,
  `Get-Content` with the exact documented parameters
- v0.2: a whitelisted external executable (`git`, `pnpm`, `npm`, `node`,
  `python`, `tsc`, `vitest`, `pytest`, … – the same run-executable set as the
  POSIX side) invoked directly with all-literal arguments, e.g.
  `git push origin main`, `pnpm add pkg@1.0.0`; its run effect carries the
  first pathish argument
- v0.2: unquoted `N>&M` stream duplication is stripped everywhere (a quoted
  `"2>&1"` remains an ordinary value)

Requirements: the command must be unquoted at the command position; the path
must come from the explicit named path parameter (cmdlets) or be a literal
argument (external executables); a quoted path is one token (spaces allowed);
permitted value parameters (`-Value`, `-Encoding`, and `-ItemType`
where listed above) never contribute subjects;
`-WhatIf` and `-Confirm` are unsupported because they can avoid or defer the
claimed effect; positional paths, variables, expressions, `Join-Path`,
subexpressions, pipelines, `;`, script blocks, `&`, dot sourcing, `Copy-Item`,
`Move-Item`, `Rename-Item` and `.NET WriteAllText` are unsupported and fail the
WHOLE command.

### Subject resolution (v0.2)

Evidence artifact subjects are resolved against the call's `workdir`; when the
shell tool carries none (the macOS persistent bash/pwsh tools expose only
`command`), the session scope cwd is used as the default, so relative paths and
scope-run attribution match the contract subject derived from the same cwd. A
pathless `run` operation of a whitelisted executable is attributed to that cwd,
which is what closes a scope `run` contract; builtins (`echo`, `cat`, …) never
become a subject-carrying run.

### Binding invariants

- `run`: the successful method evidence (method + operation + subject) alone
  closes the contract; no extra read or unrelated deterministic-check is needed.
- `create`/`write`/`modify`: require one successful effect evidence matching
  operation and subject, plus an independent successful state-verification
  evidence on the same subject. When an explicit method is present, that method
  identity must be carried by the effect evidence itself; without an explicit
  method, any compatible effect evidence may satisfy the effect facet.
- `read`: a successful read evidence matching method, read operation and
  subject satisfies the method side and the object side at once.
- `verify`: one evidence must simultaneously provide success, an explicit
  read/verify/deterministic-check capability, the canonical subject and surface,
  and any required method identity; separate method and verification evidence
  cannot be spliced together.
- an explicit method whose operation cannot be parsed fails closed.
- prohibitions keep their existing semantics.
