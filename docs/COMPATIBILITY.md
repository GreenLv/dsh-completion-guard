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

## Peer dependencies

Runtime packages are host-provided and declared as peer dependencies: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-commands`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-tools`.

## Verified surfaces

- `dsh --profile web --dump-config` and `--profile headless --dump-config` both include `context-guard`.
- A real headless boot loads the plugin (apply, `ctx.sessions` access, and listener registration succeed) and only stops at missing provider credentials.

The slash command renders in the Web command directory and its on/off/status/diagnose subcommands produce the expected `command/run`/`command/done`. Isolated native real-model closed loops pass on macOS and Windows: the persisted sessions show a supported write effect, an independent read of the same artifact, a certified checkpoint bound to real evidence IDs, and task completion only after certification. The domain/core loop (capture, matching, certification, gates) is covered by 85 unit tests; the full project suite contains 104 tests. The fail-closed invariants below are asserted as regressions.

## v0.1 certifiable command subset

Context Guard v0.1 is **not** a general Bash or PowerShell static analyzer. Only
the small, auditable grammar below can produce `executable`, `operation` and
`subject`; any other command parses as `unsupported` (unterminated quotes parse
as `malformed`) with EMPTY executables and operations, so unrecognized syntax
can never certify an operation. False negatives are preferred over false
positives: an uncertain command keeps its item incomplete.

### Supported POSIX shell (single foreground simple command)

- `printf … > literal-path`
- `echo … > literal-path`
- `touch literal-path`
- `cat literal-path`
- one whitelisted executable run directly, e.g. `node script.js`,
  `python tool.py`, `pnpm test`
- a leading simple environment-assignment prefix, e.g. `CI=1 pnpm test`
  (wrappers such as `env`, `nohup`, `time`, `command` are not supported)

Literal paths only: no variables, globs, `~` expansion or command substitution.

### Unsupported → fail-closed (whole command, no partial results)

- unquoted LF/CRLF command boundaries, `;`, `&&`, `||`, pipelines (`|`), background (`&`), parentheses/subshells
- `$(…)`, backtick command substitution, heredoc/here-string (`<<`, `<<<`)
- unterminated quotes, dynamic `eval`/`source`/`.`-sourcing
- non-literal (variable/glob) redirect targets or arguments
- `>>`, `<`, `2>` and all other redirections beyond a single `>`
- executables outside the v0.1 whitelist

### Supported PowerShell (single directly invoked whitelisted cmdlet)

- `Set-Content -Path/-LiteralPath <literal> [-Value <literal>] [-Encoding <literal>] [-NoNewline]`
- `Add-Content -Path/-LiteralPath <literal> [-Value <literal>] [-Encoding <literal>] [-NoNewline]`
- `New-Item -Path <literal> [-Value <literal>] [-ItemType <literal>]`
- `Out-File -FilePath/-LiteralPath <literal> [-Encoding <literal>] [-NoNewline]`
- `Get-Content -Path/-LiteralPath <literal> [-Encoding <literal>] [-Raw]`

Requirements: the cmdlet must be unquoted at the command position; the path must
come from the explicit named path parameter; a quoted path is one token (spaces
allowed); permitted value parameters (`-Value`, `-Encoding`, and `-ItemType`
where listed above) never contribute subjects;
`-WhatIf` and `-Confirm` are unsupported because they can avoid or defer the
claimed effect; positional paths, variables, expressions, `Join-Path`,
subexpressions, pipelines, `;`, script blocks, `&`, dot sourcing, `Copy-Item`,
`Move-Item`, `Rename-Item` and `.NET WriteAllText` are unsupported and fail the
WHOLE command.

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
