import { sha256 } from './canonicalize.js'

export type InitialActivation = 'opt-in' | 'always'
export interface SessionBirthIdentity {
  id: string
  createdAt: number
  parentSession?: string
  isSeeded: boolean
  inheritedEventCount: number
  origin?: 'subagent'
  delegationDepth: number
}
export interface SessionActivationBinding {
  schema: 'dsh-session-activation/v1'
  identity: SessionBirthIdentity
  initialMode: InitialActivation
  source: 'fresh_creation' | 'legacy_adoption' | 'fork_inheritance'
  provenanceSha256: string
  sha256: string
}
export type SessionActivationRead =
  | { status: 'bound'; mode: InitialActivation; binding: SessionActivationBinding; key: string }
  | { status: 'unavailable'; reasonCode: string; key: string }

export function activationCanonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(activationCanonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${activationCanonical((value as Record<string, unknown>)[k])}`).join(',')}}`
  throw new TypeError('activation_non_json')
}
export const activationDigest = (value: unknown): string => sha256(activationCanonical(value))

/** Birth identity excludes preset, cwd, profile and host authority. */
export function sessionBirthIdentity(header: unknown, inheritedEventCount: unknown): SessionBirthIdentity {
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw new TypeError('activation_identity_unavailable')
  const h = header as Record<string, unknown>
  if (h.version !== 4 || typeof h.id !== 'string' || !h.id
    || !Number.isSafeInteger(h.createdAt) || (h.createdAt as number) < 0
    || typeof h.isSeeded !== 'boolean' || !Number.isSafeInteger(inheritedEventCount) || (inheritedEventCount as number) < 0
    || (!h.isSeeded && inheritedEventCount !== 0)
    || (h.parentSession !== undefined && (typeof h.parentSession !== 'string' || !h.parentSession))
    || (h.origin !== undefined && h.origin !== 'subagent')
    || (h.delegationDepth !== undefined && (!Number.isSafeInteger(h.delegationDepth) || (h.delegationDepth as number) < 0))) {
    throw new TypeError('activation_identity_unavailable')
  }
  return { id: h.id, createdAt: h.createdAt as number, isSeeded: h.isSeeded,
    inheritedEventCount: inheritedEventCount as number, delegationDepth: h.delegationDepth as number ?? 0,
    ...(typeof h.parentSession === 'string' ? { parentSession: h.parentSession } : {}),
    ...(h.origin === 'subagent' ? { origin: 'subagent' as const } : {}) }
}

/** Parse JSON while rejecting duplicate keys, including escaped aliases. */
export function activationJson(text: string): unknown {
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new TypeError('activation_json_budget')
  let i = 0
  const ws = () => { while (/\s/u.test(text[i] ?? '') && i < text.length) i++ }
  const string = (): string => {
    const start = i++
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i)) as string
    }
    throw new TypeError('activation_json_invalid')
  }
  const value = (depth: number): void => {
    if (depth > 32) throw new TypeError('activation_json_budget')
    ws()
    if (text[i] === '"') { string(); return }
    if (text[i] === '{' || text[i] === '[') {
      const object = text[i++] === '{', end = object ? '}' : ']', keys = new Set<string>()
      ws(); if (text[i] === end) { i++; return }
      while (true) {
        if (object) {
          ws(); if (text[i] !== '"') throw new TypeError('activation_json_invalid')
          const key = string()
          if (keys.has(key)) throw new TypeError('activation_json_duplicate_key')
          keys.add(key); ws(); if (text[i++] !== ':') throw new TypeError('activation_json_invalid')
        }
        value(depth + 1); ws()
        if (text[i] === end) { i++; return }
        if (text[i++] !== ',') throw new TypeError('activation_json_invalid')
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(i))
    if (!token) throw new TypeError('activation_json_invalid')
    i += token[0].length
  }
  value(0); ws(); if (i !== text.length) throw new TypeError('activation_json_invalid')
  return JSON.parse(text)
}

export function validateActivationBinding(value: unknown): SessionActivationBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('activation_binding_invalid')
  const b = value as SessionActivationBinding
  if (Object.keys(b).sort().join(',') !== 'identity,initialMode,provenanceSha256,schema,sha256,source'
    || b.schema !== 'dsh-session-activation/v1' || !['opt-in', 'always'].includes(b.initialMode)
    || !['fresh_creation', 'legacy_adoption', 'fork_inheritance'].includes(b.source)
    || typeof b.provenanceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(b.provenanceSha256)) throw new TypeError('activation_binding_invalid')
  const identity = sessionBirthIdentity({ ...b.identity, version: 4 }, b.identity?.inheritedEventCount)
  if (activationCanonical(identity) !== activationCanonical(b.identity)) throw new TypeError('activation_identity_invalid')
  const { sha256: digest, ...unsigned } = b
  if (digest !== activationDigest(unsigned)) throw new TypeError('activation_binding_digest_invalid')
  return b
}
