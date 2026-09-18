import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { deriveProjection } from '../../src/domain/derive.js'
import { createActionTool, createEvidenceTool, executableIdentity, executeAuditedCommand, windowsBatchCommand, type EvidenceToolRoots } from '../../src/tools/evidence.js'

const PACKAGE_ACTION_TIMEOUT_MS = process.platform === 'win32' ? 20_000 : 5_000

describe('Windows batch invocation encoding', () => {
  it('quotes fixed argv and rejects values subject to cmd expansion', () => {
    expect(windowsBatchCommand('C:\\Program Files (x86)\\dsh.cmd', ['--version']))
      .toBe('"C:\\Program Files (x86)\\dsh.cmd" "--version"')
    expect(windowsBatchCommand('C:\\tools\\dsh.cmd', ['space literal']))
      .toBe('"C:\\tools\\dsh.cmd" "space literal"')
    expect(windowsBatchCommand('C:\\%TEMP%\\dsh.cmd', ['--version'])).toBeUndefined()
    expect(windowsBatchCommand('C:\\tools\\dsh.cmd', ['bad&tail'])).toBeUndefined()
    expect(windowsBatchCommand('C:\\tools\\dsh.cmd', ['bad!tail'])).toBeUndefined()
    expect(windowsBatchCommand('C:\\tools\\dsh.cmd', ['bad"quote'])).toBeUndefined()
    expect(windowsBatchCommand('C:\\tools\\dsh.cmd', ['bad\nline'])).toBeUndefined()
  })

  it.skipIf(process.platform !== 'win32')('probes and executes one exact cmd shim without a PATH relookup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cg-windows-shim-'))
    const fakeBin = join(root, 'shim (space)')
    const swappedBin = join(root, 'swapped')
    const record = join(root, 'record (space).txt')
    await mkdir(fakeBin)
    await mkdir(swappedBin)
    await writeFile(join(fakeBin, 'dsh.cmd'), [
      '@echo off',
      'if "%~1"=="--version" (',
      '  echo dsh 0.3.0-test',
      '  exit /b 0',
      ')',
      'if "%~1"=="--record" (',
      '  > "%~2" echo %~3',
      '  exit /b 0',
      ')',
      'exit /b 2',
      '',
    ].join('\r\n'))
    await writeFile(join(swappedBin, 'dsh.cmd'), '@echo off\r\nexit /b 9\r\n')
    const originalPath = process.env.PATH
    const originalPathExt = process.env.PATHEXT
    const originalComSpec = process.env.ComSpec
    process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ''}`
    process.env.PATHEXT = '.EXE;.CMD;.BAT'
    try {
      const signal = new AbortController().signal
      const identity = await executableIdentity('dsh', signal)
      expect(identity).toMatchObject({
        executable: 'dsh',
        version: 'dsh 0.3.0-test',
        interpreterRealpath: expect.stringMatching(/cmd\.exe$/i),
        interpreterVersion: expect.any(String),
      })
      expect(identity?.interpreterVersion).not.toBe('')
      process.env.PATH = `${swappedBin}${delimiter}${originalPath ?? ''}`
      process.env.ComSpec = join(swappedBin, 'cmd.exe')
      await executeAuditedCommand(identity!, ['--record', record, 'space value'], undefined, signal)
      expect((await readFile(record, 'utf8')).trim()).toBe('space value')
      await expect(executeAuditedCommand(identity!, ['--record', record, '%TEMP%'], undefined, signal))
        .rejects.toThrow('unsafe Windows batch invocation')
      process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ''}`
      expect(await executableIdentity('dsh', signal)).toBeUndefined()
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      if (originalPathExt === undefined) delete process.env.PATHEXT
      else process.env.PATHEXT = originalPathExt
      if (originalComSpec === undefined) delete process.env.ComSpec
      else process.env.ComSpec = originalComSpec
    }
  })
})

function append(session: Session, type: string, data: unknown, options?: unknown): void {
  ;(session as unknown as { append(type: string, data: unknown, options?: unknown): void }).append(type, data, options)
}

function enable(session: Session): void {
  append(session, 'command/run', { commandId: `cmd-${session.seq}`, name: 'context-guard', args: 'on', source: { kind: 'user' } })
}

function user(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

function call(session: Session, callId: string, name: string, args: Record<string, unknown>): void {
  append(session, 'tool/call', { turn: 1, step: session.seq, callId, name, arguments: JSON.stringify(args) })
}

function result(session: Session, callId: string, value: unknown, meta?: unknown): void {
  append(session, 'tool/result', {
    turn: 1, step: session.seq,
    message: createToolResultMessage({ callId: callId as never, content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }),
    ...(meta ? { meta } : {}),
  }, { surfaceOp: 'append' })
}

function execution(session: Session, callId: string, name = 'context_guard_evidence') {
  return {
    callId, rootCallId: callId, name, arguments: {},
    agent: { session }, signal: new AbortController().signal,
    deferContext: () => {}, concludeTurn: () => {}, token: Symbol('test'),
  } as never
}

async function runProducer(session: Session, callId: string, args: Record<string, unknown>, roots?: EvidenceToolRoots) {
  const tool = createEvidenceTool(roots)
  call(session, callId, 'context_guard_evidence', args)
  const value = await tool.execute(args as never, execution(session, callId))
  const meta = tool.output.presentationMeta?.(args, value as never)
  result(session, callId, value, meta)
  return value as Record<string, unknown>
}

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512)
  const octal = (offset: number, length: number, value: number) => {
    header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii')
  }
  header.write(name, 0, 100, 'utf8')
  octal(100, 8, 0o644)
  octal(108, 8, 0)
  octal(116, 8, 0)
  octal(124, 12, size)
  octal(136, 12, 0)
  header.fill(0x20, 148, 156)
  header.write('0', 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
  header[154] = 0
  header[155] = 0x20
  return header
}

async function packFixture(
  root: string,
  name: string,
  version: string,
  manifestPath = 'package/package.json',
  gitHead = 'f'.repeat(40),
): Promise<string> {
  const output = join(root, 'packs')
  await mkdir(output, { recursive: true })
  // The canonical packer embeds the exact gitHead and the repository identity;
  // the release gate reads them from the artifact, so the fixture carries them.
  const manifest = Buffer.from(JSON.stringify({
    name, version, files: ['index.js'], gitHead,
    repository: { type: 'git', url: 'https://github.com/GreenLv/dsh-completion-guard.git' },
  }), 'utf8')
  const padding = Buffer.alloc((512 - (manifest.length % 512)) % 512)
  const tar = Buffer.concat([tarHeader(manifestPath, manifest.length), manifest, padding, Buffer.alloc(1024)])
  const path = join(output, `${name.replace(/[^a-z0-9]+/gi, '-')}-${version}.tgz`)
  await writeFile(path, gzipSync(tar, { level: 9 }))
  return path
}

describe('ordinary producer migration', () => {
  it.each(['install', 'apply', 'create', 'modify', 'restart', 'commit', 'push', 'pull', 'fetch'] as const)
  ('%s returns a diagnostic without probing or creating a current qualification', async (action) => {
    const session = Session.create(SessionId(`migrated-${action}`), undefined, {
      version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId(`migrated-${action}`), createdAt: 1, cwd: '/fixture',
    })
    enable(session)
    user(session, `Perform ${action} in /fixture.`)
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Context Guard protocol boundary: v6.0.0' }],
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'migration boundary' } }), { surfaceOp: 'append' })
    let effects = 0
    const roots: EvidenceToolRoots = {
      commandRunner: async () => { effects += 1 },
      readExecutableIdentity: async () => { effects += 1; return undefined },
    }
    for (const role of ['resolution', 'effect', 'state'] as const) {
      const value = await runProducer(session, `${action}-${role}`, { semantic_action: action, evidence_role: role }, roots)
      expect(value).toMatchObject({ status: 'unavailable', reason_code: 'ordinary_evidence_migrated_to_host_facts' })
    }
    expect(effects).toBe(0)
    const projection = deriveProjection(session.snapshotEvents() as never, { activation: 'opt-in' }, { cwd: '/fixture' }, true).projection
    expect([...projection.evidence.values()].filter((row) => row.toolName === 'context_guard_evidence')
      .every((row) => row.outcome !== 'success' || row.parseStatus === 'adapter_unavailable')).toBe(true)
  })
})

describe('0.6.0 C10: the release ticket gate runs before any publish effect', () => {
  /**
   * A real pack → resolution → action round trip. The tgz bytes are the trusted
   * producer for the candidate identity (SHA-256, npm SRI, package, version,
   * embedded gitHead, repository); the registry readback is mocked.
   */
  async function publishFixture(label: string, options: { gitHead?: string } = {}) {
    const root = await mkdtemp(join(tmpdir(), `dsh-cg-release-${label}-`))
    const registry = 'https://registry.example.invalid/'
    const executableIdentity = { executable: 'npm' as const, realpath: '/fixture/bin/npm', version: '10.0.0' }
    const tgz = await packFixture(root, `fixture-release-${label}`, '1.0.0', 'package/package.json', options.gitHead)
    const session = Session.create(SessionId(`producer-release-${label}`), undefined, {
      version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId(`producer-release-${label}`), createdAt: 1, cwd: root,
    })
    enable(session)
    user(session, `Publish package fixture-release-${label} version 1.0.0 registry ${registry}`)
    const resolution = await runProducer(session, `${label}-resolution`, {
      semantic_action: 'publish', evidence_role: 'resolution',
      selector: { artifact_id: `fixture-release-${label}`, version: '1.0.0', registry },
      command_manifest: { manifest_id: 'npm.publish_tgz.v1', tgz_path: tgz },
    }, { readExecutableIdentity: async () => executableIdentity })
    return { root, registry, executableIdentity, session, resolution, label }
  }

  it('FOLLOWUP F04: the real publish producer observes the registry required by the contract', async()=>{
 const f=await publishFixture('registry-observation');
 try { let observed:any; const tool=createActionTool({prepareMutation:async()=>true,authorizeMutation:()=>({status:'authorized',reasonCode:'test'}),readExecutableIdentity:async()=>f.executableIdentity,releaseGate:async request=>{observed=request.observed;return {status:'denied',reasonCode:'test_stop_before_effect'}}});
 await tool.execute({semantic_action:'publish',resolution_call_id:'registry-observation-resolution',target_digest:f.resolution.target_digest,contract_item_id:'R001',contract_item_revision:1} as never,execution(f.session,'probe','context_guard_action'));
 console.log('OBSERVED',observed); expect(observed.registry).toBe(f.registry);
 } finally { await rm(f.root,{recursive:true,force:true}) }
 });
  it('refuses an ungranted ticket without probing or executing anything', async () => {
    const f = await publishFixture('denied')
    try {
      let commands = 0
      let http = 0
      let gateCalls = 0
      let settlements = 0
      const observed: Array<Record<string, unknown>> = []
      const tool = createActionTool({
        prepareMutation: async () => true,
        authorizeMutation: () => ({ status: 'authorized', reasonCode: 'test_root_contract_authorized' }),
        readExecutableIdentity: async () => f.executableIdentity,
        commandRunner: async () => { commands += 1 },
        fetcher: async () => { http += 1; return new Response('{}', { status: 500 }) },
        releaseGate: async (request) => {
          gateCalls += 1
          observed.push({ ...request.observed })
          expect(request.operation).toBe('npm_publish')
          return { status: 'denied', reasonCode: 'release_operation_consumed' }
        },
        releaseSettle: async () => { settlements += 1 },
      })
      const denied = await tool.execute({
        semantic_action: 'publish', resolution_call_id: 'denied-resolution',
        target_digest: f.resolution.target_digest,
        contract_item_id: 'R001', contract_item_revision: 1,
      } as never, execution(f.session, 'release-action', 'context_guard_action'))
      expect(denied).toMatchObject({ status: 'unavailable', reason_code: 'release_operation_consumed' })
      // The gate ran before every probe and effect, and nothing was settled.
      expect({ gateCalls, commands, http, settlements }).toEqual({ gateCalls: 1, commands: 0, http: 0, settlements: 0 })
      // The observed identity is the artifact's own, not a caller assertion.
      expect(observed[0]).toMatchObject({
        packageId: 'fixture-release-denied', version: '1.0.0', fullSha40: 'f'.repeat(40),
        repository: 'https://github.com/GreenLv/dsh-completion-guard.git',
        artifactSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        artifactSri: expect.stringMatching(/^sha512-/),
      })
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('executes a granted ticket once and reports the provable effect with its readback', async () => {
    const f = await publishFixture('granted')
    try {
      let commands = 0
      let gateCalls = 0
      const settlements: Array<Record<string, unknown>> = []
      const tool = createActionTool({
        prepareMutation: async () => true,
        authorizeMutation: () => ({ status: 'authorized', reasonCode: 'test_root_contract_authorized' }),
        readExecutableIdentity: async () => f.executableIdentity,
        commandRunner: async () => { commands += 1 },
        // No registry producer in this fixture: the attempt must be reported as
        // completed-without-readback, never as a verified release.
        fetcher: async () => new Response('{}', { status: 404 }),
        releaseGate: async () => { gateCalls += 1; return { status: 'granted', reasonCode: 'release_contract_granted', contractId: 'rel-1' } },
        releaseSettle: async (request) => { settlements.push({ ...request }) },
      })
      const granted = await tool.execute({
        semantic_action: 'publish', resolution_call_id: 'granted-resolution',
        target_digest: f.resolution.target_digest,
        contract_item_id: 'R001', contract_item_revision: 1,
      } as never, execution(f.session, 'grant-action', 'context_guard_action'))
      expect(granted).toMatchObject({ status: 'completed' })
      expect({ gateCalls, commands }).toEqual({ gateCalls: 1, commands: 1 })
      expect(settlements).toHaveLength(1)
      expect(settlements[0]).toMatchObject({
        operation: 'npm_publish', callId: 'granted-resolution', contractId: 'rel-1',
        effect: 'completed', readback: 'unavailable',
      })
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('settles from a trusted readback only when the registry returns the released bytes', async () => {
    const f = await publishFixture('readback')
    try {
      const settlements: Array<Record<string, unknown>> = []
      const tool = createActionTool({
        prepareMutation: async () => true,
        authorizeMutation: () => ({ status: 'authorized', reasonCode: 'test_root_contract_authorized' }),
        readExecutableIdentity: async () => f.executableIdentity,
        commandRunner: async () => {},
        // The registry answers with a DIFFERENT integrity than the bytes we
        // released: that is not this contract's artifact.
        fetcher: async () => new Response(JSON.stringify({
          name: 'fixture-release-readback', versions: { '1.0.0': { name: 'fixture-release-readback', version: '1.0.0', dist: { integrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}` } } },
        }), { status: 200, headers: { 'content-type': 'application/json' } }),
        releaseGate: async () => ({ status: 'granted', reasonCode: 'release_contract_granted', contractId: 'rel-1' }),
        releaseSettle: async (request) => { settlements.push({ ...request }) },
      })
      const value = await tool.execute({
        semantic_action: 'publish', resolution_call_id: 'readback-resolution',
        target_digest: f.resolution.target_digest,
        contract_item_id: 'R001', contract_item_revision: 1,
      } as never, execution(f.session, 'readback-action', 'context_guard_action'))
      expect(value).toMatchObject({ status: 'completed' })
      // The readback identity is forwarded, and the RUNTIME decides whether it
      // settles the contract; a mismatching one never becomes a settlement.
      expect(settlements).toHaveLength(1)
      expect(settlements[0]).toMatchObject({ effect: 'completed' })
      expect(settlements[0].readback).toMatchObject({ kind: 'npm_integrity' })
      expect(String((settlements[0].readback as { identity: string }).identity)).toMatch(/^sha512-/)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('a missing release gate keeps the existing Guard-owned authorization chain', async () => {
    const f = await publishFixture('absent')
    try {
      let commands = 0
      const tool = createActionTool({
        prepareMutation: async () => true,
        authorizeMutation: () => ({ status: 'authorized', reasonCode: 'test_root_contract_authorized' }),
        readExecutableIdentity: async () => f.executableIdentity,
        commandRunner: async () => { commands += 1 },
      })
      const value = await tool.execute({
        semantic_action: 'publish', resolution_call_id: 'absent-resolution',
        target_digest: f.resolution.target_digest,
        contract_item_id: 'R001', contract_item_revision: 1,
      } as never, execution(f.session, 'absent-action', 'context_guard_action'))
      expect(value).toMatchObject({ status: 'completed' })
      expect(commands).toBe(1)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
}, PACKAGE_ACTION_TIMEOUT_MS)
