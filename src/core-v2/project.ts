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
  const coverageErrors: string[] = [], unknownCoverage: string[] = []
  for (const [key, source] of sources) {
    if (source.kind !== 'root' || !units.has(source.unit) || (source.unit === unit && source.revision !== revision)) continue
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
  const requirements = index(listed(snapshot.requirements), watermark)
  const facts = index(listed(snapshot.facts), watermark)
  const current = new Map([...requirements].filter(([,row]) => units.has(row.unit) && (row.unit !== unit || row.revision === revision)))
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
  for (const coverage of listed(snapshot.coverage)) {
    const span = coverage.source, source = sources.get(span.source_id)
    if (!source || !units.has(source.unit) || coverage.kind !== 'interpreted') continue
    const covered = [...current.values()].filter((r) => r.source.source_id === span.source_id && r.source.start < span.end && r.source.end > span.start).map((r) => [r.source.start,r.source.end]).sort((a,b)=>a[0]-b[0])
    let cursor=span.start
    for (const [start,end] of covered) { if (start>cursor) break; cursor=Math.max(cursor,end) }
    if (cursor<span.end) coverageErrors.push(span.source_id)
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
  const intent=snapshot.intent as Row, intentSpan=intent.source as Row|null, intentSource=intentSpan ? sources.get(intentSpan.source_id) : undefined
  const intentValid=Boolean(intentSpan && sourceMatches(intentSpan,sources,true) && intentSource?.unit===unit && intentSource.revision===revision)
  const intentText=intentValid ? spanText(intentSpan!,intentSource!).trim() : ''
  const speech=intentText.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|‘[^’]*’|"[^"]*"/g,'').replace(/^\s*>.*$/gm,'')
  const resumeMatch=new RegExp(rules.EXECUTION_RESUME_RE,'i').test(speech)
  const persistenceMatch=new RegExp(rules.USER_PERSISTENCE_RE,'is').test(speech)
  const persistence=Boolean(intentValid && persistenceMatch && ['persistence','persistence_and_resume'].includes(intent.kind))
  const resumed=Boolean(intentValid && resumeMatch && ['resume','persistence_and_resume'].includes(intent.kind) && actions.length)
  const external=sortedUnique([...validFacts.values()].filter((f)=>f.unit && units.has(f.unit) && f.kind==='external_operation' && f.outcome==='unknown' && f.operation_id && current.has(f.requirement_id) && f.revision===current.get(f.requirement_id)!.revision && conditions.has(f.condition_id) && !released.has(f.condition_id) && conditions.get(f.condition_id)!.kind==='external_dependency' && conditions.get(f.condition_id)!.operation_id===f.operation_id && current.get(f.requirement_id)!.condition_ids.includes(f.condition_id)).map((f)=>f.operation_id))
  const missing=[...current].filter(([key,r])=>r.required && !['satisfied','constraint_active'].includes(predicates[key])).map(([key])=>key).sort(utf8Compare)
  const represented=new Set([...current.values()].map((r)=>r.source.source_id))
  const missingSources=[...sources].filter(([key,s])=>s.kind==='root' && units.has(s.unit) && (s.unit!==unit || s.revision===revision) && !represented.has(key))
  const certifiable=!missing.length && !coverageErrors.length && !unknownCoverage.length && !missingSources.length
  const reasons:string[]=[]
  if (snapshot.completion_claim && !certifiable) reasons.push('wrong_whole_completion')
  if (snapshot.proof_violation) reasons.push('explicit_proof_unsatisfied')
  if (actions.length && persistence) reasons.push('explicit_user_persistence')
  if (resumed) reasons.push('resume_with_actionable_work')
  const correction=Boolean(reasons.length && snapshot.corrections_used===0 && snapshot.progress_changed)
  return {schema:'core-state/v2',unit,revision,as_of:watermark,coverage:snapshot.coverage,predicates,delivery:delivery.sort(utf8Compare),facts:[...validFacts.keys()].sort(utf8Compare),current_actions:actions,rejected_actions:rejected,unmet_requirements:missing,certifiable,coverage_errors:sortedUnique(coverageErrors),unknown_coverage:sortedUnique(unknownCoverage),target_origins:Object.fromEntries([...current].map(([key,r])=>[key,r.target_origin])),conditions:Object.fromEntries([...conditions].map(([key])=>[key,released.has(key)?'released':'pending'])),explicit_user_persistence:persistence,resume_with_actionable_work:resumed,registered_external_operations:external,ordinary_path_interference:false,stop:correction?'bounded_correction':external.length && !actions.length?'typed_wait':'ordinary_end',reason_codes:reasons,correction_count:Number(correction),goal_complete_allowed:!snapshot.goal_contract_adopted || certifiable,release_state:snapshot.release_state}
}
