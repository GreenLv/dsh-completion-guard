import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  bindingDigest, bindingRecordDigest, bindingStateClosure, certificationDigest,
  DigestError, encodeMapRows, evidenceFactDigest, evidenceSha256Digest, field, hostLockDigest,
  locatorDigest, predParamsBytes, predParamsDigest, PRODUCT_KEY_VOCABULARY, resolveAllowlist,
  sessionRefDigest, typedToken,
} from '../../src/domain/digest.js'
import type {
  BindingRecord, CapabilityRow, CertificateInput, EvidenceFact, EvidenceRole,
  HostLockManifest, PackageRow, SessionHeader, Typed, TypedObject,
} from '../../src/domain/digest.js'

const CONFORMANCE = new URL('../../tests/fixtures/conformance/', import.meta.url)

interface PinFile {
  path: string
  sha256: string
}

const pin = JSON.parse(
  readFileSync(new URL('UPSTREAM_PIN.json', CONFORMANCE), 'utf8'),
) as { files: PinFile[] }

function sha256File(url: URL): string {
  return createHash('sha256').update(readFileSync(url)).digest('hex')
}

// -- fixture vector runner ---------------------------------------------------

type Vector = { id: string; kind: string; input: Record<string, unknown> }

const casesJson = JSON.parse(
  readFileSync(new URL('digest_v3/cases.json', CONFORMANCE), 'utf8'),
) as { vectors: Vector[] }
const expectedJson = JSON.parse(
  readFileSync(new URL('digest_v3/expected.json', CONFORMANCE), 'utf8'),
) as { expected: Record<string, string> }

const byId = new Map(casesJson.vectors.map((vector) => [vector.id, vector]))
const computed = new Map<string, string>()

function resolveDigest(value: unknown): string {
  if (typeof value === 'string') return value
  const ref = value as { ref?: string; k?: string; v?: unknown }
  if (ref.ref !== undefined) {
    const digest = computed.get(ref.ref)
    if (digest === undefined) throw new Error(`reference before computation: ${ref.ref}`)
    return digest
  }
  if (ref.k === 'x') return ref.v as string
  throw new Error(`expected digest or reference: ${JSON.stringify(value)}`)
}

function allowlistOf(spec: unknown): Set<string> {
  if (spec === undefined || spec === 'product') return new Set(PRODUCT_KEY_VOCABULARY)
  return new Set(spec as string[])
}

function materializeBinding(input: Record<string, unknown>): Record<string, unknown> {
  const binding = { ...input }
  if (binding.predParamsKind === 'inline' && binding.predParams !== undefined) {
    const ref = binding.predParams as { ref: string }
    const vector = byId.get(ref.ref)
    if (vector === undefined || vector.kind !== 'predParams') {
      throw new Error(`unknown predParams ref: ${ref.ref}`)
    }
    binding.predParams = vector.input.params
    binding.predParamsAllowlist = vector.input.keyAllowlist
  }
  if (binding.predParamsKind === 'manifest' && binding.predParamsDigestRef !== undefined) {
    const ref = binding.predParamsDigestRef as string
    const vector = byId.get(ref)
    if (vector === undefined || vector.kind !== 'predParams') {
      throw new Error(`unknown predParams manifest ref: ${ref}`)
    }
    binding.predParamsManifest = vector.input.params
    binding.predParamsManifestAllowlist = vector.input.keyAllowlist
    delete binding.predParamsDigestRef
  }
  return binding
}

function computeVector(vector: Vector): string {
  const input = vector.input
  switch (vector.kind) {
    case 'sessionRefDigest':
      return sessionRefDigest(input as unknown as SessionHeader)
    case 'hostLockDigest':
      return hostLockDigest(input as unknown as HostLockManifest)
    case 'evidenceFact':
      return evidenceFactDigest(input as unknown as EvidenceFact)
    case 'evidenceSha256': {
      const facts = (input.facts as { factRef: string }[]).map((entry) => {
        const factVector = byId.get(entry.factRef)
        if (factVector === undefined) throw new Error(`unknown factRef: ${entry.factRef}`)
        return factVector.input as unknown as EvidenceFact
      })
      return evidenceSha256Digest(facts)
    }
    case 'predParams': {
      const params = input.params as unknown as Record<string, Typed>
      return predParamsDigest(params, allowlistOf(input.keyAllowlist))
    }
    case 'bindingRecord': {
      const binding = materializeBinding(input)
      const tupleAllowlist = allowlistOf(binding.keyAllowlist)
      delete binding.keyAllowlist
      return bindingRecordDigest(binding as unknown as BindingRecord, tupleAllowlist)
    }
    case 'bindingDigest': {
      const records = (input.bindings as { ref: string }[]).map((entry) =>
        materializeBinding(byId.get(entry.ref)!.input),
      )
      return bindingDigest(records as unknown as BindingRecord[], new Set(PRODUCT_KEY_VOCABULARY))
    }
    case 'certificationDigest': {
      const cert = input as Record<string, unknown>
      const certificate: CertificateInput = {
        stopProtocolVersion: cert.stopProtocolVersion as string,
        certificateVersion: cert.certificateVersion as string,
        epoch: cert.epoch as number,
        sessionRefDigest: resolveDigest(cert.sessionRefDigest),
        hostLockDigest: resolveDigest(cert.hostLockDigest),
        contractRevision: cert.contractRevision as number,
        contractSha256: resolveDigest(cert.contractSha256),
        goalRef: cert.goalRef as { id: string; revision: number } | undefined,
        openDigest: resolveDigest(cert.openDigest),
        evidenceSha256: resolveDigest(cert.evidenceSha256),
        bindingDigest: resolveDigest(cert.bindingDigest),
      }
      return certificationDigest(certificate)
    }
    case 'locator':
      return locatorDigest((input as { raw: string }).raw)
    default:
      throw new Error(`unknown vector kind: ${vector.kind}`)
  }
}

function computeAll(): Record<string, string> {
  const results: Record<string, string> = {}
  for (const vector of casesJson.vectors) {
    results[vector.id] = computeVector(vector)
    computed.set(vector.id, results[vector.id])
  }
  return results
}

// -- tests -------------------------------------------------------------------

describe('digest v3 byte mirror pin', () => {
  it('mirrors are byte-identical to the pinned upstream hashes', () => {
    expect(pin.files.length).toBe(4)
    for (const entry of pin.files) {
      expect(sha256File(new URL(entry.path, CONFORMANCE))).toBe(entry.sha256)
    }
  })
})

describe('digest v3 cross-language vectors', () => {
  it('re-derives all 29 golden vectors identically to the canonical encoder', () => {
    const results = computeAll()
    expect(Object.keys(results).length).toBe(29)
    expect(results).toEqual(expectedJson.expected)
  })

  it('recomputing keeps vector order independence for evidence sets', () => {
    const before = computeAll()
    const esh = casesJson.vectors.find((vector) => vector.id === 'ESH_PULL')
    expect(esh).toBeDefined()
    esh!.input.facts = (esh!.input.facts as unknown[]).slice().reverse()
    const after = computeAll()
    expect(after.ESH_PULL).toBe(before.ESH_PULL)
  })
})

describe('digest v3 fail-closed edges', () => {
  const testAllowlist = new Set(['aa', 'b', 'symbol', 'accent'])

  it('sorts canonical maps by semantic key bytes, not encoded bytes', () => {
    const params: Record<string, Typed> = {
      b: { k: 's', v: '1' },
      aa: { k: 's', v: '1' },
    }
    const payload = predParamsBytes(params, testAllowlist)
    const aaField = field('aa', typedToken({ k: 's', v: '1' }))
    const bField = field('b', typedToken({ k: 's', v: '1' }))
    const semanticOrder = Buffer.concat([
      Buffer.from('ccg.predParams.v3\n', 'utf8'), aaField, bField,
    ])
    expect(payload.equals(semanticOrder)).toBe(true)
  })

  it('length prefixes prevent the raw field concatenation collision', () => {
    const left = field('malicious\x00name', Buffer.from('s:z', 'utf8'))
    const right = Buffer.concat([
      field('a', Buffer.from('s:x', 'utf8')),
      field('b', Buffer.from('s:z', 'utf8')),
    ])
    expect(left.equals(right)).toBe(false)
  })

  it('rejects lone surrogates before hashing', () => {
    const params: Record<string, Typed> = { accent: { k: 's', v: 'a\ud800b' } }
    expect(() => predParamsBytes(params, testAllowlist)).toThrow(DigestError)
  })

  it('does not normalize Unicode: NFC and NFD produce different digests', () => {
    const nfcParams: Record<string, Typed> = { accent: { k: 's', v: 'é' } }
    const nfdParams: Record<string, Typed> = { accent: { k: 's', v: 'e\u0301' } }
    const nfc = predParamsDigest(nfcParams, testAllowlist)
    const nfd = predParamsDigest(nfdParams, testAllowlist)
    expect(nfc).toBe(expectedJson.expected.U2)
    expect(nfd).toBe(expectedJson.expected.U3)
    expect(nfc).not.toBe(nfd)
  })

  it('rejects duplicate capability rows, evidence ids, bindings, and state ids', () => {
    const duplicatedCapability: HostLockManifest = {
      manifestVersion: 1,
      supportedGoalVersions: ['1.0.0'],
      capabilities: [
        { name: 'goal_disarm_readback', value: { k: 's', v: 'required' } },
        { name: 'goal_disarm_readback', value: { k: 's', v: 'required' } },
      ],
    }
    expect(() => hostLockDigest(duplicatedCapability)).toThrow(DigestError)
    const fact: EvidenceFact = {
      id: 'e1',
      outcome: 'success',
      method: 'shell',
      surfaces: ['artifact'],
      semanticAction: 'test',
      evidenceRole: 'effect',
      resolvedTarget: { scope: { k: 's', v: 's' } },
      parseStatus: 'supported',
    }
    expect(() => evidenceSha256Digest([fact, { ...fact }])).toThrow(DigestError)
    const row: BindingRecord = {
      item: 'i',
      semanticAction: 'test',
      resolvedTarget: { scope: { k: 's', v: 's' } },
      predId: 'p',
      predVersion: 1,
      predParamsKind: 'inline',
      predParams: { expected_outcome: { k: 'e', v: 'success' } },
      effectEvidenceId: 'e1',
    }
    expect(() => bindingDigest([row, { ...row }], new Set(PRODUCT_KEY_VOCABULARY))).toThrow(DigestError)
    const withState: BindingRecord = {
      ...row,
      semanticAction: 'pull',
      observedState: { post_head_oid: { k: 'x', v: 'ab'.repeat(32) } },
      stateEvidenceIds: ['e2', 'e2'],
    }
    expect(() => bindingRecordDigest(withState, new Set(PRODUCT_KEY_VOCABULARY))).toThrow(DigestError)
  })

  it('rejects camelCase keys, unknown vocabulary, and bad surfaces before hashing', () => {
    const camel: Record<string, Typed> = { upstreamOid: { k: 'x', v: 'ab'.repeat(32) } }
    expect(() => predParamsBytes(camel, new Set(PRODUCT_KEY_VOCABULARY))).toThrow(DigestError)
    const outside: Record<string, Typed> = { symbol: { k: 's', v: 'x' } }
    expect(() => predParamsBytes(outside, new Set(PRODUCT_KEY_VOCABULARY))).toThrow(DigestError)
    const multiSurface: EvidenceFact = {
      id: 'e1',
      outcome: 'success',
      method: 'shell',
      semanticAction: 'test',
      evidenceRole: 'effect',
      resolvedTarget: { scope: { k: 's', v: 's' } },
      parseStatus: 'supported',
      surfaces: ['artifact', 'ui'],
    }
    expect(() => evidenceFactDigest(multiSurface)).toThrow(DigestError)
    const unknownSurface: EvidenceFact = {
      id: 'e1',
      outcome: 'success',
      method: 'shell',
      semanticAction: 'test',
      evidenceRole: 'effect',
      resolvedTarget: { scope: { k: 's', v: 's' } },
      parseStatus: 'supported',
      surfaces: ['ntfs' as never],
    }
    expect(() => evidenceFactDigest(unknownSurface)).toThrow(DigestError)
  })

  it('enforces the frozen length boundaries', () => {
    expect(() => field('k', Buffer.from(`s:${'a'.repeat(4095)}`, 'utf8'))).toThrow(DigestError)
    field('k', Buffer.from(`s:${'a'.repeat(4094)}`, 'utf8'))
    const overTotal: Record<string, Typed> = { accent: { k: 's', v: 'a'.repeat(4062) } }
    expect(() => predParamsBytes(overTotal, testAllowlist)).toThrow(DigestError)
    const names = Array.from({ length: 129 }, (_, i) => `p${String(i).padStart(3, '0')}`)
    const params: Record<string, Typed> = Object.fromEntries(
      names.map((name) => [name, { k: 'i', v: 1 } as TypedObject]),
    )
    expect(() => predParamsBytes(params, new Set(names))).toThrow(DigestError)
  })

  it('enforces the role matrix and rejects cross-paired evidence ids', () => {
    const fact = (
      id: string,
      role: EvidenceRole,
      observed: Record<string, Typed>,
    ): EvidenceFact => ({
      id,
      outcome: 'success',
      method: 'git',
      operations: ['run'],
      executables: ['git'],
      subjects: ['repo'],
      surfaces: ['artifact'],
      semanticAction: 'pull',
      evidenceRole: role,
      resolvedTarget: {
        remote: { k: 's', v: 'origin' },
        repository: { k: 's', v: 'repo' },
        refspec: { k: 's', v: 'main' },
      },
      observedState: observed,
      parseStatus: 'supported',
    })
    const resolution = fact('res', 'resolution', {})
    const effect = fact('eff', 'effect', {})
    const state = fact('st', 'state', { post_head_oid: { k: 'x', v: 'ab'.repeat(32) } })
    const binding: BindingRecord = {
      item: 'i',
      semanticAction: 'pull',
      resolvedTarget: {
        remote: { k: 's', v: 'origin' },
        repository: { k: 's', v: 'repo' },
        refspec: { k: 's', v: 'main' },
      },
      observedState: { post_head_oid: { k: 'x', v: 'ab'.repeat(32) } },
      predId: 'pred.pull.ff',
      predVersion: 1,
      predParamsKind: 'inline',
      predParams: { expected_outcome: { k: 'e', v: 'success' } },
      resolutionEvidenceId: 'res',
      effectEvidenceId: 'eff',
      stateEvidenceIds: ['st'],
    }
    expect(() => bindingStateClosure({
      binding, resolution, effect, states: [state], evidenceFacts: [resolution, effect, state],
    })).not.toThrow()
    const swapped: BindingRecord = { ...binding, resolutionEvidenceId: 'eff', effectEvidenceId: 'res' }
    expect(() => bindingStateClosure({ binding: swapped, resolution, effect, states: [state] })).toThrow(DigestError)
    const resMismatch: BindingRecord = {
      ...binding,
      resolvedTarget: { ...binding.resolvedTarget, refspec: { k: 's', v: 'feature' } },
    }
    expect(() => bindingStateClosure({ binding: resMismatch, resolution, effect, states: [state] })).toThrow(DigestError)
    const intersecting = fact('st2', 'state', { post_head_oid: { k: 'x', v: 'cd'.repeat(32) } })
    expect(() => bindingStateClosure({ binding, resolution, effect, states: [state, intersecting] })).toThrow(DigestError)
  })

  it('keeps same-reason different-locator subjects distinct', () => {
    const l1 = locatorDigest('\\\\server\\share\\x')
    const l3 = locatorDigest('\\\\server2\\share\\y')
    expect(l1).toBe(expectedJson.expected.L1)
    expect(l3).toBe(expectedJson.expected.L3)
    expect(l1).not.toBe(l3)
  })

  it('encodes absent optional fields with a zero-length presence-0 row', () => {
    const absent = field('reasonCode', null)
    expect(absent.subarray(4, 14).toString('utf8')).toBe('reasonCode')
    expect(absent.subarray(14, 15)).toEqual(Buffer.from([0]))
    expect(absent.readUInt32BE(15)).toBe(0)
    expect(encodeMapRows([]).length).toBe(0)
  })
})

describe('digest v3 adversarial contract (parity with the codex suite)', () => {
  const hex = 'ab'.repeat(32)
  const fact = (overrides: Record<string, unknown> = {}): EvidenceFact => ({
    id: 'e1',
    outcome: 'success',
    method: 'shell',
    surfaces: ['artifact'],
    semanticAction: 'test',
    evidenceRole: 'effect',
    resolvedTarget: { scope: { k: 's', v: 's' } },
    observedState: {},
    parseStatus: 'supported',
    ...overrides,
  } as unknown as EvidenceFact)
  const binding = (overrides: Record<string, unknown> = {}): BindingRecord => ({
    item: 'i',
    semanticAction: 'test',
    resolvedTarget: { scope: { k: 's', v: 's' } },
    predId: 'p',
    predVersion: 1,
    predParamsKind: 'inline',
    predParams: { expected_outcome: { k: 'e', v: 'success' } },
    effectEvidenceId: 'e1',
    ...overrides,
  } as unknown as BindingRecord)
  const certificate = (overrides: Record<string, unknown> = {}): CertificateInput => ({
    stopProtocolVersion: '2.0.0',
    certificateVersion: '1',
    epoch: 0,
    sessionRefDigest: hex,
    hostLockDigest: hex,
    contractRevision: 1,
    contractSha256: hex,
    openDigest: hex,
    evidenceSha256: hex,
    bindingDigest: hex,
    ...overrides,
  } as unknown as CertificateInput)

  it('rejects unknown fields in every manifest before hashing', () => {
    expect(() => sessionRefDigest({ version: 0, id: 's', createdAt: 1, evil: 'x' } as unknown as SessionHeader)).toThrow(DigestError)
    sessionRefDigest({ version: 0, id: 's', createdAt: 1 })
    expect(() => hostLockDigest({ manifestVersion: 1, supportedGoalVersions: ['1.0.0'], evil: 'x' } as unknown as HostLockManifest)).toThrow(DigestError)
    expect(() => hostLockDigest({
      manifestVersion: 1,
      supportedGoalVersions: ['1.0.0'],
      capabilities: [{ name: 'cap', value: 'v', evil: 'x' }] as unknown as CapabilityRow[],
    })).toThrow(DigestError)
    expect(() => hostLockDigest({
      manifestVersion: 1,
      supportedGoalVersions: ['1.0.0'],
      packages: [{ name: 'pkg-a', version: '1.0.0', integrity: undefined, evil: 'x' }] as unknown as PackageRow[],
    })).toThrow(DigestError)
    expect(() => evidenceFactDigest(fact({ evil: 'x' }))).toThrow(DigestError)
    expect(() => bindingRecordDigest(binding({ evil: 'x' }), new Set(PRODUCT_KEY_VOCABULARY))).toThrow(DigestError)
    expect(() => certificationDigest(certificate({ evil: 'x' }))).toThrow(DigestError)
    expect(() => certificationDigest(certificate({ goalRef: { id: 'g', revision: 1, evil: 'x' } }))).toThrow(DigestError)
  })

  it('requires reasonCode when parseStatus is not supported', () => {
    expect(() => evidenceFactDigest(fact({ parseStatus: 'malformed_quote' }))).toThrow(DigestError)
    expect(evidenceFactDigest(fact({ parseStatus: 'malformed_quote', reasonCode: 'quote unterminated' }))).toHaveLength(64)
  })

  it('fails closed on wrong session and package field types', () => {
    expect(() => sessionRefDigest({ version: 0, id: 's', createdAt: 1, seedLength: '42' } as unknown as SessionHeader)).toThrow(DigestError)
    expect(() => sessionRefDigest({ version: 0, id: 's', createdAt: '1' } as unknown as SessionHeader)).toThrow(DigestError)
    expect(() => sessionRefDigest({ version: 0, id: 's', createdAt: 1, agentPreset: 7 } as unknown as SessionHeader)).toThrow(DigestError)
    expect(() => hostLockDigest({
      manifestVersion: 1,
      supportedGoalVersions: ['1.0.0'],
      packages: [{ name: 'pkg-a', version: 1 }] as unknown as PackageRow[],
    })).toThrow(DigestError)
  })

  it('rejects non-safe-integer and non-boolean typed tokens', () => {
    expect(() => typedToken(1.5)).toThrow(DigestError)
    expect(() => typedToken({ k: 'b', v: 'not-a-bool' })).toThrow(DigestError)
    expect(typedToken({ k: 'b', v: true }).toString()).toBe('b:1')
  })

  it('enforces the exact evidenceFact field-count boundary', () => {
    const withSubjects = (count: number): EvidenceFact => fact({
      id: 'e1',
      subjects: Array.from({ length: count }, (_, i) => `subject-${String(i).padStart(4, '0')}`),
      semanticAction: 'test',
      evidenceRole: 'state',
      resolvedTarget: { scope: { k: 's', v: 's' } },
      observedState: { post_digest: { k: 's', v: 'd' } },
    })
    expect(evidenceFactDigest(withSubjects(116))).toHaveLength(64)
    expect(() => evidenceFactDigest(withSubjects(117))).toThrow(DigestError)
  })

  it('binds closure fact content to the evidenceSha256 set, not just ids', () => {
    const resolution = fact({ id: 'res', method: 'git', semanticAction: 'pull', evidenceRole: 'resolution' })
    const effect = fact({ id: 'eff', method: 'git', semanticAction: 'pull', evidenceRole: 'effect' })
    const state = fact({
      id: 'st', method: 'git', semanticAction: 'pull', evidenceRole: 'state',
      observedState: { post_head_oid: { k: 'x', v: 'ab'.repeat(32) } },
    })
    const pullBinding: BindingRecord = {
      item: 'i', semanticAction: 'pull',
      resolvedTarget: { scope: { k: 's', v: 's' } },
      observedState: { post_head_oid: { k: 'x', v: 'ab'.repeat(32) } },
      predId: 'pred.pull.ff', predVersion: 1, predParamsKind: 'inline',
      predParams: { expected_outcome: { k: 'e', v: 'success' } },
      resolutionEvidenceId: 'res', effectEvidenceId: 'eff', stateEvidenceIds: ['st'],
    }
    const impostor = fact({
      id: 'st', method: 'git', semanticAction: 'pull', evidenceRole: 'state',
      observedState: { post_head_oid: { k: 'x', v: 'cd'.repeat(32) } },
    })
    expect(() => bindingStateClosure({
      binding: pullBinding, resolution, effect, states: [impostor], evidenceFacts: [resolution, effect, state],
    })).toThrow(DigestError)
    expect(() => bindingStateClosure({
      binding: pullBinding, resolution, effect, states: [state], evidenceFacts: [resolution, effect, state, { ...state }],
    })).toThrow(DigestError)
    expect(() => bindingStateClosure({
      binding: pullBinding, resolution, effect, states: [state], evidenceFacts: [resolution, effect, state],
    })).not.toThrow()
  })
})

describe('digest v3 adversarial round two (parity with the codex suite)', () => {
  const inlineBinding = (overrides: Record<string, unknown> = {}): BindingRecord => ({
    item: 'i',
    semanticAction: 'test',
    resolvedTarget: { scope: { k: 's', v: 's' } },
    predId: 'p',
    predVersion: 1,
    predParamsKind: 'inline',
    predParams: { expected_outcome: { k: 'e', v: 'success' } },
    effectEvidenceId: 'e1',
    ...overrides,
  } as unknown as BindingRecord)

  it('rejects cross-branch fields on binding records', () => {
    expect(() => bindingRecordDigest(
      inlineBinding({ predParamsRef: 'cmd-manifest-0001' }), new Set(PRODUCT_KEY_VOCABULARY),
    )).toThrow(DigestError)
    expect(() => bindingRecordDigest(
      inlineBinding({ predParamsManifest: {} }), new Set(PRODUCT_KEY_VOCABULARY),
    )).toThrow(DigestError)
    const manifest = inlineBinding({
      predParamsKind: 'manifest',
      predParamsRef: 'cmd-manifest-0001',
      predParamsManifest: { scope: { k: 's', v: 'worktree' } },
    }) as unknown as Record<string, unknown>
    delete manifest.predParams
    expect(() => bindingRecordDigest(
      { ...manifest, predParams: { expected_outcome: { k: 'e', v: 'success' } } } as unknown as BindingRecord,
      new Set(PRODUCT_KEY_VOCABULARY),
    )).toThrow(DigestError)
    expect(bindingRecordDigest(inlineBinding(), new Set(PRODUCT_KEY_VOCABULARY))).toHaveLength(64)
    expect(bindingRecordDigest(manifest as unknown as BindingRecord, new Set(PRODUCT_KEY_VOCABULARY))).toHaveLength(64)
  })

  it('rejects typed token wrappers with extra or missing fields', () => {
    expect(() => typedToken({ k: 's', v: 'x', evil: 1 } as unknown as TypedObject)).toThrow(DigestError)
    expect(() => typedToken({ k: 's' } as unknown as TypedObject)).toThrow(DigestError)
    expect(typedToken({ k: 's', v: 'x' }).toString()).toBe('s:x')
  })

  it('rejects non-string versions, evidence list entries, and opt fields', () => {
    expect(() => hostLockDigest({
      manifestVersion: 1, supportedGoalVersions: [1],
    } as unknown as HostLockManifest)).toThrow(DigestError)
    const base = {
      id: 'e1', outcome: 'success', method: 'shell', operations: ['run'],
      surfaces: ['artifact'], semanticAction: 'test', evidenceRole: 'effect',
      resolvedTarget: { scope: { k: 's', v: 's' } }, observedState: {},
      parseStatus: 'supported',
    }
    expect(() => evidenceFactDigest({ ...base, operations: [1] } as unknown as EvidenceFact)).toThrow(DigestError)
    for (const optName of ['reasonCode', 'adapterId', 'adapterVersion']) {
      expect(() => evidenceFactDigest({ ...base, [optName]: 7 } as unknown as EvidenceFact)).toThrow(DigestError)
    }
    expect(evidenceFactDigest({ ...base, reasonCode: 'rc', adapterId: 'a', adapterVersion: '1.0.0' } as EvidenceFact)).toHaveLength(64)
  })

  it('treats explicit null reasonCode as absent for the parseStatus rule', () => {
    expect(() => evidenceFactDigest({
      id: 'e1', outcome: 'success', method: 'shell', surfaces: ['artifact'],
      semanticAction: 'test', evidenceRole: 'effect',
      resolvedTarget: { scope: { k: 's', v: 's' } }, observedState: {},
      parseStatus: 'malformed_quote', reasonCode: null,
    } as unknown as EvidenceFact)).toThrow(DigestError)
  })

  it('freezes the integer domain to safe integers', () => {
    expect(typedToken(2 ** 53 - 1).toString()).toBe('i:9007199254740991')
    expect(() => typedToken(2 ** 53)).toThrow(DigestError)
    expect(() => typedToken(-(2 ** 53))).toThrow(DigestError)
    expect(() => sessionRefDigest({
      version: 0, id: 's', createdAt: 2 ** 53,
    } as unknown as SessionHeader)).toThrow(DigestError)
  })

  it('enforces the exact binding field-count boundary', () => {
    const boundaryBinding = (stateIdCount: number): BindingRecord => {
      const filler = Object.fromEntries(
        PRODUCT_KEY_VOCABULARY.map((key) => [key, { k: 's', v: 'x' }]),
      )
      return {
        item: 'i',
        semanticAction: 'test',
        requestedTarget: { ...filler },
        resolvedTarget: { ...filler },
        observedState: { ...filler },
        predId: 'p',
        predVersion: 1,
        predParamsKind: 'inline',
        predParams: { expected_outcome: { k: 'e', v: 'success' } },
        effectEvidenceId: 'e1',
        stateEvidenceIds: Array.from({ length: stateIdCount }, (_, i) => `s${String(i).padStart(3, '0')}`),
      } as unknown as BindingRecord
    }
    expect(bindingRecordDigest(boundaryBinding(35), new Set(PRODUCT_KEY_VOCABULARY))).toHaveLength(64)
    expect(() => bindingRecordDigest(boundaryBinding(36), new Set(PRODUCT_KEY_VOCABULARY))).toThrow(DigestError)
  })

  it('sorts bindings by the frozen (item, semanticAction) tuple with NUL items', () => {
    const record = (item: string, action: string): BindingRecord => inlineBinding({ item, semanticAction: action })
    const first = record('a', 'z')
    const second = record('a\u0000', 'b')
    const dFirst = bindingRecordDigest(first, new Set(PRODUCT_KEY_VOCABULARY))
    const dSecond = bindingRecordDigest(second, new Set(PRODUCT_KEY_VOCABULARY))
    const digest = bindingDigest([first, second], new Set(PRODUCT_KEY_VOCABULARY))
    const tupleOrdered = createHash('sha256').update(Buffer.concat([
      Buffer.from('ccg.bindingDigest.v3\n', 'utf8'),
      field('binding', typedToken({ k: 'x', v: dFirst })),
      field('binding', typedToken({ k: 'x', v: dSecond })),
    ])).digest('hex')
    const concatOrdered = createHash('sha256').update(Buffer.concat([
      Buffer.from('ccg.bindingDigest.v3\n', 'utf8'),
      field('binding', typedToken({ k: 'x', v: dSecond })),
      field('binding', typedToken({ k: 'x', v: dFirst })),
    ])).digest('hex')
    expect(digest).toBe(tupleOrdered)
    expect(digest).not.toBe(concatOrdered)
  })
})

describe('digest v3 adversarial round three (parity with the codex suite)', () => {
  const inlineBase = (overrides: Record<string, unknown> = {}): BindingRecord => ({
    item: 'i',
    semanticAction: 'test',
    resolvedTarget: { scope: { k: 's', v: 's' } },
    predId: 'p',
    predVersion: 1,
    predParamsKind: 'inline',
    predParams: { expected_outcome: { k: 'e', v: 'success' } },
    effectEvidenceId: 'e1',
    ...overrides,
  } as unknown as BindingRecord)
  const certificateBase = (overrides: Record<string, unknown> = {}): CertificateInput => ({
    stopProtocolVersion: '2.0.0',
    certificateVersion: '1',
    epoch: 0,
    sessionRefDigest: 'ab'.repeat(32),
    hostLockDigest: 'ab'.repeat(32),
    contractRevision: 1,
    contractSha256: 'cd'.repeat(32),
    openDigest: '01'.repeat(32),
    evidenceSha256: '02'.repeat(32),
    bindingDigest: '03'.repeat(32),
    ...overrides,
  } as unknown as CertificateInput)

  it('requires binding evidence IDs to be strings', () => {
    expect(() => bindingRecordDigest(
      inlineBase({ resolutionEvidenceId: 7 }), new Set(PRODUCT_KEY_VOCABULARY),
    )).toThrow(DigestError)
    expect(() => bindingRecordDigest(
      inlineBase({ stateEvidenceIds: [7] }), new Set(PRODUCT_KEY_VOCABULARY),
    )).toThrow(DigestError)
    expect(() => bindingRecordDigest(
      inlineBase({ stateEvidenceIds: [true] }), new Set(PRODUCT_KEY_VOCABULARY),
    )).toThrow(DigestError)
    expect(bindingRecordDigest(
      inlineBase({ resolutionEvidenceId: 'res-1', stateEvidenceIds: ['st-1'] }),
      new Set(PRODUCT_KEY_VOCABULARY),
    )).toHaveLength(64)
  })

  it('rejects null collections, arrays, numeric names, and bad allowlists like Python', () => {
    expect(() => hostLockDigest({
      manifestVersion: 1, supportedGoalVersions: ['1.0.0'], capabilities: null,
    } as unknown as HostLockManifest)).toThrow(DigestError)
    expect(() => hostLockDigest({
      manifestVersion: 1, supportedGoalVersions: ['1.0.0'], capabilities: [], packages: null,
    } as unknown as HostLockManifest)).toThrow(DigestError)
    expect(() => hostLockDigest({
      manifestVersion: 1, supportedGoalVersions: ['1.0.0'],
      capabilities: [{ name: 7, value: 'v' }] as unknown as CapabilityRow[],
    })).toThrow(DigestError)
    expect(() => evidenceFactDigest({
      id: 'e1', outcome: 'success', method: 'shell', operations: null,
      surfaces: ['artifact'], semanticAction: 'test', evidenceRole: 'effect',
      resolvedTarget: { scope: { k: 's', v: 's' } }, observedState: {},
      parseStatus: 'supported',
    } as unknown as EvidenceFact)).toThrow(DigestError)
    expect(() => bindingRecordDigest(
      inlineBase({ stateEvidenceIds: null }), new Set(PRODUCT_KEY_VOCABULARY),
    )).toThrow(DigestError)
    expect(() => bindingRecordDigest(
      inlineBase({ predParams: [] }), new Set(PRODUCT_KEY_VOCABULARY),
    )).toThrow(DigestError)
    const manifestBinding = inlineBase({
      predParamsKind: 'manifest',
      predParamsRef: 'cmd-manifest-0001',
      predParamsManifest: [],
    }) as unknown as Record<string, unknown>
    delete manifestBinding.predParams
    expect(() => bindingRecordDigest(
      manifestBinding as unknown as BindingRecord, new Set(PRODUCT_KEY_VOCABULARY),
    )).toThrow(DigestError)
    expect(() => resolveAllowlist(['scope', 7] as unknown as string[])).toThrow(DigestError)
    expect(() => resolveAllowlist('product-v2' as never)).toThrow(DigestError)
  })

  it('requires certificate version strings and aligns null goalRef with Python', () => {
    expect(() => certificationDigest(certificateBase({ stopProtocolVersion: 2 }))).toThrow(DigestError)
    expect(() => certificationDigest(certificateBase({ certificateVersion: { k: 's', v: '1' } }))).toThrow(DigestError)
    const withoutGoal = certificationDigest(certificateBase())
    const nullGoal = certificationDigest(certificateBase({ goalRef: null }))
    expect(nullGoal).toBe(withoutGoal)
  })
})

describe('digest v3 explicit-null allowlist rule (parity with the codex suite)', () => {
  it('maps an explicit null keyAllowlist to the product vocabulary', () => {
    expect(resolveAllowlist(null)).toEqual(resolveAllowlist('product'))
    expect([...resolveAllowlist(null)].sort()).toEqual([...PRODUCT_KEY_VOCABULARY].sort())
    const params = { scope: { k: 's', v: 'worktree' } } as unknown as Record<string, Typed>
    expect(
      predParamsDigest(params, resolveAllowlist(null)),
    ).toBe(predParamsDigest(params, resolveAllowlist('product')))
  })
})

describe('digest v5 domain probes (parity with the codex suite)', () => {
  const fact = (overrides: Record<string, unknown> = {}): EvidenceFact => ({
    id: 'e1',
    outcome: 'success',
    method: 'shell',
    surfaces: ['artifact'],
    semanticAction: 'test',
    evidenceRole: 'effect',
    resolvedTarget: { scope: { k: 's', v: 's' } },
    observedState: {},
    parseStatus: 'supported',
    ...overrides,
  } as unknown as EvidenceFact)

  it('rejects trailing-newline grammar tokens like the codex encoder', () => {
    expect(() => typedToken({ k: 'e', v: 'ok\n' })).toThrow(DigestError)
    expect(() => typedToken({ k: 'x', v: 'ab\n' })).toThrow(DigestError)
    expect(() => hostLockDigest({
      manifestVersion: 1,
      supportedGoalVersions: ['1.0.0'],
      capabilities: [{ name: 'cap\n', value: 'v' }] as unknown as CapabilityRow[],
    })).toThrow(DigestError)
    expect(() => hostLockDigest({
      manifestVersion: 1,
      supportedGoalVersions: ['1.0.0'],
      packages: [{ name: 'pkg\n', version: '1.0.0' }] as unknown as PackageRow[],
    })).toThrow(DigestError)
    expect(() => evidenceFactDigest(fact({ parseStatus: 'supported\n', reasonCode: 'rc' }))).toThrow(DigestError)
    expect(() => evidenceFactDigest(fact({ resolvedTarget: { 'scope\n': { k: 's', v: 's' } } }))).toThrow(DigestError)
    // Strings without trailing newlines stay accepted.
    expect(evidenceFactDigest(fact())).toHaveLength(64)
  })

  it('normalizes integral JSON decimals to integer tokens like the codex encoder', () => {
    expect(typedToken(1.0).toString()).toBe('i:1')
    expect(typedToken(1e0).toString()).toBe('i:1')
    expect(typedToken({ k: 'i', v: 1.0 }).toString()).toBe('i:1')
    expect(typedToken(2 ** 53 - 1).toString()).toBe('i:9007199254740991')
    expect(() => typedToken(1.5)).toThrow(DigestError)
    expect(() => typedToken(2 ** 53)).toThrow(DigestError)
    expect(() => typedToken(Number.NaN)).toThrow(DigestError)
    expect(() => typedToken(Number.POSITIVE_INFINITY)).toThrow(DigestError)
    const base = { version: 0, id: 's', createdAt: 1 }
    expect(sessionRefDigest({ ...base, seedLength: 1.0 })).toBe(
      sessionRefDigest({ ...base, seedLength: 1 }),
    )
  })
})
