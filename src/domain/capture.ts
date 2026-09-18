import { normalizeClause, sanitizeClauseText, sha256 } from './canonicalize.js'
import { classifyTaskIntent } from './conversation.js'
import { COMMAND_SURFACE_MANIFEST } from './manifest.js'
import { isStatefulAction, semanticActionFromText, type SemanticAction } from './protocol-manifest.js'
import { canonicalRegistryBase } from './registry.js'
import { clarifiedSpanOf, interpretMessage, isRestatement, kindOfScope, maskQuotedSpans, restatedContentOf, semanticActionOfScope, statefulActionsOfScope, type InterpretOptions, type ScopeInterpretation } from './semantics.js'
import { spanClassOf, utf8ByteLength, utf8ByteOffset } from './spans.js'
import type { GuardItem, GuardItemKind, GuardOperation, TargetCaptureReasonCode, TargetSource, TargetTuple } from './types.js'
/**
 * Whether a clause opens with an explicit ban. The lane question ("is this a
 * constraint or a duty?") is answered by {@link ScopeInterpretation}; this stays
 * exported because the framing/segmentation callers ask it directly.
 */
export function classifyClause(text: string): GuardItemKind {
  const normalized = normalizeClause(text)
  const [first] = interpretMessage(normalized)
  return first ? kindOfScope(first.directive, first.body) : 'requirement'
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
  /** 0.6.3 K2: the provenance of this capture, when it produced a target. */
  source?: TargetSource
}
/**
 * A target token, as a human writes it.
 *
 * A path and a bare word do not start the same way: "/work/repo" and "./repo"
 * open with a separator, so a leading character class of letters, digits and
 * "@" cannot match them at all, and the field silently falls back to an
 * unrelated value. Paths therefore get their own branch, which requires the
 * separator plus at least one more character — a lone "/" is punctuation, not
 * a path.
 */
const TARGET_TAIL = '[\\p{L}\\p{N}@._/\\\\:+%?&=#\\[\\]~\\-]'
// Scan the whole unquoted lexeme before validating it. A prefix-only match
// would turn C:\\Users\\RUNNER~1 or an unsupported suffix into a different,
// seemingly authorized target. Spaces require an explicit quoted token.
const TARGET_TOKEN = '(?:`[^`]+`|"[^"]+"|\'[^\']+\'|[\\p{L}\\p{N}@./~\\\\][^\\s，,、；;。！？!]+|[\\p{L}\\p{N}@./~\\\\])'
const VALID_UNQUOTED_TARGET = new RegExp(`^${TARGET_TAIL}+$`, 'u')
function unquoteTargetToken(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim().replace(/[.,;，。；]+$/, '')
  const unquoted = /^(?:`([^`]+)`|"([^"]+)"|'([^']+)')$/.exec(trimmed)
  if (unquoted) return unquoted[1] ?? unquoted[2] ?? unquoted[3]
  return VALID_UNQUOTED_TARGET.test(trimmed) ? trimmed : undefined
}
/**
 * The value of a labelled field ("repository X", "版本：1.2.3").
 *
 * The label must END where it ends: a label that is only a prefix of a longer
 * word is skipped, so the literal word "repository" is never read as the label
 * "repo" followed by the value "sitory".
 */
function labeledTokenRead(text: string, labels: string): { raw: string; value?: string; end: number } | undefined {
  const label = new RegExp(`(?:${labels})`, 'iu')
  const after = new RegExp(`^(?:\\s*(?:[:=：]|为|是)\\s*|\\s+)(${TARGET_TOKEN})`, 'iu')
  // A value that is itself another label ("repository /x to remote origin")
  // belongs to that other field, not to this one.
  const OTHER_LABEL = /^(?:to|from|on|into|with|at|using|version|profile|registry|remote|refspec|branch|service|repository|repo|包|插件|制品|服务|仓库|版本|配置档|远端|分支|注册表)$/i
  let cursor = 0
  while (cursor <= text.length) {
    const match = label.exec(text.slice(cursor))
    if (!match) return undefined
    cursor = cursor + match.index + match[0].length
    const token = after.exec(text.slice(cursor))
    const value = unquoteTargetToken(token?.[1])
    if (token?.[1] && (!value || !OTHER_LABEL.test(value))) return { raw: token[1], ...(value ? { value } : {}), end: cursor + token[0].length }
    if (cursor >= text.length) return undefined
  }
  return undefined
}
function labeledToken(text: string, labels: string): string | undefined {
  return labeledTokenRead(text, labels)?.value
}
/**
 * Where a labelled field's VALUE sits in the text, so a value that another
 * field owns can be excluded from a later bare-object reading. The object
 * grammar and the field grammar overlap: "提交分支 release" names a BRANCH, and
 * without this range the bare-object reader would offer "release" as the
 * repository.
 */
/** Values that are another field's label or an action, never an identity candidate. */
const IDENTITY_STOP = /^(?:the|a|an|this|that|and|or|to|from|on|into|with|at|using|service|package|plugin|artifact|repository|repo|restart|reload|apply|install|包|插件|制品|服务|仓库|重启|重新启动|应用|安装|和|或|以及)$/iu

/**
 * EVERY value a label introduces in the span, normalized exactly as
 * {@link labeledToken} normalizes its own result, and including a coordinated
 * continuation list ("service api or worker" names two candidates).
 */
function labeledTokens(text: string, labels: string): string[] {
  const label = new RegExp(`(?:${labels})`, 'giu')
  const after = new RegExp(`^(?:\\s*(?:[:=：]|为|是)\\s*|\\s+)(${TARGET_TOKEN})`, 'iu')
  const continuation = new RegExp(`^\\s*(?:or|and|或|和|以及|、|,|/)\\s*(${TARGET_TOKEN})`, 'iu')
  const found: string[] = []
  for (const match of text.matchAll(label)) {
    let cursor = match.index + match[0].length
    let token = after.exec(text.slice(cursor))
    while (token) {
      const value = unquoteTargetToken(token[1])
      if (value && !IDENTITY_STOP.test(value)) found.push(value)
      cursor += token[0].length
      token = continuation.exec(text.slice(cursor))
    }
  }
  return [...new Set(found)]
}

/**
 * Every identity candidate a span names for a SERVICE, across the surface forms the
 * extractor accepts: the label-first form ("service api"), the verb-object form
 * ("restart api service") and the noun-suffix form ("api 服务"), each with its
 * coordinated continuations. The uniqueness check and the extractor therefore share
 * one grammar and one normalization.
 */
function serviceCandidates(text: string): string[] {
  const suffixed = [...text.matchAll(/([A-Za-z][A-Za-z0-9_-]*|\p{Script=Han}{1,6})\s*(?:服务|service)/giu)]
    .map((match) => unquoteTargetToken(match[1]))
    .filter((value): value is string => value !== undefined && !IDENTITY_STOP.test(value))
  // Ambiguity is judged WITHIN one surface form, so the union across forms never
  // invents a pair: the label-first form ("service api or worker"), the verb-object
  // form and the noun-suffix form ("api 服务或 worker 服务") are each enumerated with
  // the extractor's own grammar and normalization.
  for (const group of [
    labeledTokens(text, 'service(?:_id)?|服务'),
    actionObjectTokens(text, 'restart|reload|重启|重新启动', 'service|服务'),
    [...new Set(suffixed)],
  ]) {
    if (group.length > 1) return group
  }
  return []
}

/** Every identity candidate a span names for a PACKAGE, same grammar as the extractor. */
function packageCandidates(text: string): string[] {
  const normalize = (value: string): string => splitPackageSpec(value).packageId ?? value.trim()
  const groups = [
    [...new Set(labeledTokens(text, IDENTITY_LABELS.package).map(normalize))].filter((value) => value !== ''),
    [...new Set(actionObjectTokens(text, IDENTITY_LABELS.install, IDENTITY_LABELS.package).map(normalize))].filter((value) => value !== ''),
  ]
  for (const group of groups) {
    if (group.length > 1) return group
  }
  return []
}

function labeledTokenRange(text: string, labels: string): { value: string; start: number; end: number } | undefined {
  const label = new RegExp(`(?:${labels})`, 'iu')
  const after = new RegExp(`^(?:\\s*(?:[:=：]|为|是)\\s*|\\s+)(${TARGET_TOKEN})`, 'iu')
  const OTHER_LABEL = /^(?:to|from|on|into|with|at|using|version|profile|registry|remote|refspec|branch|service|repository|repo|包|插件|制品|服务|仓库|版本|配置档|远端|分支|注册表)$/i
  let cursor = 0
  while (cursor <= text.length) {
    const match = label.exec(text.slice(cursor))
    if (!match) return undefined
    cursor = cursor + match.index + match[0].length
    const token = after.exec(text.slice(cursor))
    const value = unquoteTargetToken(token?.[1])
    if (value && !OTHER_LABEL.test(value)) {
      const at = token ? cursor + token[0].indexOf(token[1]!) : cursor
      return { value, start: at, end: at + (token?.[1]?.length ?? value.length) }
    }
    if (cursor >= text.length) return undefined
  }
  return undefined
}
/**
 * The values a labelled field already claims. A bare-object reader must not
 * re-read one of them as the object of the action.
 */
function labeledFieldValues(text: string): Set<string> {
  const values = new Set<string>()
  for (const labels of ['branch|分支', 'remote|远端', 'refspec|引用规范']) {
    const found = labeledTokenRange(text, labels)
    if (found) values.add(found.value)
  }
  return values
}
/**
 * The object a verb acts on. The verb is matched first, then — separately — an
 * optional noun that has to end at a word boundary, and only the text AFTER
 * that noun is the target. Matching the noun and the token in one pattern let
 * the noun eat a prefix of the real word ("repository" consumed as "repo" +
 * "sitory"), which captured "sitory" as a repository name.
 */
/** Fields a git instruction names BESIDES its repository. */
const GIT_SECONDARY_LABEL = 'branch|分支|remote|远端|refspec|引用规范'
/**
 * The repository candidates a clause names, in order. A candidate is a path or a
 * Latin name that is spelled like a repository and is not a value another field
 * already claims (`分支 main`, `remote origin`, `refspec refs/heads/main`). The
 * current-repository deixis counts as a candidate too, so "当前仓库 与 /repo-c"
 * offers two.
 *
 * An extension is NOT evidence of identity: a repository can be called
 * `/repo-b.js`, and the root said 仓库. Filtering candidates by file extension
 * made the first-object reading and the ambiguity rule contradict each other —
 * `/repo-a` was accepted as a repository while `/repo-b.js` was silently dropped
 * (review 6 F3). A file argument in another clause is excluded by the join rule
 * instead: "提交仓库 /repo-a，运行 /tmp/script.sh" is not a coordinator list.
 */
const REPOSITORY_TOKEN_SCAN = /[/\\~][^\s，,、；;。！？!?]+|[A-Za-z][A-Za-z0-9._-]*/gu
const CURRENT_REPOSITORY_PHRASE = /当前(?:目录|文件夹|仓库|项目|工作区)|这个仓库|该仓库|本仓库|this\s+(?:repo|repository|project)|current\s+(?:repo|repository|directory|project|workspace)/iu
/**
 * What may sit BETWEEN two candidates of the same clause when the clause offers
 * them as alternatives: a coordinator, optionally followed by the field label
 * again ("/repo-b 和仓库 /repo-c"). Language form must not change the
 * authorization boundary, so the enumeration mark needs no surrounding space and
 * a repeated label is stepped over (review 5 F3).
 */
const REPOSITORY_ALTERNATIVE_JOIN = /^\s*(?:、|,|，|与|和|及|或|and|or)?\s*(?:repository|repo|仓库)?\s*$/iu
const REPOSITORY_ALTERNATIVE_COORDINATOR = /、|,|，|与|和|及|或|\b(?:and|or)\b/iu
/**
 * A coordinator GLUED inside one scanned token ("/repo-b和/repo-c"). Han
 * characters are legal path characters, so the scan cannot exclude them; the
 * token is split at a coordinator that is followed by a repository start instead.
 */
const GLUED_ALTERNATIVE = /(?:与|和|及|或)(?=[/\\~A-Za-z])/u
function isRepositoryCandidate(value: string, claimed: Set<string>): boolean {
  if (claimed.has(value)) return false
  return looksLikeRepositoryName(value)
}
function repositoryCandidates(text: string): Array<{ value: string; start: number; end: number }> {
  const claimed = labeledFieldValues(text)
  const candidates: Array<{ value: string; start: number; end: number }> = []
  for (const match of text.matchAll(REPOSITORY_TOKEN_SCAN)) {
    const value = match[0]
    const at = match.index
    const glued = GLUED_ALTERNATIVE.exec(value)
    if (glued) {
      const left = value.slice(0, glued.index)
      const right = value.slice(glued.index + glued[0].length)
      if (isRepositoryCandidate(left, claimed) && isRepositoryCandidate(right, claimed)) {
        candidates.push({ value: left, start: at, end: at + left.length })
        candidates.push({ value: right, start: at + glued.index + glued[0].length, end: at + value.length })
        continue
      }
    }
    if (!isRepositoryCandidate(value, claimed)) continue
    candidates.push({ value, start: at, end: at + value.length })
  }
  const current = CURRENT_REPOSITORY_PHRASE.exec(text)
  if (current) candidates.push({ value: '<current-repository>', start: current.index, end: current.index + current[0].length })
  return candidates.sort((left, right) => left.start - right.start)
}
/**
 * Whether the clause OFFERS several repositories rather than naming one. Two
 * distinct candidates that a coordinator joins are alternatives: reporting
 * either one would be a guess about which repository the root meant, so the
 * capture records a clarification instead. Repetitions of the same repository are
 * not alternatives, and a clause that names one repository, one branch or one
 * remote is unaffected.
 */
function namesSeveralRepositories(text: string): boolean {
  const candidates = repositoryCandidates(text)
  const distinct = new Set(candidates.map((candidate) => candidate.value.replace(/[\\/]+$/, '')))
  if (distinct.size < 2) return false
  for (let index = 1; index < candidates.length; index += 1) {
    const between = text.slice(candidates[index - 1]!.end, candidates[index]!.start)
    if (!REPOSITORY_ALTERNATIVE_JOIN.test(between)) continue
    if (!REPOSITORY_ALTERNATIVE_COORDINATOR.test(between)) continue
    return true
  }
  return false
}
function actionObjectToken(text: string, verbs: string, nouns: string, skipLabels?: string): string | undefined {
  return actionObjectTokens(text, verbs, nouns, skipLabels)[0]
}

/** Every object a verb of this kind introduces, in source order, normalized once. */
function actionObjectTokens(text: string, verbs: string, nouns: string, skipLabels?: string): string[] {
  const pattern = new RegExp(`(?:${verbs})`, 'giu')
  const found: string[] = []
  for (const match of text.matchAll(pattern)) {
    const token = objectTokenAfter(text, match.index + match[0].length, nouns, skipLabels)
    if (token) found.push(token)
  }
  return [...new Set(found)]
}

/** The object token that follows a verb, read exactly as the singular form does. */
function objectTokenReadAfter(text: string, from: number, nouns: string, skipLabels?: string): { raw: string; value?: string; end: number } | undefined {
  let cursor = from
  // 0.6.3 K2 repair (review counterexample): a clause may name a FIELD before
  // its object — "提交分支 release" names the BRANCH, not a repository called
  // release. A secondary label is stepped over exactly once, so the token
  // after it is read as that field's value rather than as the repository.
  if (skipLabels) {
    const secondary = new RegExp(`^\\s*(?:${skipLabels})(?![\\p{L}\\p{N}_])`, 'iu').exec(text.slice(cursor))
    if (secondary) cursor += secondary[0].length
  }
  const noun = new RegExp(`^\\s*(?:${nouns})(?![\\p{L}\\p{N}_])`, 'iu').exec(text.slice(cursor))
  if (noun) cursor += noun[0].length
  else cursor += (text.slice(cursor).match(/^\s*[\p{Script=Han}]{0,2}\s*/u)?.[0].length ?? 0)
  cursor += (text.slice(cursor).match(/^\s*(?:[:=：]|为)?\s*/u)?.[0].length ?? 0)
  const raw = new RegExp(`^(${TARGET_TOKEN})`, 'u').exec(text.slice(cursor))?.[1]
  if (!raw) return undefined
  const value = unquoteTargetToken(raw)
  if (value && IDENTITY_STOP.test(value)) return undefined
  return { raw, ...(value ? { value } : {}), end: cursor + raw.length }
}
function objectTokenAfter(text: string, from: number, nouns: string, skipLabels?: string): string | undefined {
  return objectTokenReadAfter(text, from, nouns, skipLabels)?.value
}
/** The verbs that name each repository-facing action, for unlabelled objects. */
const GIT_OBJECT_VERB: Record<string, string> = {
  push: 'push|推送',
  pull: 'pull|拉取',
  fetch: 'fetch|抓取|获取',
  commit: 'commit|提交',
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
/**
 * The artifact-type nouns the bounded file-choice vocabulary admits (C07).
 * A closed list pinned by the v2 fixture: the noun must be the OBJECT of the
 * action, so "更新文档" captures a bounded choice while "更新皮肤中心" stays
 * a genuine clarification. The generic "文件/file" admits any file type the
 * producer accepts.
 */
const BOUNDED_TYPE_NOUNS: ReadonlyArray<readonly [RegExp, string]> = [
  // CJK has no word boundaries, so the noun is matched literally; Latin nouns
  // keep word boundaries so "profile" never reads as a file.
  [/文档/, 'document'],
  [/(?<!\w)readme(?!\w)/iu, 'readme'],
  [/报告/, 'report'],
  [/文件/, 'file'],
  [/(?<!\w)files?(?!\w)/iu, 'file'],
]
function boundedArtifactTypeOf(text: string): string | undefined {
  const masked = text
  for (const [pattern, type] of BOUNDED_TYPE_NOUNS) {
    if (pattern.test(masked)) return type
  }
  return undefined
}
/** A bounded choice needs a real path scope; the 'scope' sentinel is not one. */
function scopeIsPath(subject: string): boolean {
  return subject !== 'scope' && subject !== '' && /[\\/]/.test(subject)
}
/**
 * Whether the clause's FIRST action word is the change verb 更新/调整 (the
 * object-driven modify mapping). A later 更新 inside a referenced task name
 * ("把更新插件明确为 apply…") never qualifies — the head verb is what the
 * clause orders.
 */
function headVerbIsChangeWord(text: string): boolean {
  const candidates: Array<{ at: number; word: string }> = []
  for (const word of ['更新', '调整']) {
    let at = text.indexOf(word)
    while (at >= 0) {
      candidates.push({ at, word })
      at = text.indexOf(word, at + word.length)
    }
  }
  for (const match of text.matchAll(/\b(?:update|adjust)\b/gi)) {
    candidates.push({ at: match.index!, word: match[0] })
  }
  if (candidates.length === 0) return false
  candidates.sort((a, b) => a.at - b.at)
  const head = candidates[0]!
  // Another action word before the head disqualifies it: the clause orders
  // that verb, not the change word.
  const earlier = CJK_ACTION_WORD_AT(text, head.at)
  return earlier === undefined
}
/** Any other known action word strictly before `before`, if one exists. */
function CJK_ACTION_WORD_AT(text: string, before: number): string | undefined {
  const words = ['创建', '生成', '新建', '写入', '修改', '编辑', '更改', '读取', '运行', '执行', '安装', '部署', '上传', '提交', '推送', '发布', '升级', '重启', '重新启动', '合并', '删除', '下载', '拉取', '同步']
  let best: { at: number; word: string } | undefined
  for (const word of words) {
    const at = text.indexOf(word)
    if (at >= 0 && at < before && (best === undefined || at < best.at)) best = { at, word }
  }
  for (const match of text.matchAll(/\b(?:build|create|write|modify|change|edit|run|fix|install|push|publish|commit|deploy|migrate|delete|restart|fetch|pull|update)\b/gi)) {
    if (match.index! < before && (best === undefined || match.index! < best.at)) best = { at: match.index!, word: match[0] }
  }
  return best?.word
}
/**
 * Whether the root named the repository explicitly rather than relying on the
 * session's environment. A path is explicit; a bare word is explicit only when
 * the action's own object grammar produced it ("push repo-a"), never when it is
 * the ambient working directory.
 */
function repositoryNamedExplicitly(
  text: string,
  action: 'pull' | 'fetch' | 'commit' | 'push',
  subject: string,
): { repository: string; kind: 'explicit_label' | 'explicit_path' | 'explicit_current_repository' } | undefined {
  // The labelled form is accepted only when its value is spelled like a
  // repository: the Chinese label 仓库 also introduces a locative phrase
  // ("仓库 /repo 里"), and its head noun is not a repository name.
  const labeled = labeledToken(text, IDENTITY_LABELS.repository)
  if (labeled && looksLikeRepositoryName(labeled)) return { repository: labeled, kind: 'explicit_label' }
  // "提交当前目录的改动" / "push the current repository": the root delegated the
  // choice to a trusted host fact, so the session directory may resolve it.
  // It is read BEFORE the bare-object form, which would otherwise capture the
  // head of the locative phrase as a repository name.
  if (/当前(?:目录|文件夹|仓库|项目|工作区)|这个仓库|该仓库|本仓库|this\s+(?:repo|repository|project)|current\s+(?:repo|repository|directory|project|workspace)/i.test(text)) {
    return subject !== 'scope' ? { repository: subject, kind: 'explicit_current_repository' } : undefined
  }
  // The bare-object form is the weakest reading: it is accepted only when the
  // token is spelled like a repository (a path, or a Latin name). A Chinese
  // noun phrase is a locative ("提交当前目录的改动"), never a repository name.
  const claimed = labeledFieldValues(text)
  const object = actionObjectToken(text, GIT_OBJECT_VERB[action], 'repository|repo|仓库', GIT_SECONDARY_LABEL)
  if (object && !claimed.has(object) && looksLikeRepositoryName(object)) {
    return { repository: object, kind: 'explicit_path' }
  }
  return undefined
}
/**
 * A branch label's value, or undefined when the "value" is prose. The Chinese
 * label 分支 also introduces a possessive phrase ("分支的改动"), whose head noun
 * is not a branch name.
 */
function branchName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return undefined
  return value
}
/**
 * A Latin identity label's value, or undefined when the "value" is prose. The
 * Chinese labels 分支/远端 also introduce possessive or locative phrases
 * ("分支的改动"), whose head noun is not a branch, remote or refspec name.
 */
function latinIdentityValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  // A refspec carries more punctuation than a branch name ("main:main",
  // "refs/heads/main:refs/remotes/origin/main"), so the guard rejects Han
  // characters and leading particles rather than enumerating syntax.
  if (/[\p{Script=Han}]/u.test(value)) return undefined
  if (!/^[A-Za-z0-9]/.test(value)) return undefined
  return value
}
/**
 * Whether a captured token names a repository rather than trailing prose. A
 * path is unambiguous; a bare word has to be Latin-script, so 改动/变更/代码 and
 * other Chinese noun phrases never become a repository identity.
 */
/** Fields a git instruction names besides its repository; never a repository. */
const GIT_TARGET_STOP_WORDS = /^(?:the|a|an|this|that|these|those|to|from|in|on|into|with|and|or|then|also|but|my|our|your|all|any|some|change|changes|changed|commit|commits|push|pushes|pull|fetch|update|updates|branch|remote|refspec|origin|upstream|main|master|develop|trunk|head|repository|repo|tags?|branch(?:es)?|远程|远端|分支|引用规范|仓库)$/i
function looksLikeRepositoryName(value: string): boolean {
  if (GIT_TARGET_STOP_WORDS.test(value)) return false
  if (/[\\/]/.test(value) || /^[.~]/.test(value) || /^[A-Za-z]:/.test(value)) return validRepositoryPath(value)
  if (!/^[\p{L}\p{N}@._-]+$/u.test(value)) return false
  return !/[\p{Script=Han}]/u.test(value)
}
function validRepositoryPath(value: string): boolean {
  // Validate the complete token. Unsupported syntax must not be reinterpreted
  // as a valid-looking prefix or an ambient repository selection.
  if (!/^[\p{L}\p{N}@._/\\:+%&=#\x5b\x5d~\- ]+$/u.test(value)) return false
  if (value === '/' || value === '\\') return false
  if (value.startsWith('\\\\') || value.startsWith('//')) return false
  if (/^[A-Za-z]:/.test(value)) {
    if (!/^[A-Za-z]:\\/.test(value) || value.includes('/') || value.slice(3).includes(':') || value.slice(3).includes('\\\\')) return false
  } else if (value.includes('\\') && value.includes('/')) return false
  const parts = value.split(/[\\/]/)
  return !parts.some((part) => part === '..')
}
function malformedExplicitRepository(text: string, action: 'pull' | 'fetch' | 'commit' | 'push'): boolean {
  const verb = new RegExp(`(?:${GIT_OBJECT_VERB[action]})`, 'iu').exec(text)
  const read = labeledTokenRead(text, IDENTITY_LABELS.repository)
    ?? (verb ? objectTokenReadAfter(text, verb.index + verb[0].length, 'repository|repo|仓库', GIT_SECONDARY_LABEL) : undefined)
  if (!read) return false
  if (!read.value || ((/[\\/]/.test(read.value) || /^[A-Za-z]:/.test(read.value))
    && !validRepositoryPath(read.value))) return true
  const rest = text.slice(read.end)
  // A quote or token may end only at a real lexical boundary. The scanner
  // must never accept a quoted/valid prefix of a longer unsupported target.
  if (rest && !/^[\s.,，,、；;。！？!?]/u.test(rest)) return true
  // An unquoted Windows path followed immediately by another path-bearing
  // whitespace token is one unsupported spaced argument, not a selection of
  // its first component. Quoted paths are already one complete token.
  if (/^[`"']/.test(read.raw) || !/^[A-Za-z]:\\/.test(read.value)) return false
  if (!/^\s+[^\s，,、；;。！？!?]+/u.test(rest)) return false
  // Only a complete, separately labeled Git field proves that the path ended
  // here. A bare "and More" or "on Hold" could still be an unquoted filename.
  return !/^\s+(?:(?:to|from)\s+)?(?:remote|branch|refspec|远端|分支|引用规范)\s+[^\s，,、；;。！？!?]+/iu.test(rest)
}
/** The target capture for one action, with the source of its identity. */
/**
 * Whether a span names more than one candidate for the action's identity field,
 * judged WITHIN one surface form with the extractor's own grammar and normalization —
 * so the enumeration cannot invent a pair by mixing forms, and cannot miss the
 * label-first list ("service api or worker") the extractor actually reads.
 */
function restatedSpanAmbiguous(action: SemanticAction, text: string): boolean {
  // EVERY identity field of the action's contract is enumerated and validated, not
  // just the object name: a unique package with two versions ("version 0.6.4 or
  // 0.6.5") or two profiles ("profile web or prod") has not proven a unique target.
  return identityFieldLabels(action).some((labels) => fieldCandidates(action, labels, text).length > 1)
}

/**
 * The label grammar of each identity field, per action. The enumerator reads a field
 * with the SAME labels the extractor uses and with the same normalization, so a
 * coordinated list after one label is seen as two candidates.
 */
function identityFieldLabels(action: SemanticAction): string[] {
  const { service, package: pkg, artifact, version, profile, registry, repository, branch, remote, refspec } = IDENTITY_LABELS
  switch (action) {
    case 'restart': return [service]
    case 'install': case 'apply': return [pkg, version, profile]
    case 'publish': return [artifact, version, registry]
    case 'commit': case 'push': case 'pull': case 'fetch':
      return [repository, branch, remote, refspec]
    default: return []
  }
}

/** The distinct candidates a span names for ONE identity field. */
/**
 * The label grammar of every identity field, shared by the EXTRACTOR and the
 * uniqueness enumeration — one definition, so the two can never drift. Latin labels
 * carry a word boundary: without it a path like `/repo-a` would be read as the `repo`
 * label and its next token as a second candidate.
 */
const IDENTITY_LABELS = {
  service: '(?<![\\p{Script=Latin}\\p{N}@/_.-])service(?:_id)?|服务',
  package: '(?<![\\p{Script=Latin}\\p{N}@/_.-])(?:package|plugin)|包|插件',
  artifact: '(?<![\\p{Script=Latin}\\p{N}@/_.-])(?:package|artifact)|包|制品',
  version: '(?<![\\p{Script=Latin}\\p{N}@/_.-])version|版本',
  profile: '(?<![\\p{Script=Latin}\\p{N}@/_.-])profile|配置(?:档|文件)?',
  registry: '(?<![\\p{Script=Latin}\\p{N}@/_.-])registry|注册表|仓库地址',
  repository: '(?<![\\p{Script=Latin}\\p{N}@/_.-])(?:repository|repo)|仓库',
  branch: '(?<![\\p{Script=Latin}\\p{N}@/_.-])branch|分支',
  remote: '(?<![\\p{Script=Latin}\\p{N}@/_.-])remote|远端',
  refspec: '(?<![\\p{Script=Latin}\\p{N}@/_.-])refspec|引用规范',
  install: '(?<![\\p{Script=Latin}\\p{N}@/_.-])(?:install|add|apply|安装|应用)',
  restart: '(?<![\\p{Script=Latin}\\p{N}@/_.-])(?:restart|reload|重启|重新启动)',
  publish: '(?<![\\p{Script=Latin}\\p{N}@/_.-])(?:publish|release|发布)',
} as const

/** Every version a package spec in the span names (`foo@1.0.0` -> `1.0.0`). */
function identitySpecVersions(text: string): string[] {
  const found: string[] = []
  const raw = [
    ...labeledTokens(text, IDENTITY_LABELS.package),
    ...labeledTokens(text, IDENTITY_LABELS.artifact),
    ...actionObjectTokens(text, IDENTITY_LABELS.install, IDENTITY_LABELS.package),
    ...actionObjectTokens(text, IDENTITY_LABELS.publish, IDENTITY_LABELS.artifact),
  ]
  for (const value of raw) {
    const version = splitPackageSpec(value).version
    if (version) found.push(version)
  }
  return found
}

/** The identity normalizer of one field: never a blanket lowercase. */
function fieldNormalizer(labels: string): (value: string) => string {
  if (labels === IDENTITY_LABELS.package || labels === IDENTITY_LABELS.artifact) {
    // The WHOLE spec is the candidate identity: `foo@1.0.0 or foo@2.0.0` names two
    // targets even though the package name is the same.
    return (value) => {
      const spec = splitPackageSpec(value)
      const id = spec.packageId ?? value.trim()
      return spec.version ? `${id}@${spec.version}` : id
    }
  }
  if (labels === IDENTITY_LABELS.registry) return (value) => canonicalRegistryBase(value) ?? value.trim()
  return (value) => value.trim()
}

function fieldCandidates(action: SemanticAction, labels: string, text: string): string[] {
  // Each field is normalized by ITS OWN identity rule: a package through the package
  // spec parser, a registry through its canonical form, and every git identity
  // (repository, branch, remote, refspec) case-SENSITIVELY — `main` and `Main` are two
  // branches, not one. The label may be case-insensitive; the value may not.
  const normalize = fieldNormalizer(labels)
  const groups: string[][] = [[...new Set(labeledTokens(text, labels).map(normalize))]]
  // A version written INSIDE a package spec is the SAME field as a labelled version,
  // so the two are one candidate set: "foo@1.0.0 version 2.0.0" names two versions and
  // is ambiguous, while a repeated identical version stays unique.
  if (labels === IDENTITY_LABELS.version) {
    const union = [...new Set([...groups[0]!, ...identitySpecVersions(text).map(normalize)])]
    if (union.length > 1) return union
    groups[0] = union
  }
  // The OBJECT of a service/package action also appears in the verb-object and the
  // noun-suffix forms, each judged on its own so mixing forms cannot invent a pair.
  if (labels === IDENTITY_LABELS.service) groups.push(serviceCandidates(text))
  if (labels === IDENTITY_LABELS.package) groups.push(packageCandidates(text))
  for (const group of groups) {
    const distinct = [...new Set(group.filter((value) => value !== ''))]
    if (distinct.length > 1) return distinct
  }
  return groups[0]!.filter((value) => value !== '')
}

function captureRequestedTarget(
  action: SemanticAction,
  text: string,
  subject: string,
  surface: 'artifact' | 'scope',
): CapturedRequestedTarget {
  if (action === 'create' || action === 'modify') {
    if (surface === 'artifact') return { target: { artifact_id: subject, scope: parentScope(subject) }, source: { kind: 'explicit_path' } }
    // 0.6.0 bounded file choice (C07/S03): an artifact-type noun inside the
    // session scope lets the assistant pick the exact file, which the
    // resolution producer freezes before any effect. Without a recognizable
    // noun the target stays a genuine clarification — never a guess.
    const artifactType = boundedArtifactTypeOf(text)
    if (artifactType && scopeIsPath(subject)) return { target: { scope: subject, artifact_type: artifactType }, source: { kind: 'explicit_path' } }
    return { target: {}, reasonCode: 'requested_target_artifact_id_missing' }
  }
  if (action === 'install' || action === 'apply') {
    const spec = actionObjectToken(
      text,
      IDENTITY_LABELS.install,
      IDENTITY_LABELS.package,
    )
    const parsed = splitPackageSpec(spec)
    if (!parsed.packageId) return { target: {}, reasonCode: 'requested_target_package_id_missing' }
    const profile = labeledToken(text, IDENTITY_LABELS.profile)
    const version = parsed.version ?? labeledToken(text, IDENTITY_LABELS.version)
    return { source: { kind: 'explicit_label' }, target: {
      package_id: parsed.packageId,
      ...(version ? { version } : {}),
      ...(profile ? { profile } : {}),
    } }
  }
  if (action === 'restart') {
    const service = labeledToken(text, IDENTITY_LABELS.service)
      ?? actionObjectToken(text, IDENTITY_LABELS.restart, IDENTITY_LABELS.service)
    return service
      ? { target: { service_id: service }, source: { kind: 'explicit_label' } }
      : { target: {}, reasonCode: 'requested_target_service_id_missing' }
  }
  if (action === 'publish') {
    const spec = actionObjectToken(text, IDENTITY_LABELS.publish, IDENTITY_LABELS.artifact)
    const parsed = splitPackageSpec(spec)
    if (!parsed.packageId) return { target: {}, reasonCode: 'requested_target_artifact_id_missing' }
    const version = parsed.version ?? labeledToken(text, IDENTITY_LABELS.version)
    const registry = canonicalRegistryBase(labeledToken(text, IDENTITY_LABELS.registry) ?? '')
    if (!registry) return { target: {}, reasonCode: 'requested_target_registry_missing_or_invalid' }
    return { source: { kind: 'explicit_label' }, target: {
      artifact_id: parsed.packageId,
      ...(version ? { version } : {}),
      registry,
    } }
  }
  if (action === 'pull' || action === 'fetch' || action === 'commit' || action === 'push') {
    // A path written in the instruction outranks the ambient default: "push
    // /work/repo" names its repository even without the word "repository", and
    // reading the session working directory instead would silently bind the
    // obligation to a different path than the one the human wrote. When the
    // root names no repository at all the target stays UNRESOLVED (0.6.3 K2):
    // the session working directory is environment context, not a user
    // selection, and promoting it would bind the obligation to whichever
    // directory the session happened to start in — the F062-02 green light for
    // committing in the wrong repository.
    // The other labelled fields are read FIRST: a clause may name them while
    // leaving the repository unset ("提交分支 release"), and the fields it did
    // name are the root's own selection, which inheritance must fill around
    // rather than discard (review P1).
    const branch = branchName(latinIdentityValue(labeledToken(text, IDENTITY_LABELS.branch)))
    const remote = latinIdentityValue(labeledToken(text, IDENTITY_LABELS.remote))
    // A refspec has its own syntax: either an explicit `src:dst` pair or a ref
    // path. A branch name is NOT a refspec, so "推送分支 release" does not
    // invent `refspec: release` — the branch is recorded as a branch.
    const explicitRefspec = latinIdentityValue(labeledToken(text, IDENTITY_LABELS.refspec))
    // An explicit refspec is accepted when it is spelled like one: a `src:dst`
    // pair or a ref path. A bare word is not a refspec, so "推送分支 release"
    // does not invent `refspec: release`.
    const refspec = explicitRefspec !== undefined && (/:/.test(explicitRefspec) || /^refs?\//i.test(explicitRefspec))
      ? explicitRefspec
      // A branch named inside a transfer order is that order's refspec: a push
      // pushes a branch, and the branch belongs to the repository the clause
      // names (or inherits), not to a separate repository identity.
      : action !== 'commit' && branch !== undefined ? branch : undefined
    if (malformedExplicitRepository(text, action)) {
      return { source: { kind: 'environment_default' }, reasonCode: 'requested_target_repository_invalid', target: {
        ...(action === 'commit' && branch ? { branch } : {}),
        ...(action !== 'commit' && remote ? { remote } : {}),
        ...(action !== 'commit' && refspec ? { refspec } : {}),
      } }
    }
    const named = repositoryNamedExplicitly(text, action, subject)
    // 0.6.3 K2: a clause that offers SEVERAL repositories is not a selection.
    // Picking the first would bind the obligation to a repository the root never
    // chose, so the capture records the ambiguity and the clause waits for a
    // decision. The other fields the clause named stay recorded.
    if (namesSeveralRepositories(text)) {
      return { source: { kind: 'environment_default' }, reasonCode: 'requested_target_repository_ambiguous', target: {
        ...(action === 'commit' && branch ? { branch } : {}),
        ...(action !== 'commit' && remote ? { remote } : {}),
        ...(action !== 'commit' && refspec ? { refspec } : {}),
      } }
    }
    if (!named) {
      // No repository: the environment default still selects the identity, and
      // whatever else the clause named stays recorded for inheritance to fill.
      return { source: { kind: 'environment_default' }, target: {
        ...(action === 'commit' && branch ? { branch } : {}),
        ...(action !== 'commit' && remote ? { remote } : {}),
        ...(action !== 'commit' && refspec ? { refspec } : {}),
      } }
    }
    return { source: { kind: named.kind }, target: {
      repository: named.repository,
      ...(action === 'commit' && branch ? { branch } : {}),
      ...(action !== 'commit' && remote ? { remote } : {}),
      ...(action !== 'commit' && refspec ? { refspec } : {}),
    } }
  }
  return { source: { kind: surface === 'artifact' ? 'explicit_path' : 'environment_default' }, target: surface === 'artifact'
    ? { artifact_id: subject, scope: parentScope(subject) }
    : { scope: subject } }
}
/**
 * The repository an obligation resolves to when the root wrote no repository
 * at all (0.6.3 K2). The environment default is preserved so a later
 * work-unit inheritance decision can evaluate it, but it is never reported as
 * a resolved user selection.
 */
export function environmentDefaultRepositoryTarget(action: SemanticAction, subject: string): TargetTuple | undefined {
  if (!(action === 'pull' || action === 'fetch' || action === 'commit' || action === 'push')) return undefined
  // The `scope` sentinel is not a path: without a session directory there is
  // no environment default to preserve and the capture stays empty.
  return scopeIsPath(subject) || subject.startsWith('/') || /^[A-Za-z]:[\\/]/.test(subject)
    ? { repository: subject }
    : undefined
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
 * boundaries and negations delimit segments so a compound instruction such as
 * "Modify src/a.ts and src/b.ts. Do not push." yields separate items instead of
 * collapsing into one artifact.
 *
 * Segmentation asks {@link interpretMessage} where the semantic scopes are, so a
 * negation keeps its whole coordinated span ("不推送、不发布" is two
 * prohibitions, not one requirement) and a mixed sentence keeps both executees.
 */
export interface ClauseSegment {
  kind: GuardItemKind
  /** Action-bearing text used for target, method and operation extraction. */
  body: string
  /** Verbatim source scope, kept for the audit record. */
  text: string
  paths: string[]
  /** The one interpretation this segment came from; never re-derived downstream. */
  interpretation: ScopeInterpretation
}
export function segmentClauses(text: string, options: InterpretOptions = {}): ClauseSegment[] {
  const normalized = normalizeClause(text)
  if (!normalized) return []
  return interpretMessage(normalized, options)
    .filter((interpretation) => interpretation.text.trim().length > 0)
    .map((interpretation) => ({
      kind: kindOfScope(interpretation.directive, interpretation.body),
      body: interpretation.body,
      text: interpretation.text,
      paths: extractArtifactPaths(interpretation.body),
      interpretation,
    }))
}
/**
 * Build a GuardItem from an already-classified clause body and a resolved
 * verification subject/surface.
 *
 * The optional `interpretation` carries the scope reading taken from the same
 * bytes. It is passed through rather than re-derived, so the obligation lane and
 * the authority of one clause cannot disagree between callers.
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
  interpretation?: ScopeInterpretation,
): GuardItem {
  const sanitized = sanitizeClauseText(body)
  const unsupportedVisual = /\bGUI\b|界面|视觉|截图|颜色|布局|视觉效果/i.test(sanitized)
  // A prohibition's body may be a bare verb ("不要提交并推送"), so the closed
  // action vocabulary resolves the action the ban is recorded against.
  // A restatement authorizes ONLY what it restates: its action, target and plan are
  // read from the restated span, so the action named before it ("把重启 api 服务明确为
  // 检查日志。") never becomes authority for the item. The recorded text and digest
  // stay the full clause.
  const actionText = isRestatement(sanitized) ? (restatedContentOf(sanitized) ?? sanitized) : sanitized
  let semanticAction = unsupportedVisual ? 'generic_run' : semanticActionOfScope(actionText, interpretation?.text ?? sanitized, kind === 'prohibition')
  // 0.6.0 D06-02/S03: the OBJECT decides the lane, never a blanket verb
  // whitelist. A directive whose head change verb is 更新/调整 and whose
  // object is a recognized artifact-type noun is a modify with a bounded file
  // choice (C07); anything else keeps its honest generic reading.
  if (semanticAction === 'generic_run' && !unsupportedVisual
    && interpretation?.directive === 'directive'
    && headVerbIsChangeWord(sanitized) && boundedArtifactTypeOf(sanitized) !== undefined) {
    semanticAction = 'modify'
  }
  // A restatement binds action, target and qualification TOGETHER. The restated span
  // decides first: a target it names wins, and only the fields it OMITS are inherited
  // from the clause it clarifies, and only when that older selection is unambiguous
  // ("把应用包 foo 版本 0.6.3 配置档 default 明确为 apply" inherits the package; "把重启
  // api 服务明确为重启 worker 服务。" binds service worker and denies service api).
  const restated = isRestatement(sanitized) ? (restatedContentOf(sanitized) ?? sanitized) : undefined
  // The clarified span is what the restatement REPLACES, so uniqueness and
  // inheritance read it — never the whole clause, which names both the old and the
  // new value and would look ambiguous by construction.
  const clarified = restated === undefined ? sanitized : (clarifiedSpanOf(sanitized) ?? sanitized)
  const capturedFull = captureRequestedTarget(semanticAction, clarified, subject, surface)
  // K2 proves a UNIQUE target for every capture, restatement or not: a clause that
  // names two candidates has not selected one, whatever the extractor read first.
  // A reason the extractor already reported (an ambiguous repository, a missing
  // field) is kept as it is: this audit only ADDS the fields the extractor read as a
  // single value.
  const clauseAmbiguous = capturedFull.reasonCode === undefined
    && restatedSpanAmbiguous(semanticAction, clarified)
  const capturedTarget = clauseAmbiguous
    ? { target: capturedFull.target, reasonCode: 'requested_target_field_ambiguous' as const }
    : restated === undefined
    ? capturedFull
    : (() => {
        const spanTarget = captureRequestedTarget(semanticAction, restated, subject, surface)
        const spanFields = Object.keys(spanTarget.target)
        // EACH span is validated for uniqueness on its own, and the merge is
        // PER FIELD: the restated span's own fields win, every field it OMITS is
        // inherited from the clarified obligation, and only while that older
        // selection is itself unique.
        const spanAmbiguous = restatedSpanAmbiguous(semanticAction, restated)
        const fullAmbiguous = restatedSpanAmbiguous(semanticAction, clarified)
        const oldUsable = !fullAmbiguous && capturedFull.reasonCode === undefined
        const inherited = oldUsable
          ? Object.fromEntries(Object.entries(capturedFull.target).filter(([field]) => !spanFields.includes(field)))
          : {}
        // An inherited field FILLS what the restated span left out, so the span's
        // own "missing" code is dropped; ambiguity on EITHER span is reported as
        // ambiguity, whatever the extractor happened to pick.
        const reasonCode = spanAmbiguous || (spanFields.length === 0 && fullAmbiguous)
          ? 'requested_target_field_ambiguous' as const
          : spanFields.length > 0
            ? spanTarget.reasonCode
            : Object.keys(inherited).length > 0 ? undefined : capturedFull.reasonCode
        return {
          target: { ...inherited, ...spanTarget.target },
          ...(reasonCode !== undefined ? { reasonCode } : {}),
          ...(spanTarget.source ?? (spanFields.length === 0 ? capturedFull.source : undefined)
            ? { source: spanTarget.source ?? capturedFull.source }
            : {}),
        }
      })()
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
      : { enforced: true, surface: unsupportedVisual ? 'ui' : surface, subject, method, operation: effectiveOperation },
    semanticAction,
    requestedTarget: capturedTarget.target,
    // 0.6.3 K2: only a target the ROOT named (or a trusted host selection) is
    // resolved for authorization. A git action with no named repository keeps
    // the environment default as its `requestedTarget` for the work-unit
    // inheritance decision, but its capture status stays unresolved until that
    // decision produces an auditable source.
    ...(capturedTarget.reasonCode
      ? { targetCaptureStatus: 'clarification_required' as const, targetCaptureReasonCode: capturedTarget.reasonCode }
      : capturedTarget.source?.kind === 'environment_default' && environmentDefaultRepositoryTarget(semanticAction, subject) !== undefined
        ? {
            // 0.6.3 K2: a git action whose clause named no repository keeps the
            // environment default as its identity placeholder so the work-unit
            // inheritance decision can evaluate it, but it is never a resolved
            // user selection. Other fields the clause DID name (分支 release)
            // stay recorded: inheritance fills around them rather than
            // discarding the root's own selection.
            requestedTarget: {
              ...environmentDefaultRepositoryTarget(semanticAction, subject),
              ...capturedTarget.target,
            },
            targetSource: capturedTarget.source,
            targetCaptureStatus: 'clarification_required' as const,
            targetCaptureReasonCode: 'requested_target_repository_missing' as const,
          }
        : { targetCaptureStatus: 'resolved' as const, ...(capturedTarget.source ? { targetSource: capturedTarget.source } : {}) }),
    taskKind: kind === 'prohibition' ? undefined : classifyTaskIntent(sanitized),
    authority: 'root_instruction',
    ...(kind === 'requirement' ? buildActionPlan(actionText, subject, surface, semanticAction, restated === undefined ? undefined : capturedFull) : {}),
    ...(interpretation ? {
      directive: interpretation.directive,
      executee: interpretation.executee,
      authorityDisposition: interpretation.authorityDisposition,
      executionQualification: interpretation.qualification,
      ...(interpretation.condition ? { condition: interpretation.condition } : {}),
      ...(interpretation.resumeEvent ? { resumeEvent: interpretation.resumeEvent } : {}),
      interpretationFingerprint: interpretation.fingerprint,
    } : {}),
  }
  // A wait qualification is derived from the same interpretation as the
  // authority: a clause the root has already released is executable now and
  // carries no outstanding wait, so it cannot be blocked by a stale one.
  // A quote is DATA: what it echoes is never the root's own wait, defer or
  // keep-working statement ("The user said \"收到我的确认\" earlier." did not reserve
  // anything). The heuristics below read the clause with its quoted spans blanked;
  // the recorded text and digest are untouched.
  const heuristics = maskQuotedSpans(sanitized)
  const waitBearing = interpretation
    ? interpretation.authorityDisposition !== 'executable_now'
      && (interpretation.resumeEvent !== undefined || interpretation.authorityDisposition === 'conditional_wait')
    : false
  if (waitBearing
    || /(?:等待|暂停|等).{0,12}(?:用户|你|您|我).{0,12}(?:选择|确认|输入)(?:.{0,8}(?:后|再)?继续)?|收到.{0,8}(?:用户|你|您|我)?的?确认.{0,8}(?:后)?再继续|\bwait for (?:the )?(?:user|your)\b|\bcontinue only after (?:the )?(?:user's?|your) confirmation\b/i.test(heuristics)) {
    item.waitAuthorization = { kind: 'root_explicit_wait', id: `wait:${id}:${sha256(sanitized).slice(0, 12)}` }
  } else if (/(?:请选择|请决定|需要用户决定)|\b(?:please choose|user decision required)\b/i.test(heuristics)) {
    item.waitAuthorization = { kind: 'user_decision_item', id: `decision:${id}:${sha256(sanitized).slice(0, 12)}` }
  }
  if (/(?:明确|允许|授权).{0,8}(?:延期|延后|移出范围)|(?:先)?延期(?:到|至).{1,24}(?:迭代|版本|里程碑|日期)|本(?:次|个)?迭代(?:暂时|暂)?不做|\b(?:explicitly )?(?:defer|remove from scope)\b|\bdefer\b.{0,24}\b(?:next iteration|milestone|release)\b|\bout of scope for (?:this|the current) iteration\b/i.test(heuristics)) {
    item.deferAuthorization = { kind: 'root_explicit_defer', id: `defer:${id}:${sha256(sanitized).slice(0, 12)}` }
  }
  if (/(?:持续推进|继续推进).{0,40}(?:直到|直至).{1,80}(?:为止|完成|结束)|(?:不要|不得|别)停.{0,40}(?:直到|直至)|\b(?:keep working|continue working|do not stop|don't stop)\b.{0,80}\b(?:until|unless)\b/i.test(heuristics)) {
    item.persistenceAuthorization = { kind: 'root_explicit_persistence', id: `persist:${id}:${sha256(sanitized).slice(0, 12)}` }
  }
  return item
}
/** The stateful actions a clause names, with the target captured for each. */
function buildActionPlan(
  body: string,
  subject: string,
  surface: 'artifact' | 'scope',
  primary: ReturnType<typeof semanticActionOfScope>,
  /** A restatement's older selection: fields the new span OMITS may inherit it. */
  inherit?: { target: TargetTuple; reasonCode?: TargetCaptureReasonCode; source?: TargetSource },
): Pick<GuardItem, 'actionPlan'> {
  const actions = statefulActionsOfScope(body)
  if (actions.length === 0 && isStatefulAction(primary)) actions.push(primary)
  if (actions.length <= 1) return {}
  return {
    actionPlan: actions.map((action) => {
      const captured = captureRequestedTarget(action, body, subject, surface)
      // The plan entry mirrors the item's own rule: an environment default is
      // never reported as a resolved user selection.
      const environmentDefault = captured.source?.kind === 'environment_default'
        ? environmentDefaultRepositoryTarget(action, subject)
        : undefined
      const planFields = Object.keys(captured.target)
      // The plan entry mirrors the item: its own fields win, the omitted ones are
      // inherited per field from the clarified obligation while that is unique.
      const inherited = inherit !== undefined && !inherit.reasonCode
        ? Object.fromEntries(Object.entries(inherit.target).filter(([field]) => !planFields.includes(field)))
        : {}
      const reasonCode = restatedSpanAmbiguous(action, body)
        ? 'requested_target_field_ambiguous' as const
        : captured.reasonCode
          ?? (planFields.length === 0 && Object.keys(inherited).length === 0 ? inherit?.reasonCode : undefined)
      if (environmentDefault !== undefined) {
        return {
          action,
          requestedTarget: { ...environmentDefault, ...inherited, ...captured.target },
          targetCaptureStatus: 'clarification_required' as const,
          targetCaptureReasonCode: 'requested_target_repository_missing' as const,
        }
      }
      return {
        action,
        requestedTarget: { ...inherited, ...captured.target },
        targetCaptureStatus: reasonCode ? 'clarification_required' as const : 'resolved' as const,
        ...(captured.reasonCode ? { targetCaptureReasonCode: captured.reasonCode } : {}),
      }
    }),
  }
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
  options: InterpretOptions = {},
): GuardItem {
  const [interpretation] = interpretMessage(text, options)
  const kind = interpretation ? kindOfScope(interpretation.directive, interpretation.body) : 'requirement'
  const body = interpretation?.body ?? text
  const path = extractArtifactPaths(sanitizeClauseText(body))[0] ?? ''
  const surface = path ? 'artifact' as const : 'scope' as const
  const subject = path || scope.cwd || 'scope'
  const method = interpretation?.method ?? extractMethod(body)
  const operation = extractOperation(body)
  const item = captureItem(kind, body, sourceMessageId, id, revision, subject, surface, method, operation, interpretation)
  // Stamp C01 provenance when the interpreted scope occurs verbatim in the
  // raw input, so standalone captures carry the same span audit trail.
  if (interpretation) {
    const at = text.indexOf(interpretation.text)
    if (at >= 0) {
      item.rawTextSha256 = sha256(text)
      item.spans = [{
        partIndex: 0,
        start: utf8ByteOffset(text, at),
        end: utf8ByteOffset(text, at) + utf8ByteLength(interpretation.text),
        class: spanClassOf(kind, interpretation.directive, 'root_instruction'),
      }]
    }
  }
  return item
}
