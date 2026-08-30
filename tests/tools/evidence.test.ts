import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { certifyCheckpoint } from '../../src/domain/checkpoint.js'
import { deriveProjection } from '../../src/domain/derive.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createActionTool, createEvidenceTool, evidenceTargetDigest, executableIdentity, executeAuditedCommand, expectedTransitionForResolution, RESTART_INTENT_PREFIX, windowsBatchCommand, type EvidenceToolRoots } from '../../src/tools/evidence.js'
import { validateActionTarget } from '../../src/domain/protocol-manifest.js'

const execFileAsync = promisify(execFile)
const GIT_ROUNDTRIP_TIMEOUT_MS = process.platform === 'win32' ? 20_000 : 5_000

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

async function runAction(session: Session, callId: string, args: Record<string, unknown>, roots?: EvidenceToolRoots) {
  const tool = createActionTool({
    prepareMutation: async () => true,
    authorizeMutation: () => ({ status: 'authorized', reasonCode: 'test_root_contract_authorized' }),
    ...roots,
  })
  const resolutionId = String(args.resolution_call_id ?? '')
  const resolution = [...session.events].reverse().find((raw: unknown) => {
    const event = raw as unknown as { type?: string; data?: { message?: { source?: { callId?: string } }; meta?: { contextGuard?: { resolvedTarget?: Record<string, string> } } } }
    return event.type === 'tool/result' && event.data?.message?.source?.callId === resolutionId && event.data.meta?.contextGuard?.resolvedTarget
  }) as unknown as { data?: { meta?: { contextGuard?: { resolvedTarget?: Record<string, string> } } } } | undefined
  const target = resolution?.data?.meta?.contextGuard?.resolvedTarget
  const boundedArgs = {
    contract_item_id: 'R-test', contract_item_revision: 1,
    ...args,
    ...(args.target_digest ? {} : target ? { target_digest: evidenceTargetDigest(target) } : {}),
  }
  call(session, callId, 'context_guard_action', boundedArgs)
  const value = await tool.execute(boundedArgs as never, execution(session, callId, 'context_guard_action'))
  const meta = tool.output.presentationMeta?.(boundedArgs, value as never)
  result(session, callId, value, meta)
  return value as Record<string, unknown>
}

async function runProducer(session: Session, callId: string, args: Record<string, unknown>, roots?: EvidenceToolRoots) {
  const tool = createEvidenceTool(roots)
  call(session, callId, 'context_guard_evidence', args)
  const value = await tool.execute(args as never, execution(session, callId))
  const meta = tool.output.presentationMeta?.(args, value as never)
  result(session, callId, value, meta)
  return value as Record<string, unknown>
}

async function packFixture(root: string, name: string, version: string): Promise<string> {
  const source = join(root, `${name.replace(/[^a-z0-9]+/gi, '-')}-source`)
  const output = join(root, 'packs')
  await mkdir(source, { recursive: true })
  await mkdir(output, { recursive: true })
  await writeFile(join(source, 'package.json'), JSON.stringify({ name, version, files: ['index.js'] }))
  await writeFile(join(source, 'index.js'), 'export {}\n')
  const npmCommand = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm'
  const npmArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm', 'pack', '--json', '--ignore-scripts', '--pack-destination', output]
    : ['pack', '--json', '--ignore-scripts', '--pack-destination', output]
  const { stdout } = await execFileAsync(npmCommand, npmArgs, {
    cwd: source,
    env: { ...process.env, npm_config_cache: join(root, 'npm-cache'), npm_config_ignore_scripts: 'true' },
  })
  const row = (JSON.parse(stdout) as Array<{ filename: string }>)[0]
  return join(output, row.filename)
}

async function writeInstalledPackage(profile: string, name: string, version: string, integrity: string, locator = `file:${name}-${version}.tgz`): Promise<void> {
  const packagePath = join(profile, 'node_modules', ...name.split('/'))
  await mkdir(packagePath, { recursive: true })
  await writeFile(join(packagePath, 'package.json'), JSON.stringify({ name, version }))
  await writeFile(join(profile, 'pnpm-lock.yaml'), [
    "lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies:', `      '${name}':`, `        specifier: ${locator}`, `        version: ${locator}`,
    '', 'packages:', '', `  '${name}@${locator}':`, `    resolution: {integrity: ${integrity}}`, '', 'snapshots:', '',
  ].join('\n'))
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await writeFile(join(profile, 'node_modules', '.package-map.json'), JSON.stringify({ packages: { '.': { url: '..', dependencies: { [name]: name } }, [name]: { url: `./${name}`, dependencies: {} } } }))
}

function certifyStateful(session: Session, action: 'install' | 'apply' | 'restart' | 'publish') {
  const projection = deriveProjection(session.events as never, { activation: 'opt-in' }, { cwd: String((session.header as { cwd?: unknown }).cwd ?? '') }, true).projection
  const facts = [...projection.evidence.values()].filter((entry) => entry.toolName === 'context_guard_evidence')
  expect(facts.map((entry) => entry.evidenceRole)).toEqual(['resolution', 'effect', 'state'])
  const item = [...projection.items.values()].find((entry) => entry.semanticAction === action)!
  const resolved = facts[0].resolvedTarget!
  const observed = facts[2].observedState!
  expect(facts[0].expectedTransition).toBeDefined()
  return certifyCheckpoint(projection, [{
    itemId: item.id, evidenceIds: facts.map((entry) => entry.id), semanticAction: action,
    requestedTarget: item.requestedTarget, resolvedTarget: resolved, observedState: observed,
    expectedTransition: facts[0].expectedTransition,
    resolutionEvidenceId: facts[0].id, effectEvidenceId: facts[1].id, stateEvidenceIds: [facts[2].id],
  }], `C-${action}`)
}

describe('trusted stateful evidence producer', () => {
  it('derives distinct real resolution/effect/state facts and certifies a create action', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cg-evidence-'))
    const artifact = join(dir, 'created.txt')
    const planned = { file_path: artifact, content: 'bounded producer fixture\n' }
    const session = Session.create(SessionId('producer-create-session'), undefined, {
      version: 0, id: SessionId('producer-create-session'), createdAt: 1, cwd: dir,
    })
    enable(session)
    user(session, `create ${artifact}`)

    const resolution = await runProducer(session, 'resolution-call', {
      semantic_action: 'create', evidence_role: 'resolution',
      selector: { artifact_id: artifact },
      command_manifest: { planned_tool: 'write', planned_arguments: planned },
    })
    expect(resolution.status).toBe('supported')

    call(session, 'actual-write', 'write', planned)
    await writeFile(artifact, planned.content, 'utf8')
    result(session, 'actual-write', { written: true })

    const effect = await runProducer(session, 'effect-fact', {
      semantic_action: 'create', evidence_role: 'effect',
      resolution_call_id: 'resolution-call', effect_call_id: 'actual-write',
    })
    const state = await runProducer(session, 'state-fact', {
      semantic_action: 'create', evidence_role: 'state',
      resolution_call_id: 'resolution-call', effect_call_id: 'actual-write',
    })
    expect(effect.status).toBe('supported')
    expect(state.status).toBe('supported')

    const projection = deriveProjection(session.events as never, { activation: 'opt-in' }, { cwd: dir }, true).projection
    const facts = [...projection.evidence.values()].filter((entry) => entry.toolName === 'context_guard_evidence')
    expect(facts.map((entry) => entry.evidenceRole)).toEqual(['resolution', 'effect', 'state'])
    expect(new Set(facts.map((entry) => entry.callId)).size).toBe(3)
    expect(facts.every((entry) => JSON.stringify(entry.resolvedTarget) === JSON.stringify(facts[0].resolvedTarget))).toBe(true)
    const item = [...projection.items.values()].find((entry) => entry.semanticAction === 'create')!
    const observed = facts.find((entry) => entry.evidenceRole === 'state')!.observedState!
    const certified = certifyCheckpoint(projection, [{
      itemId: item.id, evidenceIds: facts.map((entry) => entry.id), semanticAction: 'create',
      requestedTarget: item.requestedTarget, resolvedTarget: facts[0].resolvedTarget, observedState: observed,
      expectedTransition: { predicateId: 'pred.create.v1', version: 1, predParamsKind: 'inline', parameters: { post_digest: observed.post_digest } },
      resolutionEvidenceId: facts[0].id, effectEvidenceId: facts[1].id, stateEvidenceIds: [facts[2].id],
    }], 'C001')
    expect(certified.status).toBe('certified')
  })

  it.each(['create', 'modify'] as const)('%s freezes the post digest before effect and rejects divergent bytes', async (action) => {
    const dir = await mkdtemp(join(tmpdir(), `dsh-cg-${action}-transition-`))
    const artifact = join(dir, 'artifact.txt')
    if (action === 'modify') await writeFile(artifact, 'before OLD after\n', 'utf8')
    const plannedArguments = action === 'create'
      ? { file_path: artifact, content: 'expected bytes\n' }
      : { file_path: artifact, old_string: 'OLD', new_string: 'NEW' }
    const session = Session.create(SessionId(`producer-${action}-transition`), undefined, {
      version: 0, id: SessionId(`producer-${action}-transition`), createdAt: 1, cwd: dir,
    })
    enable(session)
    user(session, `${action} ${artifact}`)
    const resolution = await runProducer(session, `${action}-transition-resolution`, {
      semantic_action: action, evidence_role: 'resolution', selector: { artifact_id: artifact },
      command_manifest: { planned_tool: action === 'create' ? 'write' : 'edit', planned_arguments: plannedArguments },
    })
    expect(resolution).toMatchObject({ status: 'supported', expected_transition: { parameters: { post_digest: expect.any(String) } } })
    call(session, `${action}-transition-effect-call`, action === 'create' ? 'write' : 'edit', plannedArguments)
    await writeFile(artifact, 'attacker-divergent-bytes\n', 'utf8')
    result(session, `${action}-transition-effect-call`, { status: 'completed' })
    await runProducer(session, `${action}-transition-effect`, {
      semantic_action: action, evidence_role: 'effect', resolution_call_id: `${action}-transition-resolution`,
      effect_call_id: `${action}-transition-effect-call`,
    })
    await runProducer(session, `${action}-transition-state`, {
      semantic_action: action, evidence_role: 'state', resolution_call_id: `${action}-transition-resolution`,
      effect_call_id: `${action}-transition-effect-call`,
    })
    const projection = deriveProjection(session.events as never, { activation: 'opt-in' }, { cwd: dir }, true).projection
    const facts = [...projection.evidence.values()].filter((entry) => entry.toolName === 'context_guard_evidence')
    const item = [...projection.items.values()].find((entry) => entry.semanticAction === action)!
    const resolutionFact = facts.find((entry) => entry.evidenceRole === 'resolution')!
    const effectFact = facts.find((entry) => entry.evidenceRole === 'effect')!
    const stateFact = facts.find((entry) => entry.evidenceRole === 'state')!
    const binding = {
      itemId: item.id, evidenceIds: facts.map((entry) => entry.id), semanticAction: action,
      requestedTarget: item.requestedTarget, resolvedTarget: resolutionFact.resolvedTarget,
      observedState: stateFact.observedState, expectedTransition: resolutionFact.expectedTransition,
      resolutionEvidenceId: resolutionFact.id, effectEvidenceId: effectFact.id, stateEvidenceIds: [stateFact.id],
    }
    expect(certifyCheckpoint(projection, [binding], `C-${action}-divergent`).rejectedBindings[0])
      .toMatchObject({ reasonCode: 'expected_transition_mismatch' })
    const observedBackfill = structuredClone(binding)
    observedBackfill.expectedTransition!.parameters = { post_digest: stateFact.observedState!.post_digest }
    expect(certifyCheckpoint(projection, [observedBackfill], `C-${action}-backfill`).rejectedBindings[0])
      .toMatchObject({ reasonCode: 'binding_expected_transition_mismatch' })
  })

  it('rejects a modify resolution when the pinned exact replacement is not unique', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cg-modify-ambiguous-'))
    const artifact = join(dir, 'artifact.txt')
    await writeFile(artifact, 'OLD and OLD\n', 'utf8')
    const session = Session.create(SessionId('producer-modify-ambiguous'), undefined, {
      version: 0, id: SessionId('producer-modify-ambiguous'), createdAt: 1, cwd: dir,
    })
    expect(await runProducer(session, 'modify-ambiguous-resolution', {
      semantic_action: 'modify', evidence_role: 'resolution', selector: { artifact_id: artifact },
      command_manifest: { planned_tool: 'edit', planned_arguments: { file_path: artifact, old_string: 'OLD', new_string: 'NEW' } },
    })).toMatchObject({ status: 'unavailable', reason_code: 'expected_transition_unavailable' })
  })

  it('rejects a modify transition when bytes drift after the frozen pre-digest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cg-modify-pre-drift-'))
    const artifact = join(dir, 'artifact.txt')
    const before = Buffer.from('before OLD after\n', 'utf8')
    await writeFile(artifact, before)
    const frozenPreDigest = createHash('sha256').update(before).digest('hex')
    await writeFile(artifact, 'drifted OLD bytes\n', 'utf8')
    expect(await expectedTransitionForResolution('modify', {
      artifact_id: artifact, scope: dir, pre_digest: frozenPreDigest, change_set_digest: 'planned',
    }, {
      planned_tool: 'edit', planned_arguments: { file_path: artifact, old_string: 'OLD', new_string: 'NEW' },
    })).toBeUndefined()
  })

  it('ignores role metadata forged by a non-Guard tool result', () => {
    const session = Session.create(SessionId('producer-spoof-session'))
    enable(session)
    call(session, 'bash-spoof', 'bash', { command: 'git pull', workdir: '/tmp' })
    result(session, 'bash-spoof', {}, { contextGuard: {
      adapterId: 'context-guard.git.v1', adapterVersion: '1.0.0', semanticAction: 'push', evidenceRole: 'state',
      resolvedTarget: { repository: 'spoof' }, observedState: { remote_oid: 'spoof' },
    } })
    const projection = deriveProjection(session.events as never, { activation: 'opt-in' }, {}, true).projection
    const evidence = [...projection.evidence.values()][0]
    expect(evidence.semanticAction).toBe('pull')
    expect(evidence.evidenceRole).toBe('effect')
    expect(evidence.observedState).toBeUndefined()
  })

  it.each(['install', 'apply'] as const)('%s binds one tgz through precondition, exact DSH argv, profile lock locator, and independent readback', async (action) => {
    const root = await mkdtemp(join(tmpdir(), `dsh-cg-${action}-`))
    const profile = join(root, 'web')
    await mkdir(profile, { recursive: true })
    const name = `fixture-${action}`
    const version = '2.0.0'
    const tgz = await packFixture(root, name, version)
    if (action === 'apply') await writeInstalledPackage(profile, name, '1.0.0', 'sha512-b2xk')
    const session = Session.create(SessionId(`producer-${action}-session`), undefined, {
      version: 0, id: SessionId(`producer-${action}-session`), createdAt: 1, cwd: root,
    })
    enable(session)
    user(session, `${action} package ${name}@${version} in profile web.`)
    let expectedIntegrity = ''
    let mutations = 0
    const roots: EvidenceToolRoots = {
      profile: { name: 'web', path: profile },
      commandRunner: async (file, args) => {
        mutations += 1
        expect([file, ...args]).toEqual(['dsh', 'plugin', '--profile', 'web', 'add', `file:${tgz}`])
        await writeInstalledPackage(profile, name, version, expectedIntegrity, `file:${tgz}`)
      },
    }
    const resolution = await runProducer(session, `${action}-resolution`, {
      semantic_action: action, evidence_role: 'resolution', selector: { package_id: name, version, profile: 'web' },
      command_manifest: { manifest_id: `dsh.plugin_add_tgz.${action}.v1`, tgz_path: tgz },
    }, roots)
    expect(resolution.status).toBe('supported')
    expect(mutations).toBe(0)
    expectedIntegrity = (resolution.resolved_target as Record<string, string>).integrity_digest
    await runAction(session, `${action}-effect`, { semantic_action: action, resolution_call_id: `${action}-resolution` }, roots)
    expect(mutations).toBe(1)
    await runProducer(session, `${action}-effect-fact`, {
      semantic_action: action, evidence_role: 'effect', resolution_call_id: `${action}-resolution`, effect_call_id: `${action}-effect`,
    }, roots)
    await runProducer(session, `${action}-state`, {
      semantic_action: action, evidence_role: 'state', resolution_call_id: `${action}-resolution`, effect_call_id: `${action}-effect`,
    }, roots)
    expect(mutations).toBe(1)
    expect(certifyStateful(session, action).status).toBe('certified')
  })

  it('rejects install-over-existing, apply-over-absent, and apply-without a version/integrity transition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cg-package-precondition-'))
    const profile = join(root, 'web')
    await mkdir(profile, { recursive: true })
    const tgz = await packFixture(root, 'fixture-precondition', '1.0.0')
    const roots = { profile: { name: 'web', path: profile } }
    const args = (action: 'install' | 'apply') => ({
      semantic_action: action, evidence_role: 'resolution', selector: { package_id: 'fixture-precondition', version: '1.0.0', profile: 'web' },
      command_manifest: { manifest_id: `dsh.plugin_add_tgz.${action}.v1`, tgz_path: tgz },
    })
    const absent = Session.create(SessionId('apply-absent'))
    expect(await runProducer(absent, 'apply-absent-call', args('apply'), roots)).toMatchObject({ status: 'unavailable' })
    const identitySession = Session.create(SessionId('install-first'))
    const identity = await runProducer(identitySession, 'identity', args('install'), roots)
    const integrity = (identity.resolved_target as Record<string, string>).integrity_digest
    await writeInstalledPackage(profile, 'fixture-precondition', '1.0.0', integrity)
    const existing = Session.create(SessionId('install-existing'))
    expect(await runProducer(existing, 'install-existing-call', args('install'), roots)).toMatchObject({ status: 'unavailable' })
    const same = Session.create(SessionId('apply-same'))
    expect(await runProducer(same, 'apply-same-call', args('apply'), roots)).toMatchObject({ status: 'unavailable' })
  })

  it('rejects model-selected readback roots and extra canonical target keys', async () => {
    const session = Session.create(SessionId('producer-untrusted-root-session'))
    for (const [action, selector] of [
      ['install', { package_id: 'fixture', profile: 'web', profile_path: '/tmp/attacker' }],
      ['restart', { service_id: 'dsh-web', generation_probe: 'http://attacker.invalid/generation' }],
      ['publish', { artifact_id: 'fixture', version: '1.0.0', registry: 'https://registry.invalid', package_path: '/tmp/attacker' }],
    ] as const) {
      await expect(runProducer(session, `untrusted-${action}`, {
        semantic_action: action, evidence_role: 'resolution', selector, command_manifest: {},
      })).rejects.toThrow(/not a declared property/)
    }
    expect(validateActionTarget('install', {
      package_id: 'fixture', version: '1.0.0', integrity_digest: 'sha512-x', profile: 'web', profile_path: '/tmp/attacker',
    }, { package_id: 'fixture', version: '1.0.0', integrity_digest: 'sha512-x', profile: 'web' })).toBe(false)

    const root = await mkdtemp(join(tmpdir(), 'dsh-cg-command-extra-'))
    const artifact = join(root, 'artifact.txt')
    await expect(runProducer(session, 'extra-command-key', {
      semantic_action: 'create', evidence_role: 'resolution', selector: { artifact_id: artifact },
      command_manifest: { planned_tool: 'write', planned_arguments: { file_path: artifact, content: 'x' }, ignored_branch: 'publish' },
    })).rejects.toThrow(/not a declared property/)
    await expect(runProducer(session, 'extra-command-arg', {
      semantic_action: 'create', evidence_role: 'resolution', selector: { artifact_id: artifact },
      command_manifest: { planned_tool: 'write', planned_arguments: { file_path: artifact, content: 'x', registry: 'https://attacker.invalid' } },
    })).rejects.toThrow(/not a declared property/)
  })

  it('publishes the exact resolved tgz and closes only when registry integrity matches the same bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cg-publish-'))
    const tgz = await packFixture(root, 'fixture-publish', '3.0.0')
    let publishedIntegrity: string | undefined
    const registry = 'https://registry.example.invalid/'
    {
      const session = Session.create(SessionId('producer-publish-session'), undefined, { version: 0, id: SessionId('producer-publish-session'), createdAt: 1, cwd: root })
      enable(session)
      user(session, `Publish package fixture-publish version 3.0.0 to registry ${registry}.`)
      const roots: EvidenceToolRoots = {
        commandRunner: async (file, args) => {
          expect([file, ...args]).toEqual(['npm', 'publish', tgz, '--registry', registry, '--ignore-scripts'])
          publishedIntegrity = (resolution.resolved_target as Record<string, string>).integrity_digest
        },
        fetcher: async (input) => {
          expect(String(input)).toBe(`${registry}fixture-publish`)
          return new Response(JSON.stringify({
            name: 'fixture-publish',
            versions: { '3.0.0': { name: 'fixture-publish', version: '3.0.0', dist: { integrity: publishedIntegrity } } },
          }), { status: publishedIntegrity ? 200 : 404 })
        },
      }
      const resolution = await runProducer(session, 'publish-resolution', {
        semantic_action: 'publish', evidence_role: 'resolution', selector: { artifact_id: 'fixture-publish', version: '3.0.0', registry },
        command_manifest: { manifest_id: 'npm.publish_tgz.v1', tgz_path: tgz },
      }, roots)
      expect(resolution.status).toBe('supported')
      await runAction(session, 'publish-action', { semantic_action: 'publish', resolution_call_id: 'publish-resolution' }, roots)
      await runProducer(session, 'publish-effect', { semantic_action: 'publish', evidence_role: 'effect', resolution_call_id: 'publish-resolution', effect_call_id: 'publish-action' }, roots)
      await runProducer(session, 'publish-state', { semantic_action: 'publish', evidence_role: 'state', resolution_call_id: 'publish-resolution', effect_call_id: 'publish-action' }, roots)
      const certificate = certifyStateful(session, 'publish')
      expect(certificate.rejectedBindings).toEqual([])
      expect(certificate.status).toBe('certified')
    }
  })

  it('fails closed before any mutation when root-contract authorization is absent or denied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cg-action-authority-'))
    const tgz = await packFixture(root, 'fixture-authority', '1.0.0')
    const registry = 'https://registry.example.invalid/'
    const session = Session.create(SessionId('producer-action-authority'), undefined, {
      version: 0, id: SessionId('producer-action-authority'), createdAt: 1, cwd: root,
    })
    enable(session)
    user(session, `Publish package fixture-authority version 1.0.0 registry ${registry}`)
    let commands = 0
    let http = 0
    let intents = 0
    const roots: EvidenceToolRoots = {
      prepareMutation: async () => true,
      commandRunner: async () => { commands += 1 },
      fetcher: async () => { http += 1; return new Response('{}', { status: 500 }) },
      persistRestartIntent: async () => { intents += 1; return true },
    }
    const resolution = await runProducer(session, 'authority-resolution', {
      semantic_action: 'publish', evidence_role: 'resolution',
      selector: { artifact_id: 'fixture-authority', version: '1.0.0', registry },
      command_manifest: { manifest_id: 'npm.publish_tgz.v1', tgz_path: tgz },
    }, roots)
    expect(resolution.status).toBe('supported')
    const args = {
      semantic_action: 'publish', resolution_call_id: 'authority-resolution',
      target_digest: resolution.target_digest, contract_item_id: 'R001', contract_item_revision: 1,
    }
    expect(await createActionTool(roots).execute(args as never, execution(session, 'authority-missing', 'context_guard_action')))
      .toMatchObject({ status: 'unavailable', reason_code: 'mutation_authority_unavailable' })
    for (const reasonCode of [
      'mutation_contract_item_missing', 'mutation_target_clarification_required',
      'mutation_semantic_action_mismatch', 'mutation_requested_target_mismatch',
      'mutation_contract_item_not_pending', 'mutation_legacy_rebind_required',
      'mutation_contract_item_not_authorizing',
    ]) {
      const tool = createActionTool({ ...roots, authorizeMutation: () => ({ status: 'denied', reasonCode }) })
      expect(await tool.execute(args as never, execution(session, `authority-${reasonCode}`, 'context_guard_action')))
        .toMatchObject({ status: 'unavailable', reason_code: reasonCode })
    }
    expect({ commands, http, intents }).toEqual({ commands: 0, http: 0, intents: 0 })
  })

  it('requires a durable prepare before probes and binds each contract item to this resolution target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cg-action-swap-'))
    const registry = 'https://registry.example.invalid/'
    const tgzA = await packFixture(root, 'fixture-a', '1.0.0')
    const tgzB = await packFixture(root, 'fixture-b', '1.0.0')
    const session = Session.create(SessionId('producer-action-swap'), undefined, {
      version: 0, id: SessionId('producer-action-swap'), createdAt: 1, cwd: root,
    })
    enable(session)
    user(session, `Publish package fixture-a version 1.0.0 registry ${registry}`)
    user(session, `Publish package fixture-b version 1.0.0 registry ${registry}`)
    const executableIdentity = { executable: 'npm' as const, realpath: '/fixture/bin/npm', version: '10.0.0' }
    const producerRoots: EvidenceToolRoots = { readExecutableIdentity: async () => executableIdentity }
    const resolutionA = await runProducer(session, 'resolution-a', {
      semantic_action: 'publish', evidence_role: 'resolution',
      selector: { artifact_id: 'fixture-a', version: '1.0.0', registry },
      command_manifest: { manifest_id: 'npm.publish_tgz.v1', tgz_path: tgzA },
    }, producerRoots)
    const resolutionB = await runProducer(session, 'resolution-b', {
      semantic_action: 'publish', evidence_role: 'resolution',
      selector: { artifact_id: 'fixture-b', version: '1.0.0', registry },
      command_manifest: { manifest_id: 'npm.publish_tgz.v1', tgz_path: tgzB },
    }, producerRoots)
    expect(resolutionA.status).toBe('supported')
    expect(resolutionB.status).toBe('supported')

    const projection = deriveProjection(session.events as never, { activation: 'opt-in' }, { cwd: root }, true).projection
    const itemA = [...projection.items.values()].find((item) => item.requestedTarget?.artifact_id === 'fixture-a')!
    const itemB = [...projection.items.values()].find((item) => item.requestedTarget?.artifact_id === 'fixture-b')!
    expect(itemA.targetCaptureStatus).toBe('resolved')
    expect(itemB.targetCaptureStatus).toBe('resolved')

    let prepares = 0
    let probes = 0
    let commands = 0
    let http = 0
    let intents = 0
    const roots: EvidenceToolRoots = {
      prepareMutation: async () => { prepares += 1; return true },
      authorizeMutation: (request) => authorizeMutationFromProjection(projection, request),
      readExecutableIdentity: async () => { probes += 1; return executableIdentity },
      commandRunner: async () => { commands += 1 },
      fetcher: async () => { http += 1; return new Response('{}', { status: 500 }) },
      persistRestartIntent: async () => { intents += 1; return true },
    }
    const swap = await runAction(session, 'action-swap', {
      semantic_action: 'publish', resolution_call_id: 'resolution-b',
      target_digest: resolutionB.target_digest,
      contract_item_id: itemA.id, contract_item_revision: itemA.revision,
    }, roots)
    expect(swap).toMatchObject({ status: 'unavailable', reason_code: 'mutation_requested_target_mismatch' })
    expect({ prepares, probes, commands, http, intents }).toEqual({ prepares: 1, probes: 0, commands: 0, http: 0, intents: 0 })

    const exact = await runAction(session, 'action-exact', {
      semantic_action: 'publish', resolution_call_id: 'resolution-a',
      target_digest: resolutionA.target_digest,
      contract_item_id: itemA.id, contract_item_revision: itemA.revision,
    }, roots)
    expect(exact).toMatchObject({ status: 'completed', reason_code: 'action_completed' })
    expect({ prepares, probes, commands, http, intents }).toEqual({ prepares: 2, probes: 1, commands: 1, http: 0, intents: 0 })
  })

  it('fails closed on missing, false, or throwing mutation durability before every probe and effect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cg-action-durable-'))
    const registry = 'https://registry.example.invalid/'
    const tgz = await packFixture(root, 'fixture-durable', '1.0.0')
    const session = Session.create(SessionId('producer-action-durable'), undefined, {
      version: 0, id: SessionId('producer-action-durable'), createdAt: 1, cwd: root,
    })
    enable(session)
    user(session, `Publish package fixture-durable version 1.0.0 registry ${registry}`)
    const executableIdentity = { executable: 'npm' as const, realpath: '/fixture/bin/npm', version: '10.0.0' }
    const resolution = await runProducer(session, 'durable-resolution', {
      semantic_action: 'publish', evidence_role: 'resolution',
      selector: { artifact_id: 'fixture-durable', version: '1.0.0', registry },
      command_manifest: { manifest_id: 'npm.publish_tgz.v1', tgz_path: tgz },
    }, { readExecutableIdentity: async () => executableIdentity })
    const args = {
      semantic_action: 'publish', resolution_call_id: 'durable-resolution', target_digest: resolution.target_digest,
      contract_item_id: 'R001', contract_item_revision: 1,
    }
    for (const prepareMutation of [undefined, async () => false, async () => { throw new Error('flush failed') }]) {
      let probes = 0
      let commands = 0
      let http = 0
      let intents = 0
      const tool = createActionTool({
        ...(prepareMutation ? { prepareMutation } : {}),
        authorizeMutation: () => ({ status: 'authorized', reasonCode: 'test_root_contract_authorized' }),
        readExecutableIdentity: async () => { probes += 1; return executableIdentity },
        commandRunner: async () => { commands += 1 },
        fetcher: async () => { http += 1; return new Response('{}', { status: 500 }) },
        persistRestartIntent: async () => { intents += 1; return true },
      })
      expect(await tool.execute(args as never, execution(session, 'durability-action', 'context_guard_action')))
        .toMatchObject({ status: 'unavailable', reason_code: 'mutation_durability_unavailable' })
      expect({ probes, commands, http, intents }).toEqual({ probes: 0, commands: 0, http: 0, intents: 0 })
    }
  })

  it('rejects same-target prohibitions in either order and permits an unrelated target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cg-action-prohibition-'))
    const registry = 'https://registry.example.invalid/'
    const executableIdentity = { executable: 'npm' as const, realpath: '/fixture/bin/npm', version: '10.0.0' }
    for (const [label, messages, expected] of [
      ['requirement-then-prohibition', [
        `Publish package fixture-blocked version 1.0.0 registry ${registry}`,
        `Do not publish package fixture-blocked version 1.0.0 registry ${registry}`,
      ], 'mutation_conflicting_prohibition'],
      ['prohibition-then-requirement', [
        `Do not publish package fixture-blocked version 1.0.0 registry ${registry}`,
        `Publish package fixture-blocked version 1.0.0 registry ${registry}`,
      ], 'mutation_conflicting_prohibition'],
      ['unrelated-prohibition', [
        `Publish package fixture-allowed version 1.0.0 registry ${registry}`,
        `Do not publish package fixture-other version 1.0.0 registry ${registry}`,
      ], 'action_completed'],
    ] as const) {
      const tgz = await packFixture(root, label === 'unrelated-prohibition' ? 'fixture-allowed' : 'fixture-blocked', '1.0.0')
      const session = Session.create(SessionId(`producer-${label}`), undefined, {
        version: 0, id: SessionId(`producer-${label}`), createdAt: 1, cwd: root,
      })
      enable(session)
      for (const message of messages) user(session, message)
      const artifactId = label === 'unrelated-prohibition' ? 'fixture-allowed' : 'fixture-blocked'
      const resolution = await runProducer(session, `${label}-resolution`, {
        semantic_action: 'publish', evidence_role: 'resolution',
        selector: { artifact_id: artifactId, version: '1.0.0', registry },
        command_manifest: { manifest_id: 'npm.publish_tgz.v1', tgz_path: tgz },
      }, { readExecutableIdentity: async () => executableIdentity })
      const projection = deriveProjection(session.events as never, { activation: 'opt-in' }, { cwd: root }, true).projection
      const requirement = [...projection.items.values()].find((item) => item.kind === 'requirement' && item.requestedTarget?.artifact_id === artifactId)!
      let probes = 0
      let commands = 0
      let http = 0
      let intents = 0
      const value = await runAction(session, `${label}-action`, {
        semantic_action: 'publish', resolution_call_id: `${label}-resolution`, target_digest: resolution.target_digest,
        contract_item_id: requirement.id, contract_item_revision: requirement.revision,
      }, {
        prepareMutation: async () => true,
        authorizeMutation: (request) => authorizeMutationFromProjection(projection, request),
        readExecutableIdentity: async () => { probes += 1; return executableIdentity },
        commandRunner: async () => { commands += 1 },
        fetcher: async () => { http += 1; return new Response('{}', { status: 500 }) },
        persistRestartIntent: async () => { intents += 1; return true },
      })
      expect(value.reason_code).toBe(expected)
      expect({ probes, commands, http, intents }).toEqual(expected === 'action_completed'
        ? { probes: 1, commands: 1, http: 0, intents: 0 }
        : { probes: 0, commands: 0, http: 0, intents: 0 })
    }
  })

  it('rejects a partial captured target at mutation authorization before every probe and effect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cg-action-partial-'))
    const registry = 'https://registry.example.invalid/'
    const tgz = await packFixture(root, 'fixture-partial', '1.0.0')
    const session = Session.create(SessionId('producer-action-partial'), undefined, {
      version: 0, id: SessionId('producer-action-partial'), createdAt: 1, cwd: root,
    })
    enable(session)
    user(session, `Publish package fixture-partial registry ${registry}`)
    const executableIdentity = { executable: 'npm' as const, realpath: '/fixture/bin/npm', version: '10.0.0' }
    const resolution = await runProducer(session, 'partial-resolution', {
      semantic_action: 'publish', evidence_role: 'resolution',
      selector: { artifact_id: 'fixture-partial', version: '1.0.0', registry },
      command_manifest: { manifest_id: 'npm.publish_tgz.v1', tgz_path: tgz },
    }, { readExecutableIdentity: async () => executableIdentity })
    const projection = deriveProjection(session.events as never, { activation: 'opt-in' }, { cwd: root }, true).projection
    const item = [...projection.items.values()].find((candidate) => candidate.requestedTarget?.artifact_id === 'fixture-partial')!
    expect(item).toMatchObject({ targetCaptureStatus: 'resolved', requestedTarget: { artifact_id: 'fixture-partial', registry } })
    let probes = 0
    let commands = 0
    let http = 0
    let intents = 0
    const value = await runAction(session, 'partial-action', {
      semantic_action: 'publish', resolution_call_id: 'partial-resolution', target_digest: resolution.target_digest,
      contract_item_id: item.id, contract_item_revision: item.revision,
    }, {
      prepareMutation: async () => true,
      authorizeMutation: (request) => authorizeMutationFromProjection(projection, request),
      readExecutableIdentity: async () => { probes += 1; return executableIdentity },
      commandRunner: async () => { commands += 1 },
      fetcher: async () => { http += 1; return new Response('{}', { status: 500 }) },
      persistRestartIntent: async () => { intents += 1; return true },
    })
    expect(value).toMatchObject({ status: 'unavailable', reason_code: 'mutation_requested_target_mismatch' })
    expect({ probes, commands, http, intents }).toEqual({ probes: 0, commands: 0, http: 0, intents: 0 })
  })

  it('uses the pinned dshmarket capability, same-origin restart POST, and changed bootId readback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cg-restart-'))
    const profile = join(root, 'web')
    await mkdir(profile, { recursive: true })
    await writeInstalledPackage(profile, 'dshmarket', '1.36.0', 'sha512-xX8CCoXdIALaxtLosj+5qGg8r1cykW2zo1AOPJcSQepg2r4Vd2K0NmERldDqfeyFV0pCuZsUoAPe1Q/BW7De/g==', '1.36.0')
    let bootId = 'boot-before'
    const origin = 'http://127.0.0.1:3080'
    {
      let session!: Session
      const roots: EvidenceToolRoots = {
        profile: { name: 'web', path: profile }, marketOrigin: origin,
        persistRestartIntent: async (agent, intent) => {
          ;(agent.session as unknown as Session).append('user/message', createUserMessage({
            content: [{ type: 'text', text: `${RESTART_INTENT_PREFIX}${JSON.stringify({ resolution_call_id: intent.resolutionCallId, service_id: intent.serviceId, pre_generation: intent.preGeneration })}` }],
            source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'restart intent' },
          }), { surfaceOp: 'append' })
          return true
        },
        fetcher: async (input, init) => {
          const url = String(input)
          if (url.endsWith('/capabilities') && (!init?.method || init.method === 'GET')) {
            return new Response(JSON.stringify({ schema: 'dsh-market/update-api/v1', apiVersion: 1, marketVersion: '1.36.0', profile: 'web', bootId, features: { restart: true }, restart: { supported: true, managedBy: 'market' } }), { status: 200 })
          }
          expect(url).toBe(`${origin}/dsh-market/api/v1/restart`)
          expect(init?.method).toBe('POST')
          expect(new Headers(init?.headers).get('origin')).toBe(origin)
          bootId = 'boot-after'
          return new Response(JSON.stringify({ schema: 'dsh-market/update-api/v1', result: { accepted: true } }), { status: 200 })
        },
      }
      session = Session.create(SessionId('producer-restart-session'), undefined, { version: 0, id: SessionId('producer-restart-session'), createdAt: 1, cwd: root })
      enable(session)
      user(session, 'Restart service dsh-web.')
      await runProducer(session, 'restart-resolution', { semantic_action: 'restart', evidence_role: 'resolution', selector: { service_id: 'dsh-web' }, command_manifest: { manifest_id: 'dshmarket.restart.v1' } }, roots)
      const handoff = await runAction(session, 'restart-action', { semantic_action: 'restart', resolution_call_id: 'restart-resolution' }, roots)
      expect(handoff.status).toBe('handoff_pending')
      const killedBeforeResult = structuredClone(session.events).filter((event) => {
        if ((event as { type?: unknown }).type !== 'tool/result') return true
        const message = ((event as { data?: { message?: unknown } }).data?.message ?? {}) as { source?: { callId?: unknown } }
        return message.source?.callId !== 'restart-action'
      })
      const restored = Session.fromRestore(SessionId('producer-restart-session'), killedBeforeResult as never, structuredClone(session.header) as never)
      await runProducer(restored, 'restart-effect', { semantic_action: 'restart', evidence_role: 'effect', resolution_call_id: 'restart-resolution', effect_call_id: 'restart-action' }, roots)
      await runProducer(restored, 'restart-state', { semantic_action: 'restart', evidence_role: 'state', resolution_call_id: 'restart-resolution', effect_call_id: 'restart-action' }, roots)
      expect(certifyStateful(restored, 'restart').status).toBe('certified')
    }
  })

  it('binds a git effect to the exact planned remote/refspec and rejects target exchange', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cg-git-effect-'))
    const repository = join(root, 'work')
    const remote = join(root, 'origin.git')
    await execFileAsync('git', ['init', '--bare', remote])
    await execFileAsync('git', ['init', '-b', 'main', repository])
    await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: repository })
    await execFileAsync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository })
    await writeFile(join(repository, 'a.txt'), 'a\n')
    await execFileAsync('git', ['add', 'a.txt'], { cwd: repository })
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repository })
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: repository })
    await execFileAsync('git', ['push', '-u', 'origin', 'main'], { cwd: repository })

    const session = Session.create(SessionId('producer-git-target-session'), undefined, {
      version: 0, id: SessionId('producer-git-target-session'), createdAt: 1, cwd: repository,
    })
    enable(session)
    await writeFile(join(repository, 'a.txt'), 'a\nb\n')
    await execFileAsync('git', ['add', 'a.txt'], { cwd: repository })
    await execFileAsync('git', ['commit', '-m', 'second'], { cwd: repository })
    const fullRefspec = 'refs/heads/main:refs/heads/main'
    const goodArgs = { command: `git push origin ${fullRefspec}`, workdir: repository }
    const resolution = await runProducer(session, 'git-resolution', {
      semantic_action: 'push', evidence_role: 'resolution', selector: {
        repository, remote: 'origin', refspec: fullRefspec,
      },
      command_manifest: { planned_tool: 'bash', planned_arguments: goodArgs },
    })
    expect(resolution.status).toBe('supported')

    call(session, 'swapped-push', 'context_guard_action', {
      semantic_action: 'push', resolution_call_id: 'git-resolution', target_digest: '0'.repeat(64),
    })
    result(session, 'swapped-push', { status: 'completed' })
    const swapped = await runProducer(session, 'git-effect-swapped', {
      semantic_action: 'push', evidence_role: 'effect', resolution_call_id: 'git-resolution', effect_call_id: 'swapped-push',
    })
    expect(swapped).toMatchObject({ status: 'unavailable', reason_code: 'persisted_effect_mismatch' })
    expect(await runAction(session, 'git-action-wrong-target', {
      semantic_action: 'push', resolution_call_id: 'git-resolution', target_digest: '0'.repeat(64),
    })).toMatchObject({ status: 'unavailable', reason_code: 'target_digest_mismatch' })

    const fakeBin = join(root, 'fake-bin')
    await mkdir(fakeBin)
    const fakeGit = join(fakeBin, process.platform === 'win32' ? 'git.cmd' : 'git')
    await writeFile(fakeGit, process.platform === 'win32'
      ? '@echo off\r\necho git version 2.50.1\r\n'
      : '#!/bin/sh\necho "git version 2.50.1"\n')
    if (process.platform !== 'win32') await chmod(fakeGit, 0o755)
    const originalPath = process.env.PATH
    process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ''}`
    try {
      expect(await runAction(session, 'git-action-executable-swap', { semantic_action: 'push', resolution_call_id: 'git-resolution' })).toMatchObject({
        status: 'unavailable', reason_code: 'executable_identity_drift',
      })
    } finally {
      process.env.PATH = originalPath
    }

    const completed = await runAction(session, 'git-action', { semantic_action: 'push', resolution_call_id: 'git-resolution' })
    expect(completed).toMatchObject({ status: 'completed', resolved_target: { remote: 'origin', refspec: fullRefspec } })
    expect(completed.target_digest).toBe(resolution.target_digest)
    expect(completed.command_manifest_digest).toBe(resolution.command_manifest_digest)
    expect(await runProducer(session, 'git-effect', {
      semantic_action: 'push', evidence_role: 'effect', resolution_call_id: 'git-resolution', effect_call_id: 'git-action',
    })).toMatchObject({ status: 'supported', evidence_role: 'effect' })
    expect(await runProducer(session, 'git-state', {
      semantic_action: 'push', evidence_role: 'state', resolution_call_id: 'git-resolution', effect_call_id: 'git-action',
    })).toMatchObject({ status: 'supported', observed_state: { remote_oid: (resolution.resolved_target as Record<string, string>).local_oid } })

    const inconsistentPlan = await runProducer(session, 'git-resolution-inconsistent', {
      semantic_action: 'push', evidence_role: 'resolution', selector: {
        repository, remote: 'origin', refspec: fullRefspec,
      },
      command_manifest: { planned_tool: 'bash', planned_arguments: { command: `git push --force origin ${fullRefspec}`, workdir: repository } },
    })
    expect(inconsistentPlan).toMatchObject({ status: 'unavailable', reason_code: 'resolution_unavailable' })
    const selectiveCapability: EvidenceToolRoots = {
      hostCapability: (action) => ({ status: action === 'push' ? 'unavailable' : 'supported', digest: action }),
    }
    expect(await runProducer(session, 'push-capability-missing', {
      semantic_action: 'push', evidence_role: 'resolution', selector: { repository, remote: 'origin', refspec: fullRefspec },
      command_manifest: { planned_tool: 'bash', planned_arguments: goodArgs },
    }, selectiveCapability)).toMatchObject({ status: 'unavailable', reason_code: 'host_capability_unavailable' })
    const capabilityArtifact = join(root, 'capability-artifact.txt')
    expect(await runProducer(session, 'create-capability-still-present', {
      semantic_action: 'create', evidence_role: 'resolution', selector: { artifact_id: capabilityArtifact },
      command_manifest: { planned_tool: 'write', planned_arguments: { file_path: capabilityArtifact, content: 'ok' } },
    }, selectiveCapability)).toMatchObject({ status: 'supported' })

    await writeFile(join(repository, 'a.txt'), 'a\nb\nc\n')
    await execFileAsync('git', ['add', 'a.txt'], { cwd: repository })
    await execFileAsync('git', ['commit', '-m', 'third'], { cwd: repository })
    const drifted = await runAction(session, 'git-action-drifted', { semantic_action: 'push', resolution_call_id: 'git-resolution' })
    expect(drifted).toMatchObject({ status: 'unavailable', reason_code: 'action_execution_failed' })
  })

  it('executes and independently reads back exact commit, push, fetch, and pull in real repositories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cg-git-roundtrip-'))
    const remote = join(root, 'origin.git')
    const work = join(root, 'work')
    const upstream = join(root, 'upstream')
    await execFileAsync('git', ['init', '--bare', remote])
    await execFileAsync('git', ['clone', remote, work])
    await execFileAsync('git', ['-C', work, 'switch', '-c', 'main'])
    for (const repository of [work]) {
      await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: repository })
      await execFileAsync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository })
    }
    await writeFile(join(work, 'a.txt'), 'initial\n')
    await execFileAsync('git', ['add', 'a.txt'], { cwd: work })
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: work })
    await execFileAsync('git', ['push', '-u', 'origin', 'main'], { cwd: work })

    const session = Session.create(SessionId('producer-git-roundtrip'), undefined, {
      version: 0, id: SessionId('producer-git-roundtrip'), createdAt: 1, cwd: work,
    })
    enable(session)
    await writeFile(join(work, 'b.txt'), 'guarded\n')
    await execFileAsync('git', ['add', 'b.txt'], { cwd: work })
    const commitResolution = await runProducer(session, 'commit-resolution', {
      semantic_action: 'commit', evidence_role: 'resolution', selector: { repository: work, branch: 'main' },
      command_manifest: { planned_tool: 'bash', planned_arguments: { command: 'git commit -m guarded', workdir: work } },
    })
    expect(commitResolution.status).toBe('supported')
    const commitPreHead = (commitResolution.resolved_target as Record<string, string>).pre_head_oid
    expect(await runAction(session, 'commit-action', { semantic_action: 'commit', resolution_call_id: 'commit-resolution' })).toMatchObject({ status: 'completed' })
    expect(await runProducer(session, 'commit-effect', { semantic_action: 'commit', evidence_role: 'effect', resolution_call_id: 'commit-resolution', effect_call_id: 'commit-action' })).toMatchObject({ status: 'supported' })
    expect(await runProducer(session, 'commit-state', { semantic_action: 'commit', evidence_role: 'state', resolution_call_id: 'commit-resolution', effect_call_id: 'commit-action' })).toMatchObject({
      status: 'supported',
      observed_state: { pre_head_oid: commitPreHead, post_head_oid: expect.any(String) },
    })

    const refspec = 'refs/heads/main:refs/heads/main'
    const pushResolution = await runProducer(session, 'push-resolution', {
      semantic_action: 'push', evidence_role: 'resolution', selector: { repository: work, remote: 'origin', refspec },
      command_manifest: { planned_tool: 'bash', planned_arguments: { command: `git push origin ${refspec}`, workdir: work } },
    })
    expect(await runAction(session, 'push-action', { semantic_action: 'push', resolution_call_id: 'push-resolution' })).toMatchObject({ status: 'completed' })
    expect(await runProducer(session, 'push-state', { semantic_action: 'push', evidence_role: 'state', resolution_call_id: 'push-resolution', effect_call_id: 'push-action' })).toMatchObject({
      status: 'supported', observed_state: { remote_oid: (pushResolution.resolved_target as Record<string, string>).local_oid },
    })

    await execFileAsync('git', ['clone', '--branch', 'main', remote, upstream])
    await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: upstream })
    await execFileAsync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: upstream })
    await writeFile(join(upstream, 'remote.txt'), 'one\n')
    await execFileAsync('git', ['add', 'remote.txt'], { cwd: upstream })
    await execFileAsync('git', ['commit', '-m', 'remote-one'], { cwd: upstream })
    await execFileAsync('git', ['push', 'origin', 'main'], { cwd: upstream })

    const fetchRefspec = 'refs/heads/main:refs/remotes/origin/main'
    const fetchResolution = await runProducer(session, 'fetch-resolution', {
      semantic_action: 'fetch', evidence_role: 'resolution', selector: { repository: work, remote: 'origin', refspec: fetchRefspec },
      command_manifest: { planned_tool: 'bash', planned_arguments: { command: `git fetch --no-tags origin ${fetchRefspec}`, workdir: work } },
    })
    const fetchPreHead = (fetchResolution.resolved_target as Record<string, string>).pre_head_oid
    expect(fetchPreHead).toMatch(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/)
    expect(await runAction(session, 'fetch-action', { semantic_action: 'fetch', resolution_call_id: 'fetch-resolution' })).toMatchObject({ status: 'completed' })
    expect(await runProducer(session, 'fetch-state', { semantic_action: 'fetch', evidence_role: 'state', resolution_call_id: 'fetch-resolution', effect_call_id: 'fetch-action' })).toMatchObject({
      status: 'supported', observed_state: { post_head_oid: fetchPreHead },
    })

    await writeFile(join(upstream, 'remote.txt'), 'two\n')
    await execFileAsync('git', ['add', 'remote.txt'], { cwd: upstream })
    await execFileAsync('git', ['commit', '-m', 'remote-two'], { cwd: upstream })
    await execFileAsync('git', ['push', 'origin', 'main'], { cwd: upstream })
    const pullRef = 'refs/heads/main'
    await runProducer(session, 'pull-resolution', {
      semantic_action: 'pull', evidence_role: 'resolution', selector: { repository: work, remote: 'origin', refspec: pullRef },
      command_manifest: { planned_tool: 'bash', planned_arguments: { command: `git pull --ff-only --no-tags origin ${pullRef}`, workdir: work } },
    })
    expect(await runAction(session, 'pull-action', { semantic_action: 'pull', resolution_call_id: 'pull-resolution' })).toMatchObject({ status: 'completed' })
    expect(await runProducer(session, 'pull-state', { semantic_action: 'pull', evidence_role: 'state', resolution_call_id: 'pull-resolution', effect_call_id: 'pull-action' })).toMatchObject({ status: 'supported' })

    await writeFile(join(work, 'drift.txt'), 'before\n')
    await execFileAsync('git', ['add', 'drift.txt'], { cwd: work })
    await runProducer(session, 'commit-drift-resolution', {
      semantic_action: 'commit', evidence_role: 'resolution', selector: { repository: work, branch: 'main' },
      command_manifest: { planned_tool: 'bash', planned_arguments: { command: 'git commit -m drift', workdir: work } },
    })
    await writeFile(join(work, 'drift.txt'), 'after\n')
    await execFileAsync('git', ['add', 'drift.txt'], { cwd: work })
    expect(await runAction(session, 'commit-drift-action', { semantic_action: 'commit', resolution_call_id: 'commit-drift-resolution' })).toMatchObject({ status: 'unavailable' })

    const fetchDriftResolution = await runProducer(session, 'fetch-head-drift-resolution', {
      semantic_action: 'fetch', evidence_role: 'resolution', selector: { repository: work, remote: 'origin', refspec: fetchRefspec },
      command_manifest: { planned_tool: 'bash', planned_arguments: { command: `git fetch --no-tags origin ${fetchRefspec}`, workdir: work } },
    })
    expect(fetchDriftResolution).toMatchObject({ status: 'supported' })
    await execFileAsync('git', ['commit', '-m', 'move-head-after-fetch-resolution'], { cwd: work })
    expect(await runAction(session, 'fetch-head-drift-action', {
      semantic_action: 'fetch', resolution_call_id: 'fetch-head-drift-resolution',
    })).toMatchObject({ status: 'unavailable', reason_code: 'action_execution_failed' })

    expect(await runProducer(session, 'git-cross-branch-key', {
      semantic_action: 'push', evidence_role: 'resolution', selector: { repository: work, remote: 'origin', refspec },
      command_manifest: { planned_tool: 'bash', planned_arguments: { command: `git push origin ${refspec}`, workdir: work }, tgz_path: '/tmp/forbidden.tgz' },
    })).toMatchObject({ status: 'unavailable', reason_code: 'resolution_unavailable' })
  }, GIT_ROUNDTRIP_TIMEOUT_MS)
})
