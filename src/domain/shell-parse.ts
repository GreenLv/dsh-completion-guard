import type { GuardOperation } from './types.js'

/**
 * v0.1 certifiable command subset parser.
 *
 * This is NOT a general Bash or PowerShell static analyzer. Only a small,
 * auditable grammar is supported: a single foreground simple command whose
 * grammar parses fully. Anything else returns `status: 'unsupported'` (or
 * `'malformed'` for unterminated quotes) with EMPTY executables and operations,
 * so an unrecognized command can never certify an operation. False negatives
 * are preferred over false positives: uncertain commands stay incomplete.
 */

export type ShellParseStatus = 'supported' | 'unsupported' | 'malformed'

export interface ParsedShell {
  status: ShellParseStatus
  /** Human-readable reason when the command is not supported (or malformed). */
  reason?: string
  executables: string[]
  operations: Array<{ op: GuardOperation; path?: string }>
  malformed: boolean
}

interface ShellToken {
  kind: 'word' | 'op'
  value: string
  quoted: boolean
}

const TWO_CHAR_OPS = new Set(['&&', '||', '>>', '<<', '<&', '>&', '|&'])
const STATEMENT_OPS = new Set(['&&', '||', '|', '|&', '&', ';', '\n', '(', ')'])

/**
 * Quote-aware shell tokenizer. Single quotes are literal, double quotes allow
 * `\` escapes, and backslash escapes are honored outside quotes. Unterminated
 * quotes mark the input as malformed.
 */
function tokenizeShell(command: string): { tokens: ShellToken[]; malformed: boolean } {
  const tokens: ShellToken[] = []
  let index = 0
  let malformed = false
  const length = command.length
  while (index < length) {
    const char = command[index]
    if (char === '\n' || char === '\r') {
      tokens.push({ kind: 'op', value: '\n', quoted: false })
      index += char === '\r' && command[index + 1] === '\n' ? 2 : 1
      continue
    }
    if (char === ' ' || char === '\t') {
      index += 1
      continue
    }
    const two = command.slice(index, index + 2)
    if (TWO_CHAR_OPS.has(two)) {
      tokens.push({ kind: 'op', value: two, quoted: false })
      index += 2
      continue
    }
    if (char === ';' || char === '|' || char === '&' || char === '(' || char === ')' || char === '<' || char === '>') {
      tokens.push({ kind: 'op', value: char, quoted: false })
      index += 1
      continue
    }
    let word = ''
    let quoted = false
    let quote: '\'' | '"' | null = null
    while (index < length) {
      const current = command[index]
      if (quote === '\'') {
        if (current === '\'') {
          quote = null
          index += 1
          continue
        }
        quoted = true
        word += current
        index += 1
        continue
      }
      if (quote === '"') {
        if (current === '"') {
          quote = null
          index += 1
          continue
        }
        quoted = true
        if (current === '\\' && index + 1 < length) {
          word += command[index + 1]
          index += 2
          continue
        }
        word += current
        index += 1
        continue
      }
      if (current === '\'') {
        quote = '\''
        index += 1
        continue
      }
      if (current === '"') {
        quote = '"'
        index += 1
        continue
      }
      if (current === '\\' && index + 1 < length) {
        word += command[index + 1]
        index += 2
        continue
      }
      if (current === ' ' || current === '\t' || current === '\n' || current === '\r') break
      if (current === ';' || current === '|' || current === '&' || current === '(' || current === ')' || current === '<' || current === '>') break
      if (TWO_CHAR_OPS.has(command.slice(index, index + 2))) break
      word += current
      index += 1
    }
    if (quote !== null) {
      malformed = true
      break
    }
    if (word) tokens.push({ kind: 'word', value: word, quoted })
  }
  return { tokens, malformed }
}

/** Characters that indicate non-literal paths (variables, expansion, globs). */
const DYNAMIC_PATH = /[$`~*?[\]{}]/u

function isLiteralPath(value: string): boolean {
  return value.length > 0 && !DYNAMIC_PATH.test(value)
}

/** v0.1 whitelist: single foreground simple commands only. */
const SHELL_FILE_TOOLS = new Set(['printf', 'echo', 'touch', 'cat'])
/** Read-only inspection tools: every pathish argument counts as a read effect. */
const SHELL_READ_TOOLS = new Set(['cat', 'grep', 'rg', 'head', 'tail', 'wc', 'sed'])
const SHELL_RUN_EXECUTABLES = new Set([
  'node', 'python', 'python3', 'pnpm', 'npm', 'yarn', 'bun',
  'pytest', 'vitest', 'jest', 'tsc', 'eslint', 'mypy', 'ruff', 'prettier',
  'go', 'cargo', 'make', 'cmake', 'git', 'mvn', 'gradle', 'tox', 'nox',
])

/**
 * Whether an executable carries run semantics (as opposed to the tiny
 * file/read tool subset). Used for scope-subject attribution of a pathless
 * run operation; `echo` or `cat` never becomes a subject-carrying run.
 */
export function isRunExecutable(executable: string): boolean {
  return SHELL_RUN_EXECUTABLES.has(executable.toLowerCase())
}

/** Looks like a filesystem path: contains a separator, or a file extension. */
function isPathish(value: string): boolean {
  return /[\\/]/.test(value) || /^\.\.?(\/|$)/.test(value) || /\.(?:[A-Za-z0-9][A-Za-z0-9_-]{0,15})$/.test(value)
}

function unsupported(reason: string): ParsedShell {
  return { status: 'unsupported', reason, executables: [], operations: [], malformed: false }
}

/**
 * Parse one POSIX shell command against the v0.1 supported surface: a single
 * foreground simple command made of an env-assignment prefix, one whitelisted
 * executable and literal arguments, with at most one `>`/`>>` redirect to a
 * literal path. Compound syntax (`;`, `&&`, `||`, pipes, background, subshells,
 * command substitution, heredocs, unclosed quotes, dynamic eval/source,
 * variable/glob paths) makes the WHOLE command unsupported with no partial
 * results.
 */
export function parseShellCommand(command: string): ParsedShell {
  const { tokens, malformed } = tokenizeShell(command)
  if (malformed) return { status: 'malformed', reason: 'unterminated quote', executables: [], operations: [], malformed: true }
  if (tokens.length === 0) return { status: 'supported', executables: [], operations: [], malformed: false }

  const writePaths: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    // Diagnostic stream duplication (`2>&1`, `1>&2`) is a pure fd copy with no
    // filesystem effect and does not change the command's exit semantics.
    if (token.kind === 'word' && /^\d+$/.test(token.value) &&
      tokens[index + 1]?.kind === 'op' && tokens[index + 1]?.value === '>&' &&
      tokens[index + 2]?.kind === 'word' && /^\d+$/.test(tokens[index + 2].value)) {
      index += 2
      continue
    }
    if (token.kind === 'word' && /^\d+$/.test(token.value) && tokens[index + 1]?.kind === 'op' &&
      (tokens[index + 1]?.value === '>' || tokens[index + 1]?.value === '>>')) {
      return unsupported('file-descriptor-prefixed file redirect is not in the v0.1 subset')
    }
    if (token.kind === 'op') {
      if (token.value === '>') {
        const next = tokens[index + 1]
        if (!next || next.kind !== 'word') return unsupported('redirect target is not a literal word')
        if (!isLiteralPath(next.value)) return unsupported('non-literal redirect path')
        writePaths.push(next.value)
        index += 1
        continue
      }
      if (token.value === '>>' || token.value === '<' || token.value === '<<' || token.value === '<&' || token.value === '>&') {
        return unsupported(`redirect '${token.value}' is not in the v0.1 subset`)
      }
      if (STATEMENT_OPS.has(token.value)) {
        return unsupported(`statement operator '${token.value}' is not in the v0.1 subset`)
      }
      return unsupported(`operator '${token.value}' is not in the v0.1 subset`)
    }
  }
  if (writePaths.length > 1) return unsupported('multiple write redirects are not in the v0.1 subset')

  // Leading environment-assignment prefix is allowed; nothing else may precede
  // the executable. No wrappers (env/nohup/time/command) and no dynamic
  // constructs.
  const wordTokens = tokens.filter((token) => token.kind === 'word')
  let executableIndex = 0
  while (executableIndex < wordTokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(wordTokens[executableIndex].value)) executableIndex += 1
  const executableToken = wordTokens[executableIndex]
  const executable = executableToken?.value ?? ''
  if (!executable) return unsupported('no executable')
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(executable)) return unsupported('executable is not a plain literal name')
  if (executableToken.quoted) return unsupported('quoted executable is not in the v0.1 subset')
  const assignments = wordTokens.slice(0, executableIndex).map((token) => token.value)
  if (assignments.some((word) => !isLiteralPath(word))) return unsupported('dynamic environment assignment')
  const exe = executable.toLowerCase()
  if (!SHELL_FILE_TOOLS.has(exe) && !SHELL_READ_TOOLS.has(exe) && !SHELL_RUN_EXECUTABLES.has(exe)) {
    return unsupported(`executable '${executable}' is not in the v0.1 whitelist`)
  }
  const args = wordTokens.slice(executableIndex + 1).map((token) => token.value)
  if (args.some((arg) => !isLiteralPath(arg))) return unsupported('non-literal argument')
  const pathishArgs = args.filter((arg) => isPathish(arg))

  const operations: Array<{ op: GuardOperation; path?: string }> = []
  for (const path of writePaths) operations.push({ op: 'create', path })
  if (exe === 'touch') {
    for (const path of pathishArgs) operations.push({ op: 'create', path })
  } else if (SHELL_READ_TOOLS.has(exe)) {
    if (exe === 'sed' && args.some((arg) => /^-i($|[A-Za-z0-9])|^--in-place/.test(arg))) {
      return unsupported('in-place sed editing is not in the v0.1 subset')
    }
    for (const path of pathishArgs) operations.push({ op: 'read', path })
  }
  operations.push({ op: 'run', ...(pathishArgs[0] !== undefined ? { path: pathishArgs[0] } : {}) })
  return { status: 'supported', executables: [executable], operations, malformed: false }
}

// ---------------------------------------------------------------------------
// PowerShell v0.1 subset
// ---------------------------------------------------------------------------

interface PwshCmdletSpec {
  op: GuardOperation
  pathParams: string[]
  valueParams: string[]
  switchParams: string[]
}

const PWSH_CMDLETS: Record<string, PwshCmdletSpec> = {
  'set-content': {
    op: 'create',
    pathParams: ['-path', '-literalpath'],
    valueParams: ['-value', '-encoding'],
    switchParams: ['-nonewline'],
  },
  'add-content': {
    op: 'create',
    pathParams: ['-path', '-literalpath'],
    valueParams: ['-value', '-encoding'],
    switchParams: ['-nonewline'],
  },
  'new-item': {
    op: 'create',
    pathParams: ['-path'],
    valueParams: ['-value', '-itemtype'],
    switchParams: [],
  },
  'out-file': {
    op: 'create',
    pathParams: ['-filepath', '-literalpath'],
    valueParams: ['-encoding'],
    switchParams: ['-nonewline'],
  },
  'get-content': {
    op: 'read',
    pathParams: ['-path', '-literalpath'],
    valueParams: ['-encoding'],
    switchParams: ['-raw'],
  },
}

interface PwshToken {
  value: string
  quoted: boolean
}

/** PowerShell tokenizer: quoted strings (backtick-escaped) are one word. */
function tokenizePwsh(command: string): { words: PwshToken[]; malformed: boolean } {
  const words: PwshToken[] = []
  let index = 0
  let malformed = false
  const length = command.length
  while (index < length) {
    const char = command[index]
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1
      continue
    }
    if (char === '\'' || char === '"') {
      const quote = char
      let word = ''
      let closed = false
      index += 1
      while (index < length) {
        const current = command[index]
        if (current === '`') {
          malformed = true
          break
        }
        if (current === quote) {
          closed = true
          index += 1
          break
        }
        word += current
        index += 1
      }
      if (!closed) malformed = true
      words.push({ value: word, quoted: true })
      continue
    }
    let word = ''
    while (index < length) {
      const current = command[index]
      if (current === ' ' || current === '\t' || current === '\n' || current === '\r') break
      if (current === '`') malformed = true
      word += current
      index += 1
      if (malformed) break
    }
    words.push({ value: word, quoted: false })
  }
  return { words, malformed }
}

/** Unsupported PowerShell structure outside quoted strings. */
function readPwshUnsupported(command: string): { unsupported: boolean; reason?: string } {
  let inSingle = false
  let inDouble = false
  let index = 0
  while (index < command.length) {
    const char = command[index]
    if (inSingle) {
      if (char === '\'') inSingle = false
      index += 1
      continue
    }
    if (inDouble) {
      if (char === '`') {
        return { unsupported: true, reason: 'backtick escape' }
      }
      if (char === '$') return { unsupported: true, reason: 'variable or subexpression' }
      if (char === '"') inDouble = false
      index += 1
      continue
    }
    if (char === '\'') {
      inSingle = true
      index += 1
      continue
    }
    if (char === '"') {
      inDouble = true
      index += 1
      continue
    }
    if (char === '`') return { unsupported: true, reason: 'backtick escape' }
    if (char === '$') return { unsupported: true, reason: 'variable or subexpression' }
    if (char === '\n' || char === '\r') return { unsupported: true, reason: 'unquoted newline' }
    if (char === '&') {
      // `2>&1`-style diagnostic stream duplication is allowed; the tokenizer
      // keeps it as one unquoted word that the parsers strip. Anything else
      // with `&` (call operator, compound, `&>` file redirect) stays invalid.
      const previous = command[index - 1] ?? ''
      const next = command[index + 1] ?? ''
      if (previous === '>' && /[0-9]/.test(next)) {
        index += 1
        continue
      }
      return { unsupported: true, reason: 'structure character &' }
    }
    if (char === ';' || char === '|' || char === '{' || char === '}' || char === '(' || char === ')' || char === '[' || char === ']' || char === ',') {
      return { unsupported: true, reason: `structure character '${char}'` }
    }
    index += 1
  }
  if (/^\s*\./.test(command)) return { unsupported: true, reason: 'dot sourcing' }
  return { unsupported: false }
}

/** PowerShell v0.2 subset: external executables with literal arguments. */
const PWSH_EXTERNAL_EXECUTABLES = new Set([
  'node', 'python', 'python3', 'pnpm', 'npm', 'yarn', 'bun',
  'pytest', 'vitest', 'jest', 'tsc', 'eslint', 'mypy', 'ruff', 'prettier',
  'go', 'cargo', 'make', 'cmake', 'git', 'mvn', 'gradle', 'tox', 'nox',
])

/**
 * Parse one PowerShell command against the v0.2 subset: a single, directly
 * invoked whitelisted cmdlet (Set-Content / Add-Content / New-Item /
 * Out-File / Get-Content) whose path comes from an explicit named path
 * parameter, or a whitelisted external executable (git, pnpm, node, …) with
 * all-literal arguments. Unquoted `N>&M` diagnostic stream duplication is
 * stripped. Multi-statements (`;`), pipelines (`|`), the call operator (`&`),
 * script blocks, dot sourcing, .NET/dynamic invocation,
 * variable/expression/subexpression paths, positional paths, and unknown
 * parameters make the WHOLE command unsupported.
 */
export function parsePwshCommand(command: string): ParsedShell {
  const dynamic = readPwshUnsupported(command)
  if (dynamic.unsupported) return unsupported(`dynamic or compound PowerShell syntax (${dynamic.reason ?? 'unknown'})`)
  const { words: rawWords, malformed } = tokenizePwsh(command)
  if (malformed) return { status: 'malformed', reason: 'unterminated quote or escape', executables: [], operations: [], malformed: true }
  const words = rawWords.filter((word) => !(word.quoted === false && /^[0-9]*>&[0-9]+$/.test(word.value)))
  if (words.length === 0) return { status: 'supported', executables: [], operations: [], malformed: false }

  const cmdletRaw = words[0].value
  const spec = PWSH_CMDLETS[cmdletRaw.toLowerCase()]
  const external = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(cmdletRaw) && PWSH_EXTERNAL_EXECUTABLES.has(cmdletRaw.toLowerCase())
  if (!spec && !external) return unsupported(`command '${cmdletRaw}' is not in the v0.1 whitelist`)
  if (words[0].quoted) return unsupported('quoted command name is not in the v0.1 subset')
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(cmdletRaw)) return unsupported('dynamic or .NET invocation is not in the v0.1 subset')

  if (external) {
    const args = words.slice(1).map((token) => token.value)
    if (args.some((arg) => !isLiteralPath(arg))) return unsupported('non-literal argument')
    const pathishArgs = args.filter((arg) => isPathish(arg))
    return {
      status: 'supported',
      executables: [cmdletRaw],
      operations: [{ op: 'run', ...(pathishArgs[0] !== undefined ? { path: pathishArgs[0] } : {}) }],
      malformed: false,
    }
  }

  const paths: string[] = []
  let expected: 'path' | 'value' | null = null
  for (let index = 1; index < words.length; index += 1) {
    const token = words[index]
    const low = token.value.toLowerCase()
    if (token.value.startsWith('-')) {
      if (spec.pathParams.includes(low)) {
        expected = 'path'
        continue
      }
      if (spec.valueParams.includes(low)) {
        expected = 'value'
        continue
      }
      if (spec.switchParams.includes(low)) {
        expected = null
        continue
      }
      return unsupported(`parameter '${token.value}' is not in the v0.1 whitelist`)
    }
    if (expected === 'path') {
      if (!isLiteralPath(token.value)) return unsupported('non-literal path')
      paths.push(token.value)
      expected = null
      continue
    }
    if (expected === 'value') {
      expected = null
      continue
    }
    // A value outside a named value parameter: positional arguments are not in
    // the v0.1 subset.
    return unsupported('positional argument is not in the v0.1 subset')
  }
  if (expected !== null) return unsupported('missing parameter value')

  const operations: Array<{ op: GuardOperation; path?: string }> = []
  for (const path of paths) operations.push({ op: spec.op, path })
  return { status: 'supported', executables: [cmdletRaw], operations, malformed: false }
}
