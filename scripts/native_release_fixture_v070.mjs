/** Isolated adopted-release contract control for the v0.7 native probe.
 * The product's actual release gate and receipt producers run against a real
 * Session; the npm runner and registry HTTP response are local in-memory seams.
 * No public registry request or publish command can leave this function. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { runtimeRequire } from './native_host_probe.mjs'

const SHA = 'f'.repeat(40)
const PACKAGE = 'native-release-fixture'
const VERSION = '1.0.0'
const REGISTRY = 'https://registry.example.invalid/'

function tarHeader(name, size) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('000644 \0', 100, 8, 'ascii')
  header.write('000000 \0', 108, 8, 'ascii')
  header.write('000000 \0', 116, 8, 'ascii')
  header.write(`${size.toString(8).padStart(11, '0')} `, 124, 12, 'ascii')
  header.write('00000000000 ', 136, 12, 'ascii')
  header.write('        ', 148, 8, 'ascii')
  header.write('0', 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

function fixturePackage(root) {
  const output = join(root, 'native-release-fixture.tgz')
  const manifest = Buffer.from(JSON.stringify({
    name: PACKAGE, version: VERSION, files: ['index.js'], gitHead: SHA,
    repository: { type: 'git', url: 'https://github.com/GreenLv/dsh-completion-guard.git' },
  }))
  const padding = Buffer.alloc((512 - (manifest.length % 512)) % 512)
  const tar = Buffer.concat([
    tarHeader('package/package.json', manifest.length), manifest, padding,
    tarHeader('package/index.js', 3), Buffer.from('x\n\n'), Buffer.alloc(1024),
  ])
  writeFileSync(output, gzipSync(tar, { level: 9 }))
  return output
}

export async function runNativeReleaseFixture(config) {
  const require = runtimeRequire(config.runtimeRoot)
  const { Session, SessionId, SESSION_FORMAT_VERSION } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href)
  const { createUserMessage, createToolResultMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
  const product = await import(pathToFileURL(join(config.profileRoot, 'node_modules', 'dsh-completion-guard', 'dist', 'index.js')).href)
  const domain = await import(pathToFileURL(join(config.profileRoot, 'node_modules', 'dsh-completion-guard', 'dist', 'domain', 'index.js')).href)
  const root = join(config.workRoot, `native-release-${config.nonce}`)
  mkdirSync(root, { recursive: true })
  const tgz = fixturePackage(root)
  const artifactSha256 = createHash('sha256').update(readFileSync(tgz)).digest('hex')
  let registryIntegrity = `sha512-${Buffer.alloc(64, 5).toString('base64')}`
  let publishCount = 0
  const fetcher = async input => {
    const url = String(input)
    assert.ok(url.startsWith(REGISTRY), 'release fixture must not contact a public registry')
    const name = decodeURIComponent(url.slice(REGISTRY.length).replace(/\/+$/, ''))
    return new Response(JSON.stringify({ name, versions: { [VERSION]: {
      name, version: VERSION, dist: { integrity: registryIntegrity },
    } } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const sessionId = SessionId(`guard-native-release-${config.nonce}`)
  const session = Session.create(sessionId, undefined, {
    version: SESSION_FORMAT_VERSION, isSeeded: false, id: sessionId, createdAt: 1, cwd: root,
  })
  const registered = []
  const handlers = new Map()
  const ctx = {
    commands: { register: () => () => {} },
    on: (name, handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => {} },
    get: () => undefined,
    sessions: { flush: async () => true },
  }
  product.apply(ctx, { activation: 'always', policy: 'release' }, {
    commandRunner: async () => { publishCount++ }, fetcher,
    allowLoopbackHttpRegistry: true,
    hostLock: { ...domain.evaluateHostLock(config.hostPackages, {
      platform: process.platform === 'win32' ? 'windows' : 'posix', profileKind: config.profile,
    }), goalAvailable: false },
  })
  const agent = { session, steer: () => {}, ctx: { tools: {
    register: tool => { registered.push(tool); return () => {} },
    guard: () => () => {}, get: () => undefined,
  }, get: () => undefined } }
  for (const handler of handlers.get('agent/session-start') ?? []) handler({ agent, source: 'startup' })
  let ordinal = 0
  const append = (type, data, options) => session.append(type, data, options)
  const notice = text => append('user/message', {
    source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text }],
  }, { surfaceOp: 'append' })
  const command = args => append('command/run', {
    commandId: `native-release-${++ordinal}`, name: 'context-guard', args, source: { kind: 'user' },
  })
  const rootMessage = text => append('user/message', createUserMessage({
    content: [{ type: 'text', text }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const projection = () => domain.deriveProjection(session.snapshotEvents(),
    { activation: 'always', policy: 'release' }, { cwd: root }, true).projection
  const runTool = async (name, args) => {
    const tool = registered.find(entry => entry.name === name)
    assert.ok(tool, `${name} registered`)
    const callId = `native-release-call-${++ordinal}`
    append('tool/call', { turn: 1, step: ordinal, callId, name, arguments: JSON.stringify(args) })
    const value = await tool.execute(args, { callId, rootCallId: callId, name, arguments: args,
      agent, signal: new AbortController().signal, deferContext: () => {}, concludeTurn: () => {}, token: Symbol('native-release') })
    const meta = tool.output?.presentationMeta?.(args, value)
    append('tool/result', { turn: 1, step: ordinal,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }),
      ...(meta ? { meta } : {}),
    }, { surfaceOp: 'append' })
    return { callId, value }
  }

  // This historical explicit release surface is intentionally preserved by
  // 0.7. The v5 notice selects its original certificate protocol; ordinary
  // 0.7 mutations are tested separately through native host tools.
  notice(domain.PROTOCOL_V5_NOTICE)
  rootMessage('Create release preparation report.txt')
  command('clear')
  const prepared = domain.certifyCheckpoint(projection(), [], 'C1', false)
  assert.equal(prepared.status, 'certified')
  const checkpoint = prepared.checkpoint
  append('tool/call', { turn: 1, step: ++ordinal, callId: 'native-closure', name: 'context_guard_checkpoint', arguments: '{"bindings":[]}' })
  append('tool/result', { turn: 1, step: ordinal,
    message: createToolResultMessage({ callId: 'native-closure', content: [{ type: 'text', text: JSON.stringify({
      status: 'certified', certificate: {
        stop_protocol_version: checkpoint.stopProtocolVersion, certificate_version: checkpoint.certificateVersion,
        epoch: checkpoint.epoch, session_ref_digest: checkpoint.sessionRefDigest,
        host_lock_digest: checkpoint.hostLockDigest, contract_revision: checkpoint.contractRevision,
        contract_sha256: checkpoint.contractSha256, open_digest: checkpoint.openDigest,
        evidence_sha256: checkpoint.evidenceSha256, binding_digest: checkpoint.bindingDigest,
        certification_digest: checkpoint.certificationDigest, goal_ref: checkpoint.goalRef ?? null,
        ...(checkpoint.unitId !== undefined ? { unit_id: checkpoint.unitId, unit_closure_digest: checkpoint.unitClosureDigest } : {}),
      },
    }) }], isError: false }),
  }, { surfaceOp: 'append' })
  const resolution = await runTool('context_guard_evidence', {
    semantic_action: 'publish', evidence_role: 'resolution',
    selector: { artifact_id: PACKAGE, version: VERSION, registry: REGISTRY },
    command_manifest: { manifest_id: 'npm.publish_tgz.v1', tgz_path: tgz },
  })
  assert.equal(resolution.value.status, 'supported')
  const sri = resolution.value.resolved_target.integrity_digest
  command(`release adopt ${JSON.stringify({
    contractId: 'native-release', operations: ['npm_publish'],
    candidate: { fullSha40: SHA, repository: 'https://github.com/GreenLv/dsh-completion-guard.git',
      packageId: PACKAGE, version: VERSION, artifactSha256, artifactSri: sri, registry: REGISTRY },
    readinessRefs: ['C1'], closureCertRef: 'C1',
  })}`)
  assert.equal(projection().releaseContracts.length, 1)
  rootMessage(`Publish package ${PACKAGE} version ${VERSION} registry ${REGISTRY}`)
  const item = [...projection().items.values()].find(entry => entry.status === 'pending' && entry.semanticAction === 'publish')
  assert.ok(item)
  const action = () => runTool('context_guard_action', {
    semantic_action: 'publish', resolution_call_id: resolution.callId,
    target_digest: resolution.value.target_digest, contract_item_id: item.id, contract_item_revision: item.revision,
  })
  const allowed = await action()
  assert.equal(allowed.value.status, 'completed', JSON.stringify({ status: allowed.value.status, reason_code: allowed.value.reason_code }))
  assert.equal(publishCount, 1)
  registryIntegrity = sri
  const reconciled = await runTool('context_guard_release', {
    operation: 'reconcile', contract_id: 'native-release', resolution_call_id: resolution.callId,
  })
  assert.equal(reconciled.value.status, 'settled')
  const replay = await action()
  assert.equal(replay.value.status, 'unavailable')
  assert.equal(replay.value.reason_code, 'release_operation_consumed')
  assert.equal(publishCount, 1)
  return { positive: true, negative: true, mock_only: true }
}
