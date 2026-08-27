import type { GuardOperation } from './types.js'

/**
 * The single source of truth for the certifiable command surface (v0.2).
 *
 * Every enumeration that decides which command shapes can produce evidence
 * lives HERE, loaded by the parsers and by the contract capture. Adding a tool
 * or a task verb is a data change, not a code change. The manifest is shipped
 * with the package and is intentionally NOT runtime-writable: widening the
 * surface lowers the evidence bar, so it must change only through a reviewed
 * release, never through local configuration.
 */

export interface OperationVerbEntry {
  op: GuardOperation
  /** RegExp source, matched case-insensitively; array order = priority. */
  pattern: string
}

export interface CommandSurfaceManifest {
  /** POSIX file-effect tools (`printf`, `echo`, `touch`, `cat`). */
  fileTools: string[]
  /** POSIX read-only inspection tools; pathish args become read effects. */
  readTools: string[]
  /** POSIX run-executable whitelist (any supported simple command gets run semantics). */
  runExecutables: string[]
  /** PowerShell external-executable whitelist (mirrors runExecutables). */
  pwshExternalExecutables: string[]
  /**
   * Clause verb → operation mapping. Order matters: the first matching group
   * wins, and the group order is create → modify → read → verify → run.
   */
  operationVerbs: OperationVerbEntry[]
}

export const COMMAND_SURFACE_MANIFEST: CommandSurfaceManifest = {
  fileTools: ['printf', 'echo', 'touch', 'cat'],
  readTools: ['cat', 'grep', 'rg', 'head', 'tail', 'wc', 'sed'],
  runExecutables: [
    'node', 'python', 'python3', 'pnpm', 'npm', 'yarn', 'bun',
    'pytest', 'vitest', 'jest', 'tsc', 'eslint', 'mypy', 'ruff', 'prettier',
    'go', 'cargo', 'make', 'cmake', 'git', 'mvn', 'gradle', 'tox', 'nox',
    'dsh',
  ],
  pwshExternalExecutables: [
    'node', 'python', 'python3', 'pnpm', 'npm', 'yarn', 'bun',
    'pytest', 'vitest', 'jest', 'tsc', 'eslint', 'mypy', 'ruff', 'prettier',
    'go', 'cargo', 'make', 'cmake', 'git', 'mvn', 'gradle', 'tox', 'nox',
    'dsh',
  ],
  operationVerbs: [
    { op: 'create', pattern: '创建|生成|新建|touch|\\bcreates?\\b|\\bcreated\\b|\\bcreating\\b|\\bwrite\\b|写入' },
    { op: 'modify', pattern: '修改|编辑|更改|modif(?:y|ies|ied|ying)|\\bedit\\b|改' },
    { op: 'read', pattern: '读取|阅读|打开|读(?![A-Za-z0-9])|\\bread\\b' },
    { op: 'verify', pattern: '验证|确认|确保|检查|verif(?:y|ies|ied|ying)|\\bconfirm\\b|\\bconfirms\\b|\\bconfirmed\\b|\\bensure\\b' },
    {
      op: 'run',
      pattern: '运行|执行|拉取|获取|同步|更新|下载|安装|部署|上传|提交|推送|发布|升级|重启|重新启动|重载'
        + '|\\brun\\b|execute(?:d)?|\\bpull\\b|\\bfetch\\b|\\bclone\\b|\\bsync\\b|\\bupdate\\b|\\binstall\\b|\\bdeploy\\b|\\bcommit\\b|\\bpush\\b'
        + '|\\brelease\\b|\\bdownload\\b|\\bupload\\b|\\brestart\\b|\\breload\\b|\\breboot\\b',
    },
  ],
}

const OPERATION_ORDER: GuardOperation[] = ['create', 'modify', 'read', 'verify', 'run']

export interface ManifestIssue {
  path: string
  message: string
}

/**
 * Validate the manifest invariants the parsers and capture depend on:
 * - every collection is non-empty, sorted-case-insensitively, and duplicate-free
 * - external executables mirror the POSIX run set exactly
 * - verb groups exist once, in the documented priority order, and compile
 * (they compile by construction when validated, so a typo cannot silently
 * widen or break the surface).
 */
export function validateManifest(manifest: CommandSurfaceManifest = COMMAND_SURFACE_MANIFEST): ManifestIssue[] {
  const issues: ManifestIssue[] = []
  const sets: Array<[string, readonly string[]]> = [
    ['fileTools', manifest.fileTools],
    ['readTools', manifest.readTools],
    ['runExecutables', manifest.runExecutables],
    ['pwshExternalExecutables', manifest.pwshExternalExecutables],
  ]
  for (const [name, values] of sets) {
    if (!values.length) issues.push({ path: name, message: 'must not be empty' })
    const sorted = [...values].map((value) => value.toLowerCase()).sort()
    if (sorted.some((value, index) => index > 0 && value === sorted[index - 1])) {
      issues.push({ path: name, message: 'contains duplicates' })
    }
  }
  if (
    manifest.runExecutables.length !== manifest.pwshExternalExecutables.length
    || [...manifest.runExecutables].map((value) => value.toLowerCase()).sort().join(',')
      !== [...manifest.pwshExternalExecutables].map((value) => value.toLowerCase()).sort().join(',')
  ) {
    issues.push({ path: 'pwshExternalExecutables', message: 'must mirror runExecutables exactly' })
  }
  const seenOps = new Set<GuardOperation>()
  for (const entry of manifest.operationVerbs) {
    if (seenOps.has(entry.op)) issues.push({ path: `operationVerbs.${entry.op}`, message: 'duplicate operation group' })
    seenOps.add(entry.op)
    try {
      new RegExp(entry.pattern, 'i')
    } catch {
      issues.push({ path: `operationVerbs.${entry.op}`, message: `uncompilable pattern: ${entry.pattern}` })
    }
  }
  const order = manifest.operationVerbs.map((entry) => entry.op)
  const expected = OPERATION_ORDER.filter((operation) => seenOps.has(operation))
  if (order.join(',') !== expected.join(',')) {
    issues.push({ path: 'operationVerbs', message: `priority order must be ${expected.join(' → ')}` })
  }
  return issues
}
