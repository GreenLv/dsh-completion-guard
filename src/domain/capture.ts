import { normalizeClause, sanitizeClauseText, sha256 } from './canonicalize.js'
import { COMMAND_SURFACE_MANIFEST } from './manifest.js'
import { semanticActionFromText, type SemanticAction } from './protocol-manifest.js'
import { canonicalRegistryBase } from './registry.js'
import type { GuardItem, GuardItemKind, GuardOperation, TargetCaptureReasonCode, TargetTuple } from './types.js'

const CLAUSE_PATTERNS: Array<[GuardItemKind, RegExp]> = [
  ['prohibition', /^(?:(?:do not|don't|never)(?![A-Za-z0-9_./@\\-])|禁止|不要|不得)\s*(.+)$/i],
  ['acceptance', /^(?:verify|confirm|ensure|验收|确认|确保)\s*(.+)$/i],
]

export interface ClassifiedClause {
  kind: GuardItemKind
  body: string
}

export function classifyClause(text: string): ClassifiedClause {
  const normalizedText = normalizeClause(text)
  for (const [kind, pattern] of CLAUSE_PATTERNS) {
    const match = normalizedText.match(pattern)
    if (match) return { kind, body: normalizeClause(match[1].replace(/^[:：,，\s]+/, '')) }
  }
  return { kind: 'requirement', body: normalizedText }
}

const METHOD_TOOL = '(?:bash|shell|powershell|pwsh|git|read|write|edit|node|python|python3|npm|pnpm|tsc|vitest)'
const METHOD_ALIASES: Record<string, string> = { powershell: 'pwsh', python3: 'python' }
const METHOD_PATTERNS = [
  new RegExp(`(?:用|使用|通过|借助|利用|以)\\s*(${METHOD_TOOL})\\b`, 'i'),
  new RegExp(`\\b(?:via|using|use|with)\\s+(?:the\\s+)?(${METHOD_TOOL})\\b`, 'i'),
  new RegExp(`\\b(${METHOD_TOOL})\\s+(?:创建|写入|生成|修改|执行|运行|rename|create|write|modify)\\b`, 'i'),
]

/**
 * Detect an explicitly named tool/method in a clause ("使用 bash 创建",
 * "via bash", "bash to create"). Returns the canonical tool id (e.g. 'bash')
 * or undefined when no explicit method is named.
 */
export function extractMethod(text: string): string | undefined {
  for (const pattern of METHOD_PATTERNS) {
    const match = text.match(pattern)
    if (match) {
      const raw = match[1].toLowerCase()
      return METHOD_ALIASES[raw] ?? raw
    }
  }
  return undefined
}

const OPERATION_PATTERNS: Array<[GuardOperation, RegExp]> = COMMAND_SURFACE_MANIFEST.operationVerbs.map((entry) => [entry.op, new RegExp(entry.pattern, 'i')])

/**
 * Whether a whole user message reads as an informational report (acceptance
 * receipt, progress summary, pasted log) rather than a task instruction.
 * Evaluation is deliberately conservative: reports are detected only when the
 * shape is clearly report-like (markdown headings, bold key/value lines, list
 * or table rows, evidence terms) AND no sentence opens with an imperative, and
 * any question mark keeps the message a task. False positives here would drop
 * real instructions, so plain short sentences are never treated as reports.
 */
export function isInformationalMessage(text: string): boolean {
  if (!text.trim()) return false
  if (/[？?]|是否|是不是/.test(text)) return false
  const lines = text.split(/\r?\n/)
  const titledLines = lines.filter((line) => /^\s{0,3}#{1,6}\s+/.test(line)).length
  const evidenceLines = lines.filter((line) => /^\s*(?:[-*|]\s{0,2}|\*\*.+?\*\*)/.test(line)).length
  const evidenceTerms = (text.match(/\b(?:commit|passed|failed|exit\s+code|checkpoint|verify|回执|汇总|状态|通过|全绿|验收|读回|回读)\b|✓|\b[0-9a-f]{40}\b/g) ?? []).length
  const reportShape = (titledLines >= 1 && evidenceTerms >= 2)
    || (evidenceLines >= 2 && evidenceTerms >= 2)
    || evidenceTerms >= 4
  if (!reportShape) return false
  const imperativeLead = /^(?:请|请你|麻烦|帮我|需要你|你看看|看一下|检查一下|分析|列出|回顾|修复|推送|安装|确认|验证|能否|能不能)/i
  const sentences = text.split(/(?<=[。！？；\n])|(?<=[.!?])(?=\s|$)/)
  return !sentences.some((sentence) => imperativeLead.test(sentence.trim()))
}

/**
 * Detect an explicit operation/effect in a clause ("创建" → create,
 * "读取" → read, "运行" → run). Returns the first operation named, or undefined
 * when the clause requests no specific effect.
 */
export function extractOperation(text: string): GuardOperation | undefined {
  for (const [operation, pattern] of OPERATION_PATTERNS) {
    if (pattern.test(text)) return operation
  }
  return undefined
}

export interface CaptureScope {
  /** Session working directory; used as the scope subject when no artifact path is named. */
  cwd?: string
}

interface CapturedRequestedTarget {
  target: TargetTuple
  reasonCode?: TargetCaptureReasonCode
}

const TARGET_TOKEN = '(?:`[^`]+`|"[^"]+"|\'[^\']+\'|[\\p{L}\\p{N}@][\\p{L}\\p{N}@._/\\\\:+%?&=#\\[\\]-]*)'

function unquoteTargetToken(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim().replace(/[.,;，。；]+$/, '')
  const unquoted = /^(?:`([^`]+)`|"([^"]+)"|'([^']+)')$/.exec(trimmed)
  return (unquoted?.[1] ?? unquoted?.[2] ?? unquoted?.[3] ?? trimmed) || undefined
}

function labeledToken(text: string, labels: string): string | undefined {
  const match = new RegExp(`(?:${labels})\\s*(?:[:=：]|为|是)?\\s*(${TARGET_TOKEN})`, 'iu').exec(text)
  return unquoteTargetToken(match?.[1])
}

function actionObjectToken(text: string, verbs: string, nouns: string): string | undefined {
  const match = new RegExp(`(?:${verbs})\\s*(?:(?:${nouns})\\s*)?(?:[:=：]|为)?\\s*(${TARGET_TOKEN})`, 'iu').exec(text)
  const token = unquoteTargetToken(match?.[1])
  if (!token || /^(?:the|a|an|this|that|to|from|in|on|into|with|package|plugin|artifact|service|repository|repo|包|插件|制品|服务|仓库)$/i.test(token)) return undefined
  return token
}

function splitPackageSpec(spec: string | undefined): { packageId?: string; version?: string } {
  if (!spec) return {}
  const at = spec.lastIndexOf('@')
  if (at > 0) return { packageId: spec.slice(0, at), version: spec.slice(at + 1) || undefined }
  return { packageId: spec }
}

function parentScope(subject: string): string {
  const separator = Math.max(subject.lastIndexOf('/'), subject.lastIndexOf('\\'))
  if (separator < 0) return 'scope'
  if (separator === 0) return subject[0]
  if (separator === 2 && /^[A-Za-z]:[\\/]$/.test(subject.slice(0, 3))) return subject.slice(0, 3)
  return subject.slice(0, separator)
}

function captureRequestedTarget(
  action: SemanticAction,
  text: string,
  subject: string,
  surface: 'artifact' | 'scope',
): CapturedRequestedTarget {
  if (action === 'create' || action === 'modify') {
    if (surface !== 'artifact') return { target: {}, reasonCode: 'requested_target_artifact_id_missing' }
    return { target: { artifact_id: subject, scope: parentScope(subject) } }
  }
  if (action === 'install' || action === 'apply') {
    const spec = actionObjectToken(
      text,
      action === 'install' ? 'install|add|安装' : 'apply|应用',
      'package|plugin|包|插件',
    )
    const parsed = splitPackageSpec(spec)
    if (!parsed.packageId) return { target: {}, reasonCode: 'requested_target_package_id_missing' }
    const profile = labeledToken(text, 'profile|配置(?:档|文件)?')
    const version = parsed.version ?? labeledToken(text, 'version|版本')
    return { target: {
      package_id: parsed.packageId,
      ...(version ? { version } : {}),
      ...(profile ? { profile } : {}),
    } }
  }
  if (action === 'restart') {
    const service = labeledToken(text, 'service(?:_id)?|服务')
      ?? actionObjectToken(text, 'restart|reload|重启|重新启动', 'service|服务')
    return service
      ? { target: { service_id: service } }
      : { target: {}, reasonCode: 'requested_target_service_id_missing' }
  }
  if (action === 'publish') {
    const spec = actionObjectToken(text, 'publish|release|发布', 'package|artifact|包|制品')
    const parsed = splitPackageSpec(spec)
    if (!parsed.packageId) return { target: {}, reasonCode: 'requested_target_artifact_id_missing' }
    const version = parsed.version ?? labeledToken(text, 'version|版本')
    const registry = canonicalRegistryBase(labeledToken(text, 'registry|注册表|仓库地址') ?? '')
    if (!registry) return { target: {}, reasonCode: 'requested_target_registry_missing_or_invalid' }
    return { target: {
      artifact_id: parsed.packageId,
      ...(version ? { version } : {}),
      registry,
    } }
  }
  if (action === 'pull' || action === 'fetch' || action === 'commit' || action === 'push') {
    const repository = labeledToken(text, 'repository|repo|仓库')
      ?? (subject !== 'scope' ? subject : undefined)
    if (!repository) return { target: {}, reasonCode: 'requested_target_repository_missing' }
    const branch = labeledToken(text, 'branch|分支')
    const remote = labeledToken(text, 'remote|远端')
    const refspec = labeledToken(text, 'refspec|引用规范') ?? (action !== 'commit' ? branch : undefined)
    return { target: {
      repository,
      ...(action === 'commit' && branch ? { branch } : {}),
      ...(action !== 'commit' && remote ? { remote } : {}),
      ...(action !== 'commit' && refspec ? { refspec } : {}),
    } }
  }
  return { target: surface === 'artifact'
    ? { artifact_id: subject, scope: parentScope(subject) }
    : { scope: subject } }
}

const EXTENSION = '(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|c|cpp|h|hpp|cs|rb|php|vue|svelte|md|mdx|json|jsonc|yml|yaml|toml|ini|cfg|sh|bash|zsh|fish|ps1|html|css|scss|less|sql|txt|lock|mod|sum|env|patch|diff|pkl|tf|hcl|proto)'
const EXTENSION_TAIL = new RegExp(`\\.${EXTENSION}(?:$|[^A-Za-z0-9])`, 'i')

function isArtifactCandidate(value: string): boolean {
  return EXTENSION_TAIL.test(value)
}

/** Wrapped path spellings: backticks, double/single quotes, and parentheses. */
const WRAPPED_PATH = /`([^`]+)`|"([^"]+)"|'([^']+)'|\(([^()]+)\)/g

export function extractArtifactPaths(text: string): string[] {
  const found = new Set<string>()
  const push = (candidate: string) => {
    const trimmed = candidate.trim()
    if (trimmed && isArtifactCandidate(trimmed)) found.add(trimmed)
  }
  for (const match of text.matchAll(WRAPPED_PATH)) {
    push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? '')
  }
  // Bare tokens (no whitespace), Unicode-inclusive; strip trailing punctuation.
  for (const token of text.split(/[\s,;，；]+/)) {
    const bare = token.replace(/^[('"]+|['")]+$/g, '').replace(/[。！？；.!?，,；:：]+$/, '')
    if (bare && !bare.includes('`') && isArtifactCandidate(bare)) found.add(bare)
  }
  return [...found]
}

/**
 * Split a single human message into independently tracked clauses. Sentence
 * boundaries and embedded prohibition keywords delimit segments so a compound
 * instruction such as "Modify src/a.ts and src/b.ts. Do not push." yields
 * separate items instead of collapsing into one artifact.
 */
export interface ClauseSegment {
  kind: GuardItemKind
  body: string
  paths: string[]
}

export function segmentClauses(text: string): ClauseSegment[] {
  const normalized = normalizeClause(text)
  if (!normalized) return []
  const parts = normalized
    .split(/(?<=[。！？；])|(?<=[.!?])(?=\s|$)|(?<=(?:^|[\s。！？；.!?，,；:]))(?=(?:(?:do not|don't|never)(?![A-Za-z0-9_./@\\-])|禁止|不要|不得))/i)
    .map((part) => part.trim())
    .filter(Boolean)
  const segments: ClauseSegment[] = []
  for (const part of parts) {
    const { kind, body } = classifyClause(part)
    segments.push({ kind, body, paths: extractArtifactPaths(body) })
  }
  return segments
}

/**
 * Build a GuardItem from an already-classified clause body and a resolved
 * verification subject/surface.
 */
export function captureItem(
  kind: GuardItemKind,
  body: string,
  sourceMessageId: string,
  id: string,
  revision: number,
  subject: string,
  surface: 'artifact' | 'scope',
  method?: string,
  operation?: GuardOperation,
): GuardItem {
  const sanitized = sanitizeClauseText(body)
  const semanticAction = semanticActionFromText(sanitized)
  const capturedTarget = captureRequestedTarget(semanticAction, sanitized, subject, surface)
  const effectiveOperation = semanticAction === 'verify' ? 'verify' : operation
  const item: GuardItem = {
    id,
    revision,
    kind,
    sourceMessageId,
    normalizedText: sanitized,
    textSha256: sha256(sanitized),
    status: 'pending',
    verification: kind === 'prohibition'
      ? { enforced: false, surface, subject }
      : { enforced: true, surface, subject, method, operation: effectiveOperation },
    semanticAction,
    requestedTarget: capturedTarget.target,
    targetCaptureStatus: capturedTarget.reasonCode ? 'clarification_required' : 'resolved',
    ...(capturedTarget.reasonCode ? { targetCaptureReasonCode: capturedTarget.reasonCode } : {}),
    authority: 'root_instruction',
  }
  if (/(?:等待|暂停|等).{0,12}(?:用户|你|您|我).{0,12}(?:选择|确认|输入)(?:.{0,8}(?:后|再)?继续)?|收到.{0,8}(?:用户|你|您|我)?的?确认.{0,8}(?:后)?再继续|\bwait for (?:the )?(?:user|your)\b|\bcontinue only after (?:the )?(?:user's?|your) confirmation\b/i.test(sanitized)) {
    item.waitAuthorization = { kind: 'root_explicit_wait', id: `wait:${id}:${sha256(sanitized).slice(0, 12)}` }
  } else if (/(?:请选择|请决定|需要用户决定)|\b(?:please choose|user decision required)\b/i.test(sanitized)) {
    item.waitAuthorization = { kind: 'user_decision_item', id: `decision:${id}:${sha256(sanitized).slice(0, 12)}` }
  }
  if (/(?:明确|允许|授权).{0,8}(?:延期|延后|移出范围)|(?:先)?延期(?:到|至).{1,24}(?:迭代|版本|里程碑|日期)|本(?:次|个)?迭代(?:暂时|暂)?不做|\b(?:explicitly )?(?:defer|remove from scope)\b|\bdefer\b.{0,24}\b(?:next iteration|milestone|release)\b|\bout of scope for (?:this|the current) iteration\b/i.test(sanitized)) {
    item.deferAuthorization = { kind: 'root_explicit_defer', id: `defer:${id}:${sha256(sanitized).slice(0, 12)}` }
  }
  if (/(?:持续推进|继续推进).{0,40}(?:直到|直至).{1,80}(?:为止|完成|结束)|(?:不要|不得|别)停.{0,40}(?:直到|直至)|\b(?:keep working|continue working|do not stop|don't stop)\b.{0,80}\b(?:until|unless)\b/i.test(sanitized)) {
    item.persistenceAuthorization = { kind: 'root_explicit_persistence', id: `persist:${id}:${sha256(sanitized).slice(0, 12)}` }
  }
  return item
}

/**
 * Capture one contract clause. Every captured item receives a concrete
 * verification contract: a named artifact path (artifact surface) or the
 * session scope (scope surface), so an unrelated file read can never close it.
 */
export function captureClause(
  text: string,
  sourceMessageId: string,
  id: string,
  revision: number,
  scope: CaptureScope = {},
): GuardItem {
  const { kind, body } = classifyClause(text)
  const path = extractArtifactPaths(sanitizeClauseText(body))[0] ?? ''
  const surface = path ? 'artifact' as const : 'scope' as const
  const subject = path || scope.cwd || 'scope'
  const method = extractMethod(body)
  const operation = extractOperation(body)
  return captureItem(kind, body, sourceMessageId, id, revision, subject, surface, method, operation)
}
