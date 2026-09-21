import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import intentRules from './intent.json' with { type: 'json' }
import observationSchema from './observation.schema.json' with { type: 'json' }
import { validateCoreSnapshot } from './schema.js'

type Row = Record<string, any>
const rules = intentRules.patterns
const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const bytes = (value: string): Uint8Array => Buffer.from(value, 'utf8')
const canonical = (value: unknown): string => {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') {
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff) { if (!(value.charCodeAt(++i) >= 0xdc00 && value.charCodeAt(i) <= 0xdfff)) throw new Error('noncanonical_value') }
      else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('noncanonical_value')
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort((a,b) => Buffer.compare(Buffer.from(a),Buffer.from(b))).map((key) => `${canonical(key)}:${canonical((value as Row)[key])}`).join(',')}}`
  throw new Error('noncanonical_value')
}
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)
const spanText = (span: Row, source: Row): string => Buffer.from(bytes(source.text as string)).subarray(span.start, span.end).toString('utf8')
const listed = (value: unknown): Row[] => value as Row[]
const index = (rows: Row[], watermark: number): Map<string, Row> => {
  const result = new Map<string, Row>()
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.id)) throw new Error('duplicate_identity')
    seen.add(row.id)
    if (row.seq <= watermark) result.set(row.id, row)
  }
  return result
}
const sourceMatches = (span: Row, sources: Map<string, Row>, root = false): boolean => {
  const source = sources.get(span.source_id)
  if (!source || (root && source.kind !== 'root') || span.sha256 !== source.sha256
    || span.start < 0 || span.start >= span.end || span.end > source.byte_length) return false
  if (source.text !== null) {
    const raw = bytes(source.text)
    const decoder = new TextDecoder('utf-8', { fatal: true })
    for (const point of [span.start, span.end]) { try { decoder.decode(raw.subarray(0, point)) } catch { return false } }
  }
  return true
}
const utf8Compare = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
const sortedUnique = (value: string[]): string[] => [...new Set(value)].sort(utf8Compare)

export function controlSpeech(text: string, kind: string): boolean {
  if (/^\s*(?:```|`|[“‘"]|>)/u.test(text)) return false
  let speech = text.trim().replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|‘[^’]*’|"[^"]*"/gu, '对象')
  speech = speech.replace(/^(?:(?:请(?:先)?|现在|先)\s*|(?:please|now|kindly)\s+)+/iu, '')
  if (kind === 'persistence' && subjectlessCompoundPersistence(speech)) return true
  if (/^(?:不要|不得|别|切勿|无需|不必|do\s+not\b|don't\b|never\b)/iu.test(speech)) return false
  if (kind === 'persistence') return new RegExp(rules.USER_PERSISTENCE_RE, 'is').exec(speech)?.index === 0
  if (kind === 'resume') return currentUnitScopeSpeech(speech, kind)
    || new RegExp(rules.EXECUTION_RESUME_RE, 'i').exec(speech)?.index === 0
  if (kind === 'pause') return /^(?:暂停|搁置|pause\b|hold\b)/iu.test(speech)
  if (kind === 'cancel') return /^(?:取消|撤销|不再进行|cancel\b|drop\b)/iu.test(speech)
  return false
}

function subjectlessCompoundPersistence(text: string): boolean {
  return /^\s*(?:(?:请|现在)\s*)?(?:不要|不得|别|切勿)\s*(?:停止|停下|暂停|结束)\s*[,，]\s*(?:持续|继续|一直)\s*(?:执行|推进|工作)\s*(?:直到|直至)\s*(?:完成|结束)\s*[。.!！]?\s*$/u.test(text)
}

function singleRootTaskScope(prefix: string, rows: Row[]): boolean {
  if (!rows.length) return false
  const direct = prefix.trim().replace(/[。.!！]+$/u, '')
  if (/[。！？;；\n]/u.test(direct)) return false
  if (rows.length === 1) return directWorkClause(direct)
  const parents = rows.filter((row) => row.parent_id === null)
  if (parents.length !== 1 || parents[0]!.action !== 'local_edit') return false
  const parent = parents[0]!
  if (!rows.every((row) => row === parent || (row.parent_id === parent.id
    && ['test_verify','state_readback'].includes(row.action) && row.target === parent.target))) return false
  const clauses = direct.split('并')
  return clauses.length === rows.length && clauses.length >= 2 && clauses.every(directWorkClause)
}

function directWorkClause(text: string): boolean {
  const clause = text.trim().replace(/[，,。.!！]+$/u, '')
  const unquoted = clause.replace(/`[^`]*`|“[^”]*”|‘[^’]*’|"[^"]*"/gu, '对象')
  if (/[,，:：;；]|并|然后|随后|\b(?:and|then)\b/iu.test(unquoted)) return false
  if (/^(?:如果|假如|假设|未来|以后|将来|当|若|if\b|when\b|later\b|future\b)/iu.test(clause)) return false
  if (/^(?:不要|不得|别|切勿|无需|不必|do\s+not\b|don't\b|never\b)/iu.test(clause)) return false
  return /^(?:(?:请|请先|先|现在)\s*)?(?:运行|测试|修复|修改|编辑|更新|实现|检查|评估|测量|提交|推送|执行)|^(?:please\s+)?(?:run|test|repair|fix|edit|update|implement|check|evaluate|measure|commit|push)\b/iu.test(clause)
}

function rootSentenceParts(raw: Uint8Array): { starts: number[]; delimiters: Array<[number, number, string]>; compoundCommas: Set<number> } {
  const characters = Array.from(Buffer.from(raw).toString('utf8'))
  const starts = [0], delimiters: Array<[number, number, string]> = []
  const compoundCommas = new Set<number>()
  let offset = 0, segmentStart = 0, quotedBy: string | undefined
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index]!, before = offset
    offset += bytes(character).length
    if (quotedBy) { if (character === quotedBy) quotedBy = undefined; continue }
    if (['“', '‘', '"', '`'].includes(character)) {
      quotedBy = ({ '“': '”', '‘': '’' } as Record<string, string>)[character] ?? character
      continue
    }
    if (character === '并') {
      const preceding = characters.slice(segmentStart, index).join('')
      const following = characters.slice(index + 1).join('')
      if (directWorkClause(preceding) && controlSpeech(following.split('。', 1)[0]!, 'persistence')) {
        starts.push(offset); delimiters.push([before, offset, character]); segmentStart = index + 1
        continue
      }
    }
    if ('。！？;；\n'.includes(character)
      || '.!?'.includes(character) && (index + 1 === characters.length || /\s/u.test(characters[index + 1]!))) {
      starts.push(offset); delimiters.push([before, offset, character]); segmentStart = index + 1
    } else if ('，,'.includes(character)) {
      const remainder = characters.slice(index + 1).join('').split(/[。！？;；\n]/u, 1)[0]!
      if (subjectlessCompoundPersistence(characters.slice(segmentStart, index).join('') + character + remainder)) compoundCommas.add(before)
      else if (subjectlessCompoundPersistence(remainder)) { starts.push(offset); segmentStart = index + 1 }
      delimiters.push([before, offset, character])
    }
  }
  return { starts, delimiters, compoundCommas }
}

function rootSentenceBounds(raw: Uint8Array, span: Row): [number, number] | undefined {
  const { starts, delimiters, compoundCommas } = rootSentenceParts(raw)
  const start = starts.filter((candidate) => candidate <= span.start).at(-1) ?? 0
  if (Buffer.from(raw.subarray(start, span.start)).toString('utf8').trim()) return undefined
  let clauseEnd = raw.length, delimiterEnd = raw.length
  for (const [begin, after, character] of delimiters) {
    if (begin < span.start) continue
    if (compoundCommas.has(begin)) continue
    if ('，,'.includes(character) && /^(?:直到|直至|until\b)/iu.test(Buffer.from(raw.subarray(after)).toString('utf8').trimStart())) continue
    clauseEnd = begin; delimiterEnd = after; break
  }
  let contentEnd = clauseEnd
  while (contentEnd > start && /\s/u.test(String.fromCharCode(raw[contentEnd - 1]!))) contentEnd--
  return span.end === contentEnd || span.end === delimiterEnd ? [start, delimiterEnd] : undefined
}

/** Candidate control spans from immutable root bytes, including a governed
 * coordinated predicate. A comma alone never grants a new speech act. */
export function rootControlCandidateSpans(text: string): Array<{ start: number; end: number }> {
  const raw = bytes(text), { starts, delimiters, compoundCommas } = rootSentenceParts(raw)
  const spans: Array<{ start: number; end: number }> = []
  for (const candidate of starts) {
    let start = candidate
    while (start < raw.length && /\s/u.test(String.fromCharCode(raw[start]!))) start++
    if (start >= raw.length) continue
    let end = raw.length
    for (const [begin, after, character] of delimiters) {
      if (begin < start) continue
      if (compoundCommas.has(begin)) continue
      if ('，,'.includes(character) && /^(?:直到|直至|until\b)/iu.test(Buffer.from(raw.subarray(after)).toString('utf8').trimStart())) continue
      end = '，,'.includes(character) ? begin : after; break
    }
    if (start < end && rootSentenceBounds(raw, { start, end })) spans.push({ start, end })
  }
  return spans
}

export function currentUnitScopeSpeech(text: string, kind: string): boolean {
  const lead = '(?:(?:(?:请|请先|先)\\s*|(?:please|now)\\s+))*'
  const end = '\\s*[。.!！]?\\s*'
  // Consume the same compositional unit referent for every control kind.
  // Root provenance and receipt-time catalog checks still bind its members.
  const enScoped = '(?:(?:(?:this|the)\\s+)?current|this)\\s+(?:task|work)'
  const scoped = `(?:(?:当前|本轮|这轮|全部|整个)(?:任务|工作|事项)|${enScoped})`
  if (['pause', 'resume', 'cancel'].includes(kind)) {
    const verb = kind === 'pause' ? '(?:暂停|搁置|pause|hold)'
      : kind === 'resume' ? '(?:继续|continue)' : '(?:取消|撤销|cancel|drop)'
    const noun = kind === 'cancel' ? scoped : `(?:${scoped})?`
    return new RegExp(`^\\s*${lead}${verb}\\s*${noun}${end}$`, 'iu').test(text)
  }
  if (kind !== 'persistence') return false
  if (subjectlessCompoundPersistence(text)) return true
  const zh = new RegExp(`^\\s*${lead}(?:持续|继续|一直)(?:执行|推进|工作|完成|处理)\\s*[,，]?\\s*(?:直到|直至)(?:(?:当前|本轮|这轮|全部|整个))?(?:任务|工作|事项)(?:完成|结束)${end}$`, 'iu')
  const terminal = '(?:(?:is\\s+)?(?:done|complete|finished))'
  const enHead = `${lead}(?:keep|continue)\\s+(?:going|working)`
  const en = new RegExp(`^\\s*${enHead}(?:\\s+on\\s+${enScoped})?\\s+until\\s+(?:${enScoped}|(?:whole|entire)\\s+(?:task|work))\\s+${terminal}${end}$`, 'iu')
  const anaphora = new RegExp(`^\\s*${enHead}\\s+on\\s+${enScoped}\\s+until\\s+it\\s+${terminal}${end}$`, 'iu')
  return zh.test(text) || en.test(text) || anaphora.test(text)
}

/** Source range of one directly governed test-class object. It is a proposal
 * for the core, which still checks immutable root and receipt-time refs. */
export function actionClassScopeSpeech(text: string, kind: string): { noun: string; start: number; end: number } | undefined {
  const noun = '(?:本轮|这轮|当前|全部|这项|该项)测试'
  const pattern = kind === 'persistence'
    ? `^(?<prefix>\\s*(?:(?:请|请先|先)\\s*)?(?:持续|继续|一直)(?:执行|推进|完成|处理|运行)\\s*(?:(?:本轮|这轮|当前|全部)测试\\s*)?[,，]?\\s*(?:直到|直至)\\s*)(?<noun>${noun})\\s*(?:完成|结束)(?:为止)?\\s*[。.!！]?\\s*$`
    : `^(?<prefix>\\s*(?:(?:请|请先|先)\\s*)?(?:暂停|搁置|取消|撤销|继续)\\s*)(?<noun>${noun})\\s*[。.!！]?\\s*$`
  const match = new RegExp(pattern, 'u').exec(text)
  if (!match?.groups?.prefix || !match.groups.noun) return undefined
  const start = match.groups.prefix.length
  return { noun: match.groups.noun, start, end: start + match.groups.noun.length }
}

const fullMatch = (pattern: string, text: string): boolean => new RegExp(`^(?:${pattern})$`, 'iu').test(text)
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const scopeOpen = (req: Row, seq: number): boolean => req.status !== 'superseded' || req.superseded_at_seq !== undefined
  ? req.seq <= seq && (req.superseded_at_seq === undefined || seq < req.superseded_at_seq) : false

function explicitTargetSpeech(prefix: string, suffix: string, kind: string): boolean {
  if (['pause', 'resume', 'cancel'].includes(kind)) {
    const verb = kind === 'pause' ? '(?:暂停|搁置|pause|hold)'
      : kind === 'resume' ? '(?:继续|continue)' : '(?:取消|撤销|cancel|drop)'
    return fullMatch(`\\s*(?:(?:(?:请|请先|先)\\s*|please\\s+))*${verb}\\s*(?:文件|目录|测试|仓库)?\\s*[\`“"]?\\s*`, prefix)
      && fullMatch('\\s*[\`”"]?\\s*[。.!！]?\\s*', suffix)
  }
  return kind === 'persistence' && fullMatch('\\s*(?:(?:(?:请|请先)\\s*|please\\s+))*(?:持续|继续|一直)(?:执行|推进|完成|处理)\\s*[\`“"]?\\s*', prefix)
    && fullMatch('\\s*[\`”"]?\\s*(?:的测试)?\\s*(?:直到|直至)(?:当前|本轮|这轮)?(?:任务|工作|测试)?(?:完成|结束)\\s*[。.!！]?\\s*', suffix)
}

function foldRootControls(snapshot: Row, sources: Map<string, Row>, requirements: Map<string, Row>,
  facts: Map<string, Row>, units: Set<string>, watermark: number):
  { states: Map<string, string>; errors: string[]; represented: Set<string>; resumed: Set<string> } {
  const states = new Map<string, string>(), errors: string[] = [], represented = new Set<string>(), resumed = new Set<string>()
  const controls = listed(snapshot.root_controls ?? [])
  if (new Set(controls.map((control) => control.id)).size !== controls.length) throw new Error('duplicate_root_control')
  const ordered = [...controls].sort((a, b) => a.seq - b.seq || a.source.start - b.source.start || utf8Compare(a.id, b.id))
  const positions = new Set<string>()
  for (const control of ordered) {
    if (control.seq > watermark) continue
    const span = control.source, source = sources.get(span.source_id)
    if (source && !units.has(source.unit)) continue
    const controlUnit = source?.unit
    const position = `${control.seq}\u0000${span.source_id}\u0000${span.start}`
    let valid = Boolean(source && source.kind === 'root' && units.has(source.unit)
      && source.seq === control.seq && sourceMatches(span, sources, true)
      && !positions.has(position)
      && [...sources.values()].filter((row) => row.seq === control.seq).length === 1)
    positions.add(position)
    if (!valid || !source) { errors.push(control.id); continue }
    const text = spanText(span, source)
    const sentence = rootSentenceBounds(bytes(source.text), span)
    if (!sentence || !controlSpeech(text, control.kind)) { errors.push(control.id); continue }
    const basis = control.scope_basis, target = basis.target, targetSpan = basis.target_source
    if (basis.kind === 'current_unit') {
      valid = target === null && targetSpan === null && currentUnitScopeSpeech(text, control.kind)
    } else {
      valid = Boolean(typeof target === 'string' && target && targetSpan
        && targetSpan.source_id === span.source_id && sourceMatches(targetSpan, sources, true)
        && span.start <= targetSpan.start && targetSpan.end <= span.end
        && sentence[0] <= targetSpan.start && targetSpan.start < targetSpan.end && targetSpan.end <= sentence[1]
        && (basis.kind !== 'exact' && basis.kind !== 'directory' || spanText(targetSpan, source) === target))
      if (valid && ['exact', 'directory'].includes(basis.kind)) {
        const raw = bytes(source.text)
        valid = explicitTargetSpeech(Buffer.from(raw.subarray(span.start, targetSpan.start)).toString('utf8'),
          Buffer.from(raw.subarray(targetSpan.end, span.end)).toString('utf8'), control.kind)
      }
    }
    if (!valid) { errors.push(control.id); continue }
    const eligible = new Map([...requirements].filter(([key, req]) => req.unit === controlUnit && scopeOpen(req, control.seq)
      && req.kind === 'execution' && states.get(key) !== 'cancelled' && sourceMatches(req.source, sources, true)))
    if ([...requirements.values()].some((req) => req.unit === controlUnit && req.kind === 'execution'
      && req.superseded_at_seq === control.seq)) { errors.push(control.id); continue }
    if (basis.kind === 'current_unit' && subjectlessCompoundPersistence(text)) {
      const prefix = Buffer.from(source.text, 'utf8').subarray(0, span.start).toString('utf8')
      if (![...eligible.values()].every((req) => req.source.source_id === source.id && req.seq === control.seq)
        || !singleRootTaskScope(prefix, [...eligible.values()])) { errors.push(control.id); continue }
    }
    let selected: Map<string, Row>
    if (basis.kind === 'current_unit') selected = eligible
    else if (basis.kind === 'exact') selected = new Map([...eligible].filter(([, req]) => req.target === target))
    else if (basis.kind === 'directory') selected = new Map([...eligible].filter(([, req]) => req.target.startsWith(`${String(target).replace(/\/$/u, '')}/`)))
    else if (basis.kind === 'action_class') {
      const noun = spanText(targetSpan, source)
      const parsed = actionClassScopeSpeech(text, control.kind)
      valid = target === 'test_verify' && parsed?.noun === noun
        && span.start + bytes(text.slice(0, parsed.start)).length === targetSpan.start
      selected = valid ? new Map([...eligible].filter(([, req]) => req.action === target)) : new Map()
      if ((noun.startsWith('这项') || noun.startsWith('该项')) && selected.size !== 1) valid = false
    } else if (basis.kind === 'parent_task') {
      const noun = spanText(targetSpan, source)
      let parents = new Map([...eligible].filter(([key, req]) => req.action === 'local_edit'
        && [...eligible.values()].some((child) => child.parent_id === key)))
      let grammar: boolean
      if (noun === '这项修复' || noun === '该项修复') {
        grammar = fullMatch(`\\s*(?:(?:请|请先|先)\\s*)?(?:暂停|搁置|取消|撤销|继续)\\s*${escapeRegex(noun)}\\s*[。.!！]?\\s*`, text)
      } else {
        grammar = control.kind === 'persistence'
          && fullMatch('(?:本轮|这轮|当前).{1,48}(?:修复|修改).{0,24}(?:测试|验证)', noun)
          && fullMatch(`\\s*(?:(?:请|请先)\\s*)?(?:持续|继续|一直)(?:完成|推进|执行|处理)\\s*${escapeRegex(noun)}\\s*[,，]?\\s*(?:直到|直至)(?:当前|本轮|这轮)(?:任务|工作|事项)(?:完成|结束)\\s*[。.!！]?\\s*`, text)
        parents = new Map([...parents].filter(([, req]) => req.source.source_id === span.source_id))
      }
      valid = grammar && parents.size === 1 && parents.has(target)
      selected = valid ? new Map([[target, parents.get(target)!]]) : new Map()
      if (valid) {
        let changed = true
        while (changed) {
          changed = false
          for (const [key, req] of eligible) if (req.required && selected.has(req.parent_id) && !selected.has(key)) {
            selected.set(key, req); changed = true
          }
        }
      }
    } else { valid = false; selected = new Map() }
    if (!valid) { errors.push(control.id); continue }
    const refs = listed(control.controlled_requirements)
    if (!refs.length || new Set(refs.map((ref) => ref.requirement_id)).size !== refs.length
      || !same(sortedUnique(refs.map((ref) => ref.requirement_id)), sortedUnique([...selected.keys()]))) {
      errors.push(control.id); continue
    }
    for (const ref of refs) {
      const req = selected.get(ref.requirement_id)!
      const selectedAtReceipt = new Set<string>()
      if (req.target_origin.constraint_kind === 'work_unit') for (const fact of facts.values()) {
        if (fact.kind !== 'readiness' || fact.outcome !== 'success' || fact.requirement_id !== req.id || fact.seq > control.seq) continue
        const call = sources.get(fact.call_source_id), result = sources.get(fact.source_id)
        if (call?.kind === 'host_call' && result?.kind === 'host_result'
          && call.seq < result.seq && result.seq <= control.seq
          && call.target === fact.target && call.target_kind === req.target_origin.subject_kind) selectedAtReceipt.add(fact.target)
      }
      if (ref.unit !== req.unit || ref.revision !== req.revision || ref.source_id !== req.source.source_id
        || ref.seq !== req.seq
        || ref.target === null && (['exact', 'directory'].includes(basis.kind)
          || req.target_origin.constraint_kind !== 'work_unit' || selectedAtReceipt.size > 0)
        || ref.target !== null && ref.target !== req.target
        || req.target_origin.constraint_kind === 'work_unit' && (selectedAtReceipt.size > 1
          || (selectedAtReceipt.size > 0) !== (ref.target !== null)
          || selectedAtReceipt.size > 0 && !selectedAtReceipt.has(ref.target))
        || ref.scope_sha256 !== req.scope_sha256
        || req.seq === control.seq && req.source.source_id !== span.source_id) { valid = false; break }
    }
    if (!valid) { errors.push(control.id); continue }
    represented.add(span.source_id)
    for (const key of selected.keys()) {
      const prior = states.get(key) ?? 'ordinary'
      if (control.kind === 'cancel') states.set(key, 'cancelled')
      else if (control.kind === 'pause') states.set(key, ['persistent', 'persistent_paused'].includes(prior) ? 'persistent_paused' : 'paused')
      else if (control.kind === 'resume' && ['paused', 'persistent_paused'].includes(prior)) {
        states.set(key, prior === 'persistent_paused' ? 'persistent' : 'ordinary')
        resumed.add(key)
      } else if (control.kind === 'persistence' && prior !== 'cancelled') states.set(key, 'persistent')
    }
  }
  return { states, errors, represented, resumed }
}

/** Pure, host-neutral core/v2 projection. The adapter owns event trust and durability. */
export function projectCoreV2(snapshot: Row): Row {
  validateCoreSnapshot(snapshot, observationSchema as Row)
  canonical(snapshot)
  if (snapshot.schema !== 'core-observation/v2') throw new Error('unsupported_core_schema')
  const watermark = snapshot.as_of as number
  const unit = snapshot.unit as string
  const revision = snapshot.revision as number
  const sources = index(listed(snapshot.sources), watermark)
  for (const source of sources.values()) {
    if (source.target !== null && source.target !== undefined && source.kind !== 'host_call') throw new Error('selection_target_requires_host_call')
    if (source.origin_root_source_id !== null && source.origin_root_source_id !== undefined) {
      const origin = sources.get(source.origin_root_source_id)
      if (source.kind !== 'host_call' || !origin || origin.kind !== 'root' || origin.unit !== source.unit
        || origin.seq > source.seq || origin.turn !== source.turn) throw new Error('host_call_origin_root_mismatch')
    }
    if ((source.target === null || source.target === undefined) !== (source.target_kind === null || source.target_kind === undefined)) throw new Error('selection_target_kind_pair_required')
    if ((source.locator_base !== undefined || source.locator_flavor !== undefined) && source.kind !== 'root') throw new Error('locator_base_requires_root')
    if ((source.locator_base === undefined) !== (source.locator_flavor === undefined)) throw new Error('locator_base_flavor_pair_required')
    if (source.kind === 'root' && (source.text === null || bytes(source.text).length !== source.byte_length || hash(bytes(source.text)) !== source.sha256)) throw new Error('root_source_identity_mismatch')
  }
  const unitRows = new Map(listed(snapshot.units).map((row) => [row.id as string, row]))
  if (unitRows.size !== listed(snapshot.units).length || !unitRows.has(unit)) throw new Error('unit_identity_invalid')
  for (const row of unitRows.values()) {
    const source = sources.get(row.source_id)
    if (!source || source.kind !== 'root' || source.unit !== row.id) throw new Error('unit_source_invalid')
    const visited = new Set([row.id]); let parent = row.parent_id
    while (parent !== null) {
      if (visited.has(parent) || !unitRows.has(parent)) throw new Error('unit_parent_invalid')
      visited.add(parent); parent = unitRows.get(parent)!.parent_id
    }
  }
  const units = new Set([unit]); let growing = true
  while (growing) {
    growing = false
    for (const row of unitRows.values()) if (row.required && units.has(row.parent_id) && !units.has(row.id)) { units.add(row.id); growing = true }
  }
  const requirements = index(listed(snapshot.requirements), watermark)
  const activeRootIds = new Set([
    ...[...sources].filter(([, source]) => source.kind === 'root' && units.has(source.unit)
      && source.revision === revision).map(([key]) => key),
    ...[...requirements.values()].filter((req) => units.has(req.unit)).map((req) => req.source.source_id as string),
    ...listed(snapshot.root_controls ?? []).filter((control) => control.seq <= watermark
      && units.has(sources.get(control.source.source_id)?.unit)).map((control) => control.source.source_id as string),
  ])
  const coverageErrors: string[] = [], unknownCoverage: string[] = []
  for (const [key, source] of sources) {
    if (source.kind !== 'root' || !activeRootIds.has(key)) continue
    const spans = listed(snapshot.coverage).filter((c) => c.source.source_id === key).sort((a,b) => a.source.start-b.source.start)
    let cursor = 0
    for (const coverage of spans) {
      const span = coverage.source
      if (!sourceMatches(span, sources, true) || span.start !== cursor) coverageErrors.push(key)
      cursor = span.end
      if (coverage.kind === 'unknown') unknownCoverage.push(key)
    }
    if (cursor !== source.byte_length) coverageErrors.push(key)
  }
  const facts = index(listed(snapshot.facts), watermark)
  for (const req of requirements.values()) {
    const keys = ['superseded_at_seq', 'supersession_source_id', 'superseded_by_requirement_id']
    const present = keys.map((key) => key in req)
    if (present.some(Boolean) && !present.every(Boolean)) throw new Error('supersession_identity_incomplete')
    if (!present.every(Boolean)) continue
    const end = req.superseded_at_seq
    if (end <= req.seq || req.status !== 'superseded') throw new Error('supersession_interval_invalid')
    if (end > watermark) continue
    const source = sources.get(req.supersession_source_id), successor = requirements.get(req.superseded_by_requirement_id)
    if (!source || source.kind !== 'root' || source.unit !== req.unit || source.seq !== end
      || !successor || successor.unit !== req.unit || successor.seq !== end
      || successor.source.source_id !== source.id || successor.revision <= req.revision) throw new Error('supersession_source_mismatch')
  }
  const current = new Map([...requirements].filter(([, row]) => units.has(row.unit) && scopeOpen(row, watermark)))
  if ([...current.values()].some((r) => r.parent_id !== null && !requirements.has(r.parent_id))) throw new Error('requirement_parent_missing')
  const validFacts = new Map<string, Row>()
  for (const [key, fact] of facts) {
    const source = sources.get(fact.source_id)
    if (!source || source.seq > fact.seq || source.unit !== fact.unit || source.revision !== fact.revision) continue
    if (['action_event','state_outcome','readiness'].includes(fact.kind)) {
      const call = sources.get(fact.call_source_id)
      if (!call || call.kind !== 'host_call' || source.kind !== 'host_result' || !call.call_id || call.call_id !== source.call_id
        || call.target !== fact.target || !call.target_kind || call.seq >= source.seq || call.unit !== fact.unit || call.revision !== fact.revision) continue
      const originId = call.origin_root_source_id
      const factRequirement = current.get(fact.requirement_id)
      if (originId && factRequirement && factRequirement.kind !== 'constraint'
        && sources.get(originId)!.seq < sources.get(factRequirement.source.source_id)!.seq) continue
    } else if (source.kind !== ({delivery:'final_delivery',external_operation:'external_lifecycle'} as Record<string,string>)[fact.kind]) continue
    validFacts.set(key, fact)
  }
  const historicalEffectFacts = new Map(validFacts)
  const invalidated = new Set<string>()
  for (const fact of validFacts.values()) for (const id of fact.invalidates as string[]) if (validFacts.has(id) && validFacts.get(id)!.seq < fact.seq) invalidated.add(id)
  for (const id of invalidated) validFacts.delete(id)
  const conditions = new Map(listed(snapshot.conditions).map((row) => [row.id as string, row]))
  if (conditions.size !== listed(snapshot.conditions).length) throw new Error('duplicate_condition')
  const released = new Set<string>()
  for (const [key, condition] of conditions) {
    const req = current.get(condition.requirement_id)
    if (!req || !sourceMatches(condition.source, sources, true) || condition.source.source_id !== req.source.source_id) continue
    if (condition.status === 'released' && (condition.fact_ids as string[]).some((id) => { const f=validFacts.get(id); return f && f.condition_id === key && f.requirement_id === req.id && f.outcome === 'success' })) released.add(key)
  }
  const historicalExplained = new Map([...requirements].filter(([, req]) => units.has(req.unit)
    && req.status === 'superseded' && req.superseded_at_seq !== undefined
    && req.superseded_at_seq <= watermark && sourceMatches(req.source, sources, true)))
  const structuralGap = (raw: Uint8Array, start: number, end: number): boolean =>
    Buffer.from(raw.subarray(start, end)).toString('utf8').replace(/^[ \t\r\n,，。.!?？；;：:、]+|[ \t\r\n,，。.!?？；;：:、]+$/gu, '').length > 0
  for (const coverage of listed(snapshot.coverage)) {
    const span = coverage.source, source = sources.get(span.source_id)
    if (!source || !units.has(source.unit) || coverage.kind !== 'interpreted') continue
    const covered: Array<[number, number]> = [
      ...[...current.values(), ...historicalExplained.values()].filter((r) => r.source.source_id === span.source_id
        && r.source.start < span.end && r.source.end > span.start).map((r): [number, number] => [r.source.start, r.source.end]),
      ...listed(snapshot.root_controls ?? []).filter((control) => control.seq <= watermark
        && control.source.source_id === span.source_id && sourceMatches(control.source, sources, true))
        .map((control): [number, number] => [control.source.start, control.source.end]),
    ].sort((a,b)=>a[0]-b[0] || a[1]-b[1])
    let cursor=span.start
    const raw = bytes(source.text)
    for (const [start,end] of covered) { if (start>cursor && structuralGap(raw, cursor, start)) break; cursor=Math.max(cursor,end) }
    if (cursor<span.end && structuralGap(raw, cursor, span.end)) coverageErrors.push(span.source_id)
  }
  const predicates: Record<string,string> = {}, delivery: string[] = []
  for (const [key, req] of current) {
    const source = sources.get(req.source.source_id)
    const sourceValid = sourceMatches(req.source,sources,true) && source?.unit===req.unit && source?.revision===req.revision
    const origin=req.target_origin, constraint=origin.root_constraint, targetSpan=origin.root_constraint_source, targetSource=sources.get(targetSpan.source_id)
    let rootTargetValid=sourceMatches(targetSpan,sources,true) && targetSource?.unit===req.unit && targetSource?.revision===req.revision && targetSource!==undefined && spanText(targetSpan,targetSource)===constraint
    const constraintKind=origin.constraint_kind, resolvedConstraint=origin.resolved_constraint, relativeConstraint=resolvedConstraint!==undefined
    const base=targetSource?.locator_base, flavor=targetSource?.locator_flavor
    const relativeLiteral=constraintKind==='directory' && constraint.endsWith('/') ? constraint.slice(0,-1) : constraint
    const subjectKind=origin.subject_kind, filesystemSubject=subjectKind==='filesystem'
    const inherentlyFilesystem=['local_edit','local_commit','remote_push'].includes(req.action)
      || [...validFacts.values()].some((fact)=>fact.requirement_id===key && fact.kind==='readiness' && fact.predicate==='file_exists')
    if (inherentlyFilesystem && !filesystemSubject) rootTargetValid=false
    const targetIsAbsolute=(req.target.startsWith('/') && !req.target.startsWith('//') && posix.normalize(req.target)===req.target)
      || /^[A-Za-z]:[\\/][^:]+$/.test(req.target)
    if (relativeConstraint && !filesystemSubject) rootTargetValid=false
    if (relativeConstraint) {
      const validRelative=flavor==='posix' && typeof base==='string' && base.startsWith('/') && posix.normalize(base)===base
        && !base.startsWith('//') && !constraint.startsWith('/') && !constraint.startsWith('\\')
        && !relativeLiteral.includes(':') && !relativeLiteral.includes('\\') && !/^[~$%]/.test(relativeLiteral)
        && !constraint.endsWith('//') && relativeLiteral.split('/').every((part:string)=>part!=='' && part!=='.' && part!=='..')
        && posix.join(base,relativeLiteral)===resolvedConstraint && ['exact','directory'].includes(constraintKind)
      if (!validRelative) rootTargetValid=false
    } else if (['exact','directory'].includes(constraintKind) && filesystemSubject
      && !(constraint.startsWith('/') || (constraint.length>=3 && [':\\',':/'].includes(constraint.slice(1,3))))) rootTargetValid=false
    const selectionSourceId=origin.selection_source_id
    const selection=selectionSourceId ? sources.get(selectionSourceId) : undefined
    const selectedByHost=Boolean(selection && selection.kind==='host_call' && selection.target===req.target && selection.target_kind===subjectKind
      && selection.unit===req.unit && selection.revision===req.revision && source && source.seq<=selection.seq && selection.seq<=watermark
      && [...validFacts.values()].some((fact)=>fact.call_source_id===selectionSourceId && fact.target===req.target && fact.requirement_id===req.id))
    const rootTargetAllowed=constraintKind==='exact' ? (relativeConstraint ? resolvedConstraint===req.target && (selectedByHost || req.kind==='constraint') : constraint===req.target)
      : constraintKind==='directory' ? Boolean((relativeConstraint ? resolvedConstraint : constraint.replace(/\/$/,'') )
        && req.target.startsWith(`${relativeConstraint ? resolvedConstraint : constraint.replace(/\/$/,'')}/`)
        && !req.target.split('/').includes('..') && (relativeConstraint ? selectedByHost || req.kind==='constraint' : constraint.endsWith('/')))
      : selectedByHost
    const typedHostConflict=[...validFacts.values()].some((fact)=>fact.requirement_id===key && fact.target===req.target
      && ['readiness','action_event','state_outcome'].includes(fact.kind)
      && sources.get(fact.call_source_id)?.target_kind!==subjectKind)
    const targetValid=rootTargetValid && origin.resolved===req.target
      && (req.kind==='constraint' ? origin.observed===null : origin.observed===req.target) && rootTargetAllowed
      && !typedHostConflict && (!filesystemSubject || targetIsAbsolute)
      && (!filesystemSubject || !(['exact','directory'].includes(constraintKind) && !relativeConstraint && !targetIsAbsolute))
      && (constraintKind!=='work_unit' || selectedByHost)
      && (req.kind==='constraint' ? origin.implementation_choice===null && origin.host_selection===null
        : origin.implementation_choice===req.target && origin.host_selection===req.target)
    if (req.status==='legacy_review' || !sourceValid || !targetValid) { predicates[key]='legacy_review'; continue }
    if (req.kind==='constraint') {
      const mutationFacts=req.predicate==='no_mutation' ? [...historicalEffectFacts.values()].filter((fact)=>fact.requirement_id===key
        && fact.unit===req.unit && fact.revision===req.revision && fact.target===req.target
        && fact.kind==='action_event' && fact.predicate==='mutation_applied' && fact.outcome==='success'
        && sources.get(fact.call_source_id)?.target===req.target && sources.get(fact.call_source_id)?.target_kind===subjectKind) : []
      const rootSeq=sources.get(req.source.source_id)!.seq
      const originBound=(fact:Row):number=>{const call=sources.get(fact.call_source_id)!;return call.origin_root_source_id ? sources.get(call.origin_root_source_id)!.seq : call.seq}
      const violated=mutationFacts.some((fact)=>originBound(fact)>=rootSeq && sources.get(fact.call_source_id)!.seq>rootSeq && fact.seq<=watermark)
      const crossing=mutationFacts.some((fact)=>originBound(fact)<rootSeq && rootSeq<=fact.seq
        || sources.get(fact.call_source_id)!.seq<=rootSeq && rootSeq<=fact.seq)
      predicates[key]=violated?'constraint_violated':crossing?'constraint_unresolved':'constraint_active'; continue
    }
    let matched=[...validFacts.values()].filter((f)=>f.unit===req.unit && f.revision===req.revision && f.target===req.target && f.predicate===req.predicate && f.requirement_id===key && f.kind===req.evidence_kind && f.seq>=req.seq).sort((a,b)=>a.seq-b.seq)
    matched=matched.length ? matched.slice(-1).filter((f)=>f.outcome==='success') : []
    if (req.kind==='information') { matched=matched.filter((f)=>f.kind==='delivery' && sources.get(f.source_id)?.turn===snapshot.turn); if (matched.length) delivery.push(key) }
    else matched=matched.filter((f)=>['action_event','state_outcome'].includes(f.kind))
    predicates[key]=matched.length && req.kind!=='unknown' ? 'satisfied':'insufficient'
  }
  const actions: Row[] = [], rejected: Row[] = []
  for (const candidate of listed(snapshot.actions)) {
    if (candidate.seq>watermark) continue
    const req=current.get(candidate.requirement_id)
    let valid=Boolean(req && candidate.schema==='current-action-basis/v1' && candidate.state==='current' && candidate.owner==='assistant' && !['generic_work','unknown'].includes(candidate.action) && predicates[req.id]==='insufficient' && ['execution','proof'].includes(req.kind) && sourceMatches(candidate.source,sources,true) && same(candidate.source,req.source) && ['unit','revision','scope_sha256','target','predicate'].every((k)=>candidate[k]===req[k]) && candidate.seq>=req.seq && (req.condition_ids as string[]).every((id)=>released.has(id)))
    if (valid && req) valid=(candidate.relation==='direct' && candidate.action===req.action) || (candidate.relation==='verification_substep' && req.predicate==='test_passed' && candidate.action==='test_verify') || (candidate.relation==='readback_substep' && req.predicate==='state_matches' && candidate.action==='readback')
    const ready=candidate.readiness_fact_ids as string[]
    valid=valid && ready.length>0 && ready.every((id)=>{const f=validFacts.get(id); return f && f.kind==='readiness' && f.outcome==='success' && f.requirement_id===candidate.requirement_id && f.unit===candidate.unit && f.revision===candidate.revision && f.target===candidate.target})
    if (valid) actions.push(Object.fromEntries(['requirement_id','unit','revision','action','target','predicate','owner','source','seq'].map((k)=>[k,candidate[k]])))
    else rejected.push({requirement_id:candidate.requirement_id,reason:'action_basis_insufficient'})
  }
  const controls = foldRootControls(snapshot, sources, requirements, facts, units, watermark)
  const keptActions = actions.filter((candidate) => {
    const state = controls.states.get(candidate.requirement_id)
    if (!['paused', 'persistent_paused', 'cancelled'].includes(state ?? '')) return true
    rejected.push({ requirement_id: candidate.requirement_id, reason: `root_control_${state}` })
    return false
  })
  const intent=snapshot.intent as Row, intentSpan=intent.source as Row|null, intentSource=intentSpan ? sources.get(intentSpan.source_id) : undefined
  const intentValid=Boolean(intentSpan && sourceMatches(intentSpan,sources,true) && intentSource?.unit===unit && intentSource.revision===revision)
  const intentText=intentValid ? spanText(intentSpan!,intentSource!).trim() : ''
  const speech=intentText.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|‘[^’]*’|"[^"]*"/g,'').replace(/^\s*>.*$/gm,'')
  const resumeMatch=new RegExp(rules.EXECUTION_RESUME_RE,'i').test(speech)
  const persistence=[...controls.states].some(([key, state]) => (state === 'persistent' || state === 'persistent_paused')
    && requirements.has(key) && scopeOpen(requirements.get(key)!, watermark))
  const persistenceReady=keptActions.some((candidate) => controls.states.get(candidate.requirement_id) === 'persistent')
  const oldResume=Boolean(intentValid && resumeMatch && ['resume','persistence_and_resume'].includes(intent.kind)
    && keptActions.some((candidate) => current.get(candidate.requirement_id)!.seq <= intentSource!.seq))
  const resumed=oldResume || keptActions.some((candidate) => controls.resumed.has(candidate.requirement_id))
  const external=sortedUnique([...validFacts.values()].filter((f)=>f.unit && units.has(f.unit) && f.kind==='external_operation' && f.outcome==='unknown' && f.operation_id && current.has(f.requirement_id) && f.revision===current.get(f.requirement_id)!.revision && conditions.has(f.condition_id) && !released.has(f.condition_id) && conditions.get(f.condition_id)!.kind==='external_dependency' && conditions.get(f.condition_id)!.operation_id===f.operation_id && current.get(f.requirement_id)!.condition_ids.includes(f.condition_id)).map((f)=>f.operation_id))
  const missing=[...current].filter(([key,r])=>r.required && controls.states.get(key) !== 'cancelled'
    && !['satisfied','constraint_active'].includes(predicates[key])).map(([key])=>key).sort(utf8Compare)
  const represented=new Set([...current.values(), ...historicalExplained.values()].map((r)=>r.source.source_id).concat([...controls.represented]))
  const missingSources=[...activeRootIds].filter((key)=>!represented.has(key))
  const certifiable=!missing.length && !coverageErrors.length && !unknownCoverage.length && !missingSources.length && !controls.errors.length
  const reasons:string[]=[]
  if (snapshot.completion_claim && !certifiable) reasons.push('wrong_whole_completion')
  if (snapshot.proof_violation) reasons.push('explicit_proof_unsatisfied')
  if (persistenceReady) reasons.push('explicit_user_persistence')
  if (resumed) reasons.push('resume_with_actionable_work')
  const correction=Boolean(reasons.length && snapshot.corrections_used===0 && snapshot.progress_changed)
  return {schema:'core-state/v2',unit,revision,as_of:watermark,coverage:snapshot.coverage,predicates,delivery:delivery.sort(utf8Compare),facts:[...validFacts.keys()].sort(utf8Compare),current_actions:keptActions,rejected_actions:rejected,unmet_requirements:missing,certifiable,coverage_errors:sortedUnique(coverageErrors),unknown_coverage:sortedUnique(unknownCoverage),target_origins:Object.fromEntries([...current].map(([key,r])=>[key,r.target_origin])),root_control_states:Object.fromEntries([...controls.states].sort(([a],[b])=>utf8Compare(a,b))),root_control_errors:sortedUnique(controls.errors),conditions:Object.fromEntries([...conditions].map(([key])=>[key,released.has(key)?'released':'pending'])),explicit_user_persistence:persistence,resume_with_actionable_work:resumed,registered_external_operations:external,ordinary_path_interference:false,stop:correction?'bounded_correction':external.length && !keptActions.length?'typed_wait':'ordinary_end',reason_codes:reasons,correction_count:Number(correction),goal_complete_allowed:!snapshot.goal_contract_adopted || certifiable,release_state:snapshot.release_state}
}
