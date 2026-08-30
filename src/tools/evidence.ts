import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, existsSync, readFileSync } from 'node:fs'
import { access, readFile, realpath } from 'node:fs/promises'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { ACTION_MANIFEST, type StatefulAction } from '../domain/protocol-manifest.js'
import { canonicalRegistryBase, npmEscapedPackageName } from '../domain/registry.js'
import type { EvidenceRole, ExpectedTransition, TargetTuple } from '../domain/types.js'
import { evidenceFromPersistedToolResult, extractTextContent } from '../domain/evidence.js'
import {
  commitIndexSnapshotDigest,
  commitTreeSnapshotDigest,
  createGitPrestateEnvelope,
  executeRevalidatedGitEffect,
  gitCommandMatchesTarget,
  parseGitCommandManifest,
  verifiedLinearCommitReadback,
  type GitCommandManifest,
  type GitPrestateEnvelope,
  type GitTargetIdentity,
} from '../domain/git-adapter.js'
import { bindExecutableIdentity, type AuditedExecutable, type ExecutableIdentity } from '../domain/host-lock.js'

const execFileAsync = promisify(execFile)
const PRODUCER_VERSION = '1.0.0'
const PRODUCER_TOOL = 'context_guard_evidence'
const ACTION_TOOL = 'context_guard_action'
const SUPPORTED: readonly StatefulAction[] = ['install', 'apply', 'create', 'modify', 'restart', 'commit', 'push', 'publish', 'pull', 'fetch']

type RecordValue = Record<string, unknown>
type FrozenExpectedTransition = ExpectedTransition & { parameters: TargetTuple }
interface JsonExpectedTransition {
  predicateId: string
  version: number
  predParamsKind: 'inline'
  parameters: Record<string, JsonValue>
}

export interface EvidenceToolRoots {
  /** Test/embedding override. Production derives the active profile from this installed module. */
  profile?: { name: string; path: string }
  /** Derived from the live loopback webServer service; never accepted from tool input. */
  marketOrigin?: string
  /** Test seam for exact HTTP request/response contracts. */
  fetcher?: typeof fetch
  /** Test seam for exact logical executable/argv execution. */
  commandRunner?: (file: string, args: string[], cwd?: string, signal?: AbortSignal) => Promise<void>
  persistRestartIntent?: (
    agent: { session: { events: readonly unknown[] } },
    intent: { resolutionCallId: string; serviceId: string; preGeneration: string },
  ) => Promise<boolean>
  /** Runtime-supplied, action-scoped host capability decision. */
  hostCapability?: (action: StatefulAction) => { status: 'supported' | 'unsupported' | 'unavailable'; digest: string }
  /** Runtime-owned root-contract authorization. Absence is fail-closed. */
  authorizeMutation?: (request: MutationAuthorizationRequest) => MutationAuthorizationDecision
  /** Flush and replay the resolution/contract chain before any side effect. */
  prepareMutation?: (agent: { session: { events: readonly unknown[] } }) => Promise<boolean>
  /** Test seam for proving that durability/authority rejection precedes probes. */
  readExecutableIdentity?: (executable: AuditedExecutable, signal: AbortSignal) => Promise<ExecutableIdentity | undefined>
  /** Test-only seam; production never enables HTTP registries. */
  allowLoopbackHttpRegistry?: boolean
}

export interface MutationAuthorizationRequest {
  action: StatefulAction
  contractItemId: string
  contractItemRevision: number
  resolvedTarget: TargetTuple
}

export interface MutationAuthorizationDecision {
  status: 'authorized' | 'denied'
  reasonCode: string
}

export const RESTART_INTENT_PREFIX = 'Context Guard restart intent v1: '

function restartIntent(events: readonly unknown[], resolutionCallId: string, target: TargetTuple): boolean {
  for (const raw of events) {
    const event = record(raw)
    if (!event || event.type !== 'user/message') continue
    const data = record(event.data)
    const source = record(data?.source)
    if (source?.kind !== 'plugin' || source.plugin !== 'context-guard' || source.form !== 'notice') continue
    const content = Array.isArray(data?.content) ? data.content : []
    const block = content.length === 1 ? record(content[0]) : undefined
    const text = typeof block?.text === 'string' ? block.text : ''
    if (!text.startsWith(RESTART_INTENT_PREFIX)) continue
    try {
      const value = record(JSON.parse(text.slice(RESTART_INTENT_PREFIX.length)))
      if (value?.resolution_call_id === resolutionCallId && value.service_id === target.service_id
        && value.pre_generation === target.pre_generation) return true
    } catch { /* malformed notices are ignored */ }
  }
  return false
}

function installedProfile(moduleUrl: string = import.meta.url): { name: string; path: string } | undefined {
  let directory = dirname(fileURLToPath(moduleUrl))
  while (true) {
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RecordValue
        if (manifest.name === 'dsh-completion-guard') {
          const modules = dirname(directory)
          if (basename(modules) !== 'node_modules') return undefined
          const profilePath = dirname(modules)
          return { name: basename(profilePath), path: profilePath }
        }
      } catch { return undefined }
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

interface ProducerValue {
  status: 'supported' | 'unavailable'
  reason_code: string
  semantic_action: StatefulAction
  evidence_role: EvidenceRole
  resolved_target: Record<string, JsonValue>
  observed_state: Record<string, JsonValue>
  adapter_id: string
  adapter_version: string
  target_digest: string
  command_manifest_digest: string
  expected_transition?: JsonExpectedTransition
  expected_transition_digest?: string
  git_binding?: Record<string, JsonValue>
  executable_identity?: ExecutableIdentity
}

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' ? value as RecordValue : undefined
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as RecordValue).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(',')}}`
  return JSON.stringify(value)
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex')
}

function jsonTuple(tuple: TargetTuple | undefined): Record<string, JsonValue> {
  if (!tuple) return {}
  return Object.fromEntries(Object.entries(tuple).map(([key, value]) => [key, value as JsonValue]))
}

function jsonExpectedTransition(transition: FrozenExpectedTransition): JsonExpectedTransition {
  return {
    predicateId: transition.predicateId,
    version: transition.version,
    predParamsKind: transition.predParamsKind,
    parameters: jsonTuple(transition.parameters),
  }
}

function tuple(value: unknown): TargetTuple | undefined {
  const row = record(value)
  return row as TargetTuple | undefined
}

function adapterId(action: StatefulAction): string {
  if (['create', 'modify'].includes(action)) return 'context-guard.artifact.v1'
  if (['install', 'apply'].includes(action)) return 'context-guard.package.v1'
  if (action === 'restart') return 'context-guard.service.v1'
  if (action === 'publish') return 'context-guard.registry.v1'
  return 'context-guard.git.v1'
}

function unavailable(action: StatefulAction, role: EvidenceRole, reason: string): ProducerValue {
  return {
    status: 'unavailable', reason_code: reason, semantic_action: action, evidence_role: role,
    resolved_target: {}, observed_state: {}, adapter_id: adapterId(action), adapter_version: PRODUCER_VERSION,
    target_digest: '', command_manifest_digest: '',
  }
}

function supported(
  action: StatefulAction,
  role: EvidenceRole,
  resolved: TargetTuple,
  observed: TargetTuple = {},
  commandManifest: unknown = {},
  gitBinding?: Record<string, JsonValue>,
  executable?: ExecutableIdentity,
  expectedTransition?: FrozenExpectedTransition,
): ProducerValue {
  return {
    status: 'supported', reason_code: 'producer_observation_supported', semantic_action: action, evidence_role: role,
    resolved_target: jsonTuple(resolved), observed_state: jsonTuple(observed),
    adapter_id: adapterId(action), adapter_version: PRODUCER_VERSION,
    target_digest: digest(resolved), command_manifest_digest: digest(commandManifest),
    ...(gitBinding ? { git_binding: gitBinding } : {}),
    ...(executable ? { executable_identity: executable } : {}),
    ...(expectedTransition ? (() => {
      const frozen = jsonExpectedTransition(expectedTransition)
      return { expected_transition: frozen, expected_transition_digest: digest(frozen) }
    })() : {}),
  }
}

export function evidenceTargetDigest(target: TargetTuple): string {
  return digest(target)
}

function messageMeta(event: RecordValue): RecordValue | undefined {
  const data = record(event.data)
  return record(data?.meta)
}

function producerMeta(event: RecordValue): RecordValue | undefined {
  const outer = messageMeta(event)
  return record(outer?.contextGuard)
}

function eventCallId(event: RecordValue): string | undefined {
  const data = record(event.data)
  if (event.type === 'tool/call') return typeof data?.callId === 'string' ? data.callId : undefined
  const message = record(data?.message)
  const source = record(message?.source)
  return typeof source?.callId === 'string' ? source.callId : undefined
}

interface PersistedResolution {
  target: TargetTuple
  selector: RecordValue
  commandManifest: RecordValue
  gitBinding?: { manifest: GitCommandManifest; prestate: Record<string, string>; envelope: GitPrestateEnvelope }
  executableIdentity?: ExecutableIdentity
  expectedTransition: ExpectedTransition
  expectedTransitionDigest: string
}

function findResolution(events: readonly unknown[], callId: string, action: StatefulAction): PersistedResolution | undefined {
  let selector: RecordValue | undefined
  let commandManifest: RecordValue | undefined
  for (const raw of events) {
    const event = record(raw)
    if (!event || eventCallId(event) !== callId) continue
    if (event.type === 'tool/call') {
      const data = record(event.data)
      try {
        const args = record(JSON.parse(String(data?.arguments ?? '{}')))
        selector = record(args?.selector)
        commandManifest = record(args?.command_manifest)
      } catch { return undefined }
      continue
    }
    if (event.type !== 'tool/result') continue
    const meta = producerMeta(event)
    if (meta?.semanticAction !== action || meta.evidenceRole !== 'resolution'
      || meta.adapterVersion !== PRODUCER_VERSION || !selector || !commandManifest) return undefined
    const target = tuple(meta.resolvedTarget)
    const rawBinding = record(meta.gitBinding)
    const rawManifest = record(rawBinding?.manifest)
    const rawPrestate = record(rawBinding?.prestate)
    const rawEnvelope = record(rawBinding?.envelope)
    const rawExecutable = record(meta.executableIdentity)
    const rawExpected = record(meta.expectedTransition)
    const expectedParameters = record(rawExpected?.parameters)
    const expectedTransition = rawExpected
      && typeof rawExpected.predicateId === 'string'
      && rawExpected.version === 1
      && rawExpected.predParamsKind === 'inline'
      && expectedParameters
      ? rawExpected as unknown as ExpectedTransition
      : undefined
    const expectedTransitionDigest = typeof meta.expectedTransitionDigest === 'string'
      ? meta.expectedTransitionDigest
      : undefined
    const interpreterIdentityValid = rawExecutable
      && ((rawExecutable.interpreterRealpath === undefined && rawExecutable.interpreterVersion === undefined)
        || (typeof rawExecutable.interpreterRealpath === 'string'
          && typeof rawExecutable.interpreterVersion === 'string'))
    const executableIdentity = rawExecutable
      && typeof rawExecutable.executable === 'string'
      && typeof rawExecutable.realpath === 'string'
      && typeof rawExecutable.version === 'string'
      && interpreterIdentityValid
      ? rawExecutable as unknown as ExecutableIdentity
      : undefined
    const gitBinding = rawManifest && rawPrestate && rawEnvelope
      ? {
          manifest: rawManifest as unknown as GitCommandManifest,
          prestate: Object.fromEntries(Object.entries(rawPrestate).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
          envelope: rawEnvelope as unknown as GitPrestateEnvelope,
        }
      : undefined
    return target && expectedTransition && expectedTransitionDigest === digest(expectedTransition) ? {
      target, selector, commandManifest,
      ...(gitBinding ? { gitBinding } : {}),
      ...(executableIdentity ? { executableIdentity } : {}),
      expectedTransition,
      expectedTransitionDigest,
    } : undefined
  }
  return undefined
}

interface PersistedEffect {
  name: string
  arguments: RecordValue
  error?: unknown
  callSeq: number
  resultSeq: number
  textContent: string
  meta?: unknown
}

function findEffect(events: readonly unknown[], callId: string): PersistedEffect | undefined {
  let call: PersistedEffect | undefined
  for (const raw of events) {
    const event = record(raw)
    if (!event) continue
    const seq = typeof event.seq === 'number' ? event.seq : -1
    if (event.type === 'tool/call' && eventCallId(event) === callId) {
      const data = record(event.data)
      let args: RecordValue = {}
      try { args = record(JSON.parse(String(data?.arguments ?? '{}'))) ?? {} } catch { args = {} }
      call = { name: String(data?.name ?? ''), arguments: args, callSeq: seq, resultSeq: -1, textContent: '' }
    }
    if (event.type === 'tool/result' && eventCallId(event) === callId && call) {
      const data = record(event.data)
      call.resultSeq = seq
      call.error = data?.error
      call.meta = data?.meta
      const message = record(data?.message)
      call.textContent = extractTextContent((message?.content as unknown[] | undefined) ?? [])
      return call
    }
  }
  return undefined
}

function actionCallMatches(
  events: readonly unknown[], callId: string, action: StatefulAction, resolutionCallId: string, target: TargetTuple,
): boolean {
  for (const raw of events) {
    const event = record(raw)
    if (!event || event.type !== 'tool/call' || eventCallId(event) !== callId) continue
    const data = record(event.data)
    if (data?.name !== ACTION_TOOL) return false
    try {
      const args = record(JSON.parse(String(data.arguments ?? '{}')))
      return args?.semantic_action === action && args.resolution_call_id === resolutionCallId
        && args.target_digest === digest(target)
        && typeof args.contract_item_id === 'string'
        && Number.isSafeInteger(args.contract_item_revision)
    } catch { return false }
  }
  return false
}

function actionResultCompleted(events: readonly unknown[], callId: string): boolean {
  for (const raw of events) {
    const event = record(raw)
    if (!event || event.type !== 'tool/result' || eventCallId(event) !== callId) continue
    const outer = messageMeta(event)
    const meta = record(outer?.contextGuardAction)
    return meta?.status === 'completed'
  }
  return false
}

function plannedEffectDigest(manifest: RecordValue): string | undefined {
  const name = typeof manifest.planned_tool === 'string' ? manifest.planned_tool : undefined
  const args = record(manifest.planned_arguments)
  return name && args ? digest({ name, arguments: args }) : undefined
}

function plannedEffect(manifest: RecordValue): { name: string; arguments: RecordValue; digest: string } | undefined {
  const name = typeof manifest.planned_tool === 'string' ? manifest.planned_tool : undefined
  const args = record(manifest.planned_arguments)
  return name && args ? { name, arguments: args, digest: digest({ name, arguments: args }) } : undefined
}

function plannedGitManifest(
  action: StatefulAction,
  selector: RecordValue,
  planned: { name: string; arguments: RecordValue },
): GitCommandManifest | undefined {
  if ((planned.name !== 'bash' && planned.name !== 'pwsh')
    || !hasExactKeys(planned.arguments, ['command', 'workdir'])) return undefined
  const repository = requireString(selector, 'repository')
  const command = requireString(planned.arguments, 'command')
  if (!repository || planned.arguments.workdir !== repository || !command) return undefined
  const parsed = parseGitCommandManifest(command, planned.name)
  if (parsed.status !== 'accepted' || parsed.manifest.action !== action) return undefined
  const remote = requireString(selector, 'remote')
  const refspec = requireString(selector, 'refspec')
  if (!gitCommandMatchesTarget(parsed.manifest, { repository, ...(remote ? { remote } : {}), ...(refspec ? { refspec } : {}) })) return undefined
  return parsed.manifest
}

function effectDigest(effect: PersistedEffect): string {
  return digest({ name: effect.name, arguments: effect.arguments })
}

function cwdOf(agent: { session: { header: unknown } }): string | undefined {
  const header = record(agent.session.header)
  return typeof header?.cwd === 'string' ? header.cwd : undefined
}

function pathOf(selector: RecordValue, cwd: string | undefined): string | undefined {
  const raw = typeof selector.artifact_id === 'string' ? selector.artifact_id : undefined
  if (!raw) return undefined
  return isAbsolute(raw) ? raw : cwd ? resolve(cwd, raw) : undefined
}

async function fileDigest(path: string): Promise<string | 'absent'> {
  try { return createHash('sha256').update(await readFile(path)).digest('hex') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    throw error
  }
}

async function readJson(path: string): Promise<RecordValue | undefined> {
  try { return record(JSON.parse(await readFile(path, 'utf8'))) } catch { return undefined }
}

interface TgzIdentity { name: string; version: string; integrity: string }

async function tgzIdentity(path: string): Promise<TgzIdentity | undefined> {
  if (!isAbsolute(path) || !path.endsWith('.tgz')) return undefined
  const bytes = await readFile(path)
  if (bytes.length === 0 || bytes.length > 128 * 1024 * 1024) return undefined
  const tar = await promisify(gunzip)(bytes)
  let manifest: RecordValue | undefined
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim()
    if (!/^[0-7]+$/.test(sizeText)) return undefined
    const size = Number.parseInt(sizeText, 8)
    const bodyStart = offset + 512
    const bodyEnd = bodyStart + size
    if (!Number.isSafeInteger(size) || size < 0 || bodyEnd > tar.length) return undefined
    if (name === 'package/package.json') {
      if (manifest || size > 1024 * 1024) return undefined
      try { manifest = record(JSON.parse(tar.subarray(bodyStart, bodyEnd).toString('utf8'))) } catch { return undefined }
    }
    offset = bodyStart + Math.ceil(size / 512) * 512
  }
  if (typeof manifest?.name !== 'string' || typeof manifest.version !== 'string') return undefined
  return {
    name: manifest.name,
    version: manifest.version,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  }
}

const DSHMARKET_VERSION = '1.36.0'
const DSHMARKET_INTEGRITY = 'sha512-xX8CCoXdIALaxtLosj+5qGg8r1cykW2zo1AOPJcSQepg2r4Vd2K0NmERldDqfeyFV0pCuZsUoAPe1Q/BW7De/g=='
const MARKET_SCHEMA = 'dsh-market/update-api/v1'

async function marketCapabilities(roots: EvidenceToolRoots, signal: AbortSignal): Promise<RecordValue | undefined> {
  if (!roots.profile || !roots.marketOrigin) return undefined
  const installed = await profilePackage(roots.profile.path, 'dshmarket')
  if (installed?.version !== DSHMARKET_VERSION || installed.integrity !== DSHMARKET_INTEGRITY) return undefined
  const response = await (roots.fetcher ?? fetch)(`${roots.marketOrigin}/dsh-market/api/v1/capabilities`, {
    signal, headers: { accept: 'application/json' }, redirect: 'error',
  })
  if (!response.ok) return undefined
  const value = record(await response.json())
  if (value?.schema !== MARKET_SCHEMA || value.apiVersion !== 1 || value.marketVersion !== DSHMARKET_VERSION
    || value.profile !== roots.profile.name || typeof value.bootId !== 'string') return undefined
  return value
}

function importerLocator(text: string, packageId: string): string | undefined {
  const escaped = packageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp(`^      ['"]?${escaped}['"]?:\\s*$`).test(line))
  if (start < 0) return undefined
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^      \S/.test(lines[index])) break
    const match = /^        version:\s*(.+?)\s*$/.exec(lines[index])
    if (match) return match[1].replace(/^['"]|['"]$/g, '')
  }
  return undefined
}

function lockIntegrity(text: string, packageId: string, locator: string): string | undefined {
  const escaped = `${packageId}@${locator}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp(`^  ['"]?${escaped}['"]?:\\s*$`).test(line))
  if (start < 0) return undefined
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  \S/.test(lines[index])) break
    const match = /^    resolution: \{integrity: ([^}]+)\}\s*$/.exec(lines[index])
    if (match) return match[1]
  }
  return undefined
}

async function profilePackage(profilePath: string, packageId: string): Promise<{ version: string; integrity: string } | undefined> {
  const manifest = await readJson(resolve(profilePath, 'node_modules', ...packageId.split('/'), 'package.json'))
  if (manifest?.name !== packageId || typeof manifest.version !== 'string') return undefined
  try {
    const lock = await readFile(resolve(profilePath, 'pnpm-lock.yaml'), 'utf8')
    const locator = importerLocator(lock, packageId)
    const integrity = locator ? lockIntegrity(lock, packageId, locator) : undefined
    return integrity ? { version: manifest.version, integrity } : undefined
  } catch { return undefined }
}

async function registryIntegrity(registry: string, packageId: string, version: string, roots: EvidenceToolRoots, signal: AbortSignal): Promise<string | undefined> {
  const canonical = canonicalRegistryBase(registry, { allowLoopbackHttp: roots.allowLoopbackHttpRegistry })
  if (!canonical || canonical !== registry) return undefined
  const response = await (roots.fetcher ?? fetch)(new URL(npmEscapedPackageName(packageId), canonical), {
    signal, headers: { accept: 'application/json' }, redirect: 'error',
  })
  if (!response.ok) return undefined
  const value = record(await response.json())
  const versions = record(value?.versions)
  const release = record(versions?.[version])
  const dist = record(release?.dist)
  return value?.name === packageId && release?.name === packageId && release.version === version
    && typeof dist?.integrity === 'string' ? dist.integrity : undefined
}

export function windowsBatchCommand(file: string, args: string[]): string | undefined {
  const values = [file, ...args]
  // Keep the shell boundary closed: cmd.exe expands percent variables inside
  // quotes and gives several punctuation characters control semantics. Paths
  // containing them remain unsupported rather than being reinterpreted.
  if (values.some((value) => /[\0\r\n"%!^&|<>]/.test(value))) return undefined
  return values.map((value) => `"${value}"`).join(' ')
}

type WindowsCommandInterpreter = Required<Pick<ExecutableIdentity, 'interpreterRealpath' | 'interpreterVersion'>>

async function windowsCommandInterpreter(signal: AbortSignal): Promise<WindowsCommandInterpreter | undefined> {
  const configured = process.env.ComSpec
  const systemRoot = process.env.SystemRoot
  if (!configured || !systemRoot || !isAbsolute(configured) || !isAbsolute(systemRoot)
    || basename(configured).toLowerCase() !== 'cmd.exe'
    || /[\0\r\n"%!^&|<>]/.test(configured)
    || /[\0\r\n"%!^&|<>]/.test(systemRoot)) return undefined
  try {
    const interpreterRealpath = await realpath(configured)
    const systemInterpreter = await realpath(resolve(systemRoot, 'System32', 'cmd.exe'))
    if (basename(interpreterRealpath).toLowerCase() !== 'cmd.exe'
      || interpreterRealpath.toLowerCase() !== systemInterpreter.toLowerCase()) return undefined
    const { stdout, stderr } = await execFileAsync(interpreterRealpath, ['/d', '/v:off', '/c', 'ver'], {
      encoding: 'utf8', signal, windowsHide: true,
    })
    const interpreterVersion = `${stdout}${stderr}`.trim()
    return interpreterVersion && !/[\0\r\n]/.test(interpreterVersion)
      ? { interpreterRealpath, interpreterVersion }
      : undefined
  } catch {
    return undefined
  }
}

async function execAuditedFile(
  file: string,
  args: string[],
  options: { cwd?: string; signal: AbortSignal; env?: NodeJS.ProcessEnv },
  interpreter?: WindowsCommandInterpreter,
) {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(file)) {
    const command = windowsBatchCommand(file, args)
    if (!command || !interpreter) throw new Error('unsafe Windows batch invocation')
    return execFileAsync(interpreter.interpreterRealpath, ['/d', '/v:off', '/s', '/c', `"${command}"`], {
      ...options,
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: true,
    })
  }
  return execFileAsync(file, args, { ...options, encoding: 'utf8' })
}

async function runCommand(
  roots: EvidenceToolRoots,
  identity: ExecutableIdentity,
  args: string[],
  cwd: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (roots.commandRunner) return roots.commandRunner(identity.executable, args, cwd, signal)
  const interpreter = identity.interpreterRealpath && identity.interpreterVersion
    ? { interpreterRealpath: identity.interpreterRealpath, interpreterVersion: identity.interpreterVersion }
    : undefined
  await execAuditedFile(identity.realpath, args, {
    ...(cwd ? { cwd } : {}), signal,
    env: { ...process.env, npm_config_cache: join(tmpdir(), 'dsh-completion-guard-npm-cache') },
  }, interpreter)
}

/** @internal Native-platform regression seam for the audited execution path. */
export async function executeAuditedCommand(
  identity: ExecutableIdentity,
  args: string[],
  cwd: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  await runCommand({}, identity, args, cwd, signal)
}

function executableFor(action: StatefulAction): AuditedExecutable | undefined {
  if (['commit', 'push', 'pull', 'fetch'].includes(action)) return 'git'
  if (action === 'install' || action === 'apply') return 'dsh'
  if (action === 'publish') return 'npm'
  return undefined
}

export async function executableIdentity(executable: AuditedExecutable, signal: AbortSignal): Promise<ExecutableIdentity | undefined> {
  const suffixes = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : ['']
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = resolve(directory, `${executable}${suffix}`)
      try {
        await access(candidate, constants.X_OK)
        const canonical = await realpath(candidate)
        const interpreter = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(canonical)
          ? await windowsCommandInterpreter(signal)
          : undefined
        if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(canonical) && !interpreter) continue
        const { stdout, stderr } = await execAuditedFile(canonical, ['--version'], { signal }, interpreter)
        const version = `${stdout}${stderr}`.trim()
        if (version && !version.includes('\n') && !version.includes('\r')) {
          return { executable, realpath: canonical, version, ...interpreter }
        }
      } catch { /* continue to the next PATH candidate */ }
    }
  }
  return undefined
}

async function executeGuardAction(
  action: StatefulAction,
  resolution: PersistedResolution,
  roots: EvidenceToolRoots,
  signal: AbortSignal,
  executableIdentity?: ExecutableIdentity,
  resolutionCallId?: string,
  agent?: { session: { events: readonly unknown[] } },
): Promise<'completed' | 'handoff_pending' | 'unavailable'> {
  const target = resolution.target
  if (action === 'install' || action === 'apply') {
    const tgzPath = requireString(resolution.commandManifest, 'tgz_path')
    const identity = tgzPath ? await tgzIdentity(tgzPath) : undefined
    if (!executableIdentity || !tgzPath || !identity || identity.name !== target.package_id || identity.version !== target.version
      || identity.integrity !== target.integrity_digest || roots.profile?.name !== target.profile) return 'unavailable'
    await runCommand(roots, executableIdentity, ['plugin', '--profile', roots.profile.name, 'add', `file:${tgzPath}`], undefined, signal)
    return 'completed'
  }
  if (action === 'publish') {
    const tgzPath = requireString(resolution.commandManifest, 'tgz_path')
    const identity = tgzPath ? await tgzIdentity(tgzPath) : undefined
    const registry = typeof target.registry === 'string'
      ? canonicalRegistryBase(target.registry, { allowLoopbackHttp: roots.allowLoopbackHttpRegistry })
      : undefined
    if (!executableIdentity || !tgzPath || !identity || identity.name !== target.artifact_id || identity.version !== target.version
      || identity.integrity !== target.integrity_digest || !registry || registry !== target.registry) return 'unavailable'
    await runCommand(roots, executableIdentity, ['publish', tgzPath, '--registry', registry, '--ignore-scripts'], undefined, signal)
    return 'completed'
  }
  if (action === 'restart') {
    const capabilities = await marketCapabilities(roots, signal)
    if (!capabilities || !roots.marketOrigin || !resolutionCallId || !agent) return 'unavailable'
    if (capabilities.bootId !== target.pre_generation) {
      return restartIntent(agent.session.events, resolutionCallId, target) ? 'completed' : 'unavailable'
    }
    if (restartIntent(agent.session.events, resolutionCallId, target)) return 'handoff_pending'
    if (!roots.persistRestartIntent || !await roots.persistRestartIntent(agent, {
      resolutionCallId,
      serviceId: String(target.service_id),
      preGeneration: String(target.pre_generation),
    })) return 'unavailable'
    const response = await (roots.fetcher ?? fetch)(`${roots.marketOrigin}/dsh-market/api/v1/restart`, {
      method: 'POST', signal, redirect: 'error',
      headers: { accept: 'application/json', 'content-type': 'application/json', origin: roots.marketOrigin },
      body: '{}',
    })
    if (!response.ok) return 'unavailable'
    const body = record(await response.json())
    // The old process is expected to terminate before its tool/result is
    // durable. Even if it survives long enough to return, this is only a
    // handoff acknowledgement; a restored process must observe the new bootId
    // before minting effect evidence.
    return body?.schema === MARKET_SCHEMA ? 'handoff_pending' : 'unavailable'
  }
  if (action === 'commit' || action === 'push' || action === 'pull' || action === 'fetch') {
    const binding = resolution.gitBinding
    const repository = requireString(resolution.target as RecordValue, 'repository')
    if (!executableIdentity || !binding || !repository) return 'unavailable'
    const targetIdentity: GitTargetIdentity = {
      repository,
      ...(typeof resolution.target.remote === 'string' ? { remote: resolution.target.remote } : {}),
      ...(typeof resolution.target.refspec === 'string' ? { refspec: resolution.target.refspec } : {}),
    }
    const current = await gitPrestate(binding.manifest, repository, signal, executableIdentity.realpath)
    if (!current) return 'unavailable'
    const executed = await executeRevalidatedGitEffect(
      binding.envelope,
      binding.manifest,
      targetIdentity,
      current,
      async (_file, argv, workingDirectory) => runCommand(roots, executableIdentity, argv, workingDirectory, signal),
    )
    if (executed.status !== 'executed') return 'unavailable'
    if (action === 'commit') {
      const commit = verifiedLinearCommitReadback(
        await gitBytes(repository, ['rev-list', '--parents', '-n', '1', 'HEAD'], signal, executableIdentity.realpath),
        String(resolution.target.pre_head_oid ?? ''),
      )
      const postTree = commit
        ? commitTreeSnapshotDigest(await gitBytes(repository, ['ls-tree', '-r', '-z', commit.postHeadOid], signal, executableIdentity.realpath))
        : undefined
      if (!commit || postTree !== resolution.target.change_set_digest) return 'unavailable'
    } else if (action === 'push') {
      const remoteOid = binding.manifest.remote && binding.manifest.destinationRef
        ? await exactRemoteOid(repository, binding.manifest.remote, binding.manifest.destinationRef, signal, executableIdentity.realpath)
        : undefined
      if (!remoteOid || remoteOid !== resolution.target.local_oid) return 'unavailable'
    } else {
      const upstream = String(resolution.target.upstream_oid ?? '')
      const trackingRef = binding.manifest.action === 'fetch'
        ? binding.manifest.trackingRef
        : binding.manifest.remote && binding.manifest.sourceRef
          ? `refs/remotes/${binding.manifest.remote}/${binding.manifest.sourceRef.slice('refs/heads/'.length)}`
          : undefined
      const tracking = trackingRef ? oid(await git(repository, ['rev-parse', '--verify', trackingRef], signal, executableIdentity.realpath)) : undefined
      if (!tracking || tracking !== upstream) return 'unavailable'
      if (action === 'pull' && oid(await git(repository, ['rev-parse', 'HEAD'], signal, executableIdentity.realpath)) !== upstream) return 'unavailable'
      if (action === 'fetch' && oid(await git(repository, ['rev-parse', 'HEAD'], signal, executableIdentity.realpath)) !== resolution.target.pre_head_oid) return 'unavailable'
    }
    return 'completed'
  }
  return 'unavailable'
}

async function gitBytes(repository: string, args: string[], signal: AbortSignal, file = 'git'): Promise<Buffer> {
  const { stdout } = await execFileAsync(file, args, {
    cwd: repository, encoding: 'buffer', signal,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return Buffer.from(stdout)
}

async function git(repository: string, args: string[], signal: AbortSignal, file = 'git'): Promise<string> {
  return (await gitBytes(repository, args, signal, file)).toString('utf8').replace(/[\r\n]+$/, '')
}

function oid(value: string): string | undefined {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value) ? value.toLowerCase() : undefined
}

async function exactRemoteOid(repository: string, remote: string, ref: string, signal: AbortSignal, file = 'git'): Promise<string | undefined> {
  try {
    const line = await git(repository, ['ls-remote', '--exit-code', '--refs', remote, ref], signal, file)
    const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\t([^\r\n]+)$/i.exec(line)
    return match && match[2] === ref ? match[1].toLowerCase() : undefined
  } catch { return undefined }
}

async function gitPrestate(
  manifest: GitCommandManifest,
  repository: string,
  signal: AbortSignal,
  file = 'git',
): Promise<Record<string, string> | undefined> {
  if (manifest.action === 'commit') {
    const head = oid(await git(repository, ['rev-parse', 'HEAD'], signal, file))
    const branch = await git(repository, ['symbolic-ref', '--quiet', 'HEAD'], signal, file)
    const index = commitIndexSnapshotDigest(await gitBytes(repository, ['ls-files', '--stage', '-z'], signal, file))
    return head && branch.startsWith('refs/heads/') && index
      ? { pre_head_oid: head, branch, index_digest: index }
      : undefined
  }
  if (!manifest.remote || !manifest.sourceRef) return undefined
  const upstream = await exactRemoteOid(repository, manifest.remote, manifest.sourceRef, signal, file)
  if (!upstream) return undefined
  if (manifest.action === 'push') {
    if (!manifest.destinationRef) return undefined
    const source = oid(await git(repository, ['rev-parse', '--verify', manifest.sourceRef], signal, file))
    const destination = await exactRemoteOid(repository, manifest.remote, manifest.destinationRef, signal, file)
    return source && destination ? { source_oid: source, destination_oid: destination } : undefined
  }
  if (manifest.action === 'fetch') {
    if (!manifest.trackingRef) return undefined
    const head = oid(await git(repository, ['rev-parse', 'HEAD'], signal, file))
    let tracking = 'absent'
    try { tracking = oid(await git(repository, ['rev-parse', '--verify', manifest.trackingRef], signal, file)) ?? 'absent' } catch { /* absent is bounded */ }
    return head ? { upstream_oid: upstream, pre_head_oid: head, tracking_oid: tracking } : undefined
  }
  if (manifest.action === 'pull') {
    const head = oid(await git(repository, ['rev-parse', 'HEAD'], signal, file))
    const trackingRef = `refs/remotes/${manifest.remote}/${manifest.sourceRef.slice('refs/heads/'.length)}`
    let tracking = 'absent'
    try { tracking = oid(await git(repository, ['rev-parse', '--verify', trackingRef], signal, file)) ?? 'absent' } catch { /* absent is bounded */ }
    return head ? { upstream_oid: upstream, pre_head_oid: head, tracking_oid: tracking } : undefined
  }
  return undefined
}

function requireString(row: RecordValue, key: string): string | undefined {
  return typeof row[key] === 'string' && row[key] ? row[key] as string : undefined
}

function hasExactKeys(row: RecordValue, keys: readonly string[]): boolean {
  const actual = Object.keys(row).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function selectorHasOnlyCanonicalKeys(action: StatefulAction, selector: RecordValue): boolean {
  const allowed = new Set(ACTION_MANIFEST.actions[action].resolvedTargetKeys)
  return Object.keys(selector).every((key) => allowed.has(key))
}

interface ResolvedObservation {
  target: TargetTuple
  gitBinding?: { manifest: GitCommandManifest; prestate: Record<string, string>; envelope: GitPrestateEnvelope }
}

function pickTarget(target: TargetTuple, keys: readonly string[]): TargetTuple {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(target, key)).map((key) => [key, target[key]]))
}

export async function expectedTransitionForResolution(
  action: StatefulAction,
  target: TargetTuple,
  commandManifest: RecordValue,
): Promise<FrozenExpectedTransition | undefined> {
  let parameters: TargetTuple
  if (action === 'create') {
    const plannedArguments = record(commandManifest.planned_arguments)
    const content = typeof plannedArguments?.content === 'string' ? plannedArguments.content : undefined
    if (content === undefined) return undefined
    parameters = { post_digest: createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex') }
  } else if (action === 'modify') {
    const plannedArguments = record(commandManifest.planned_arguments)
    const oldString = requireString(plannedArguments ?? {}, 'old_string')
    const newString = typeof plannedArguments?.new_string === 'string' ? plannedArguments.new_string : undefined
    const artifact = typeof target.artifact_id === 'string' ? target.artifact_id : undefined
    if (!artifact || !oldString || newString === undefined) return undefined
    let before: string
    try {
      const beforeBytes = await readFile(artifact)
      const frozenPreDigest = typeof target.pre_digest === 'string' ? target.pre_digest : undefined
      if (!frozenPreDigest || createHash('sha256').update(beforeBytes).digest('hex') !== frozenPreDigest) return undefined
      before = new TextDecoder('utf-8', { fatal: true }).decode(beforeBytes)
    } catch { return undefined }
    const first = before.indexOf(oldString)
    if (first < 0 || before.indexOf(oldString, first + oldString.length) >= 0) return undefined
    const after = `${before.slice(0, first)}${newString}${before.slice(first + oldString.length)}`
    parameters = { post_digest: createHash('sha256').update(Buffer.from(after, 'utf8')).digest('hex') }
  } else if (action === 'install' || action === 'apply') {
    parameters = pickTarget(target, ['package_id', 'version', 'integrity_digest', 'profile'])
  } else if (action === 'publish') {
    parameters = pickTarget(target, ['artifact_id', 'version', 'registry', 'integrity_digest'])
  } else if (action === 'restart') {
    parameters = { ...pickTarget(target, ['pre_generation']), health: 'healthy' }
  } else if (action === 'commit') {
    parameters = pickTarget(target, ['pre_head_oid', 'change_set_digest'])
  } else if (action === 'push') {
    parameters = pickTarget(target, ['local_oid'])
  } else if (action === 'pull') {
    parameters = pickTarget(target, ['pull_mode', 'upstream_oid', 'pre_head_oid'])
  } else if (action === 'fetch') {
    parameters = pickTarget(target, ['upstream_oid', 'pre_head_oid'])
  } else {
    return undefined
  }
  return {
    predicateId: ACTION_MANIFEST.actions[action].predicateId,
    version: 1,
    predParamsKind: 'inline',
    parameters,
  }
}

async function resolveTarget(
  action: StatefulAction,
  selector: RecordValue,
  commandManifest: RecordValue,
  cwd: string | undefined,
  roots: EvidenceToolRoots,
  signal: AbortSignal,
  executableIdentity?: ExecutableIdentity,
): Promise<ResolvedObservation | undefined> {
  if (!selectorHasOnlyCanonicalKeys(action, selector)) return undefined
  const planned = plannedEffectDigest(commandManifest)
  const plannedCall = plannedEffect(commandManifest)
  if (action === 'install' || action === 'apply') {
    const packageId = requireString(selector, 'package_id')
    const profile = requireString(selector, 'profile')
    const trustedProfile = roots.profile
    const tgzPath = requireString(commandManifest, 'tgz_path')
    const manifestId = action === 'install' ? 'dsh.plugin_add_tgz.install.v1' : 'dsh.plugin_add_tgz.apply.v1'
    if (!hasExactKeys(commandManifest, ['manifest_id', 'tgz_path'])
      || !packageId || !profile || profile !== trustedProfile?.name
      || commandManifest.manifest_id !== manifestId
      || !ACTION_MANIFEST.actions[action].commandManifestIds.includes(manifestId)
      || !tgzPath) return undefined
    const identity = await tgzIdentity(tgzPath)
    if (!identity || identity.name !== packageId || (selector.version !== undefined && selector.version !== identity.version)) return undefined
    const installed = await profilePackage(trustedProfile.path, packageId)
    if (action === 'install' && installed) return undefined
    if (action === 'apply' && (!installed || (installed.version === identity.version && installed.integrity === identity.integrity))) return undefined
    return { target: { package_id: packageId, version: identity.version, integrity_digest: identity.integrity, profile } }
  }
  if (action === 'restart') {
    const service = requireString(selector, 'service_id')
    if (service !== 'dsh-web' || commandManifest.manifest_id !== 'dshmarket.restart.v1'
      || !ACTION_MANIFEST.actions.restart.commandManifestIds.includes('dshmarket.restart.v1')
      || Object.keys(commandManifest).length !== 1) return undefined
    const capabilities = await marketCapabilities(roots, signal)
    const features = record(capabilities?.features)
    const restart = record(capabilities?.restart)
    if (features?.restart !== true || restart?.supported !== true || restart.managedBy !== 'market') return undefined
    return { target: { service_id: service, pre_generation: String(capabilities?.bootId) } }
  }
  if (action === 'publish') {
    const registry = canonicalRegistryBase(requireString(selector, 'registry') ?? '', {
      allowLoopbackHttp: roots.allowLoopbackHttpRegistry,
    })
    const tgzPath = requireString(commandManifest, 'tgz_path')
    if (!hasExactKeys(commandManifest, ['manifest_id', 'tgz_path'])
      || !registry || commandManifest.manifest_id !== 'npm.publish_tgz.v1'
      || !ACTION_MANIFEST.actions.publish.commandManifestIds.includes('npm.publish_tgz.v1') || !tgzPath) return undefined
    const identity = await tgzIdentity(tgzPath)
    if (!identity || identity.name !== selector.artifact_id || identity.version !== selector.version) return undefined
    return { target: { artifact_id: identity.name, version: identity.version, registry, integrity_digest: identity.integrity } }
  }
  if (action === 'create' || action === 'modify') {
    if (!hasExactKeys(commandManifest, ['planned_tool', 'planned_arguments']) || !plannedCall) return undefined
    const allowedArgs = action === 'create' ? ['file_path', 'content'] : ['file_path', 'old_string', 'new_string']
    if (!hasExactKeys(plannedCall.arguments, allowedArgs)) return undefined
    const artifact = pathOf(selector, cwd)
    if (!artifact || !planned) return undefined
    const pre = await fileDigest(artifact)
    if (action === 'create' && pre !== 'absent') return undefined
    if (action === 'modify' && pre === 'absent') return undefined
    return { target: { artifact_id: artifact, scope: dirname(artifact), pre_digest: pre, change_set_digest: planned } }
  }
  const repository = requireString(selector, 'repository')
  if (!repository || repository !== cwd && !isAbsolute(repository) || !plannedCall
    || !hasExactKeys(commandManifest, ['planned_tool', 'planned_arguments'])
    || executableIdentity?.executable !== 'git') return undefined
  const manifest = plannedGitManifest(action, selector, plannedCall)
  if (!manifest || !ACTION_MANIFEST.actions[action].commandManifestIds.includes(manifest.manifestId)) return undefined
  const targetIdentity: GitTargetIdentity = {
    repository,
    ...(manifest.remote ? { remote: manifest.remote } : {}),
    ...(requireString(selector, 'refspec') ? { refspec: requireString(selector, 'refspec') } : {}),
  }
  const prestate = await gitPrestate(manifest, repository, signal, executableIdentity.realpath)
  if (!prestate) return undefined
  const envelope = createGitPrestateEnvelope(manifest, targetIdentity, prestate)
  if (action === 'commit') {
    if (!hasExactKeys(selector, ['repository', 'branch'])) return undefined
    const branch = requireString(selector, 'branch')
    if (!branch || prestate.branch !== `refs/heads/${branch}`) return undefined
    return {
      target: { repository, branch, change_set_digest: prestate.index_digest, pre_head_oid: prestate.pre_head_oid },
      gitBinding: { manifest, prestate, envelope },
    }
  }
  if (!hasExactKeys(selector, ['repository', 'remote', 'refspec'])) return undefined
  const remote = requireString(selector, 'remote')
  const refspec = requireString(selector, 'refspec')
  if (!remote || !refspec) return undefined
  let target: TargetTuple
  if (action === 'push') target = { repository, remote, refspec, local_oid: prestate.source_oid }
  else if (action === 'fetch') target = { repository, remote, refspec, upstream_oid: prestate.upstream_oid, pre_head_oid: prestate.pre_head_oid }
  else target = { repository, remote, refspec, upstream_oid: prestate.upstream_oid, pre_head_oid: prestate.pre_head_oid, pull_mode: 'ff-only' }
  return { target, gitBinding: { manifest, prestate, envelope } }
}

function effectMatches(action: StatefulAction, resolution: PersistedResolution, effect: PersistedEffect): boolean {
  const resolvedTarget = resolution.target
  if (action !== 'create' && action !== 'modify') return false
  const expectedNames = action === 'create' ? ['write', 'write_file'] : ['edit', 'edit_file']
  if (effect.error !== undefined || effect.resultSeq < effect.callSeq || !expectedNames.includes(effect.name)) return false
  const parsed = evidenceFromPersistedToolResult(
    { callId: 'effect-readback', name: effect.name, arguments: JSON.stringify(effect.arguments) },
    { seq: effect.resultSeq, error: effect.error, meta: effect.meta, textContent: effect.textContent },
    0, 'effect-readback', typeof effect.arguments.workdir === 'string' ? effect.arguments.workdir : undefined,
  )
  if (parsed.outcome !== 'success' || parsed.parseStatus !== 'supported') return false
  if (effectDigest(effect) !== resolvedTarget.change_set_digest && (action === 'create' || action === 'modify')) return false
  if (effectDigest(effect) !== plannedEffectDigest(resolution.commandManifest)) return false
  return true
}

async function readback(
  action: StatefulAction,
  target: TargetTuple,
  roots: EvidenceToolRoots,
  signal: AbortSignal,
  executableIdentity?: ExecutableIdentity,
): Promise<TargetTuple | undefined> {
  if (action === 'install' || action === 'apply') {
    const packageId = typeof target.package_id === 'string' ? target.package_id : undefined
    const profile = typeof target.profile === 'string' ? target.profile : undefined
    const trustedProfile = roots.profile
    if (!packageId || !profile || profile !== trustedProfile?.name) return undefined
    const installed = await profilePackage(trustedProfile.path, packageId)
    return installed ? { package_id: packageId, version: installed.version, integrity_digest: installed.integrity, profile } : undefined
  }
  if (action === 'restart') {
    const capabilities = await marketCapabilities(roots, signal)
    if (!capabilities || capabilities.bootId === target.pre_generation) return undefined
    return { new_generation: String(capabilities.bootId), health: 'healthy' }
  }
  if (action === 'publish') {
    const registry = typeof target.registry === 'string' ? target.registry : undefined
    const artifact = typeof target.artifact_id === 'string' ? target.artifact_id : undefined
    const version = typeof target.version === 'string' ? target.version : undefined
    if (!registry || !artifact || !version) return undefined
    const integrity = await registryIntegrity(registry, artifact, version, roots, signal)
    return integrity ? { artifact_id: artifact, version, registry, integrity_digest: integrity } : undefined
  }
  if (action === 'create' || action === 'modify') {
    const artifact = typeof target.artifact_id === 'string' ? target.artifact_id : undefined
    if (!artifact) return undefined
    const post = await fileDigest(artifact)
    return post === 'absent' ? undefined : { post_digest: post }
  }
  const repository = typeof target.repository === 'string' ? target.repository : undefined
  if (!repository || executableIdentity?.executable !== 'git') return undefined
  if (action === 'commit') {
    const commit = verifiedLinearCommitReadback(
      await gitBytes(repository, ['rev-list', '--parents', '-n', '1', 'HEAD'], signal, executableIdentity.realpath),
      String(target.pre_head_oid ?? ''),
    )
    const tree = commit
      ? commitTreeSnapshotDigest(await gitBytes(repository, ['ls-tree', '-r', '-z', commit.postHeadOid], signal, executableIdentity.realpath))
      : undefined
    return commit && tree === target.change_set_digest
      ? { post_head_oid: commit.postHeadOid, pre_head_oid: commit.preHeadOid }
      : undefined
  }
  const remote = String(target.remote ?? '')
  const refspec = String(target.refspec ?? '')
  const parsed = refspec.split(':')
  if (action === 'push') {
    if (parsed.length !== 2) return undefined
    const remoteOid = await exactRemoteOid(repository, remote, parsed[1], signal, executableIdentity.realpath)
    return remoteOid ? { remote_oid: remoteOid } : undefined
  }
  const sourceRef = parsed[0]
  const trackingRef = action === 'fetch'
    ? parsed[1]
    : sourceRef.startsWith('refs/heads/') ? `refs/remotes/${remote}/${sourceRef.slice('refs/heads/'.length)}` : undefined
  if (!trackingRef) return undefined
  const tracking = oid(await git(repository, ['rev-parse', '--verify', trackingRef], signal, executableIdentity.realpath))
  if (!tracking) return undefined
  const postHead = oid(await git(repository, ['rev-parse', 'HEAD'], signal, executableIdentity.realpath))
  if (action === 'fetch') return postHead ? { tracking_ref_oid: tracking, post_head_oid: postHead } : undefined
  return postHead ? { post_head_oid: postHead, tracking_ref_oid: tracking } : undefined
}

function normalizedRoots(options: EvidenceToolRoots): EvidenceToolRoots {
  const detectedProfile = options.profile ? undefined : installedProfile()
  return {
    ...(options.profile ? { profile: { name: options.profile.name, path: resolve(options.profile.path) } } : detectedProfile ? { profile: detectedProfile } : {}),
    ...(options.marketOrigin ? { marketOrigin: options.marketOrigin } : {}),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.commandRunner ? { commandRunner: options.commandRunner } : {}),
    ...(options.persistRestartIntent ? { persistRestartIntent: options.persistRestartIntent } : {}),
    ...(options.hostCapability ? { hostCapability: options.hostCapability } : {}),
    ...(options.authorizeMutation ? { authorizeMutation: options.authorizeMutation } : {}),
    ...(options.prepareMutation ? { prepareMutation: options.prepareMutation } : {}),
    ...(options.readExecutableIdentity ? { readExecutableIdentity: options.readExecutableIdentity } : {}),
    ...(options.allowLoopbackHttpRegistry ? { allowLoopbackHttpRegistry: true } : {}),
  }
}

export function createActionTool(options: EvidenceToolRoots = {}): ToolDefinition {
  const roots = normalizedRoots(options)
  return defineTool({
    name: ACTION_TOOL,
    description: 'Execute one explicit Guard-owned mutation after re-reading a persisted resolution and exact target digest. This tool changes package, Git, registry, or Web service state; its result echoes the bounded target and command-manifest digest.',
    parameters: {
      semantic_action: { type: 'string', required: true, enum: ['install', 'apply', 'restart', 'publish', 'commit', 'push', 'pull', 'fetch'] },
      resolution_call_id: { type: 'string', required: true },
      target_digest: { type: 'string', required: true },
      contract_item_id: { type: 'string', required: true },
      contract_item_revision: { type: 'number', required: true },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', required: true, enum: ['completed', 'handoff_pending', 'unavailable'] },
        reason_code: { type: 'string', required: true },
        resolved_target: { type: 'object', required: true, additionalProperties: true },
        target_digest: { type: 'string', required: true },
        command_manifest_digest: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (args, value) => ({ contextGuardAction: {
        status: value.status, reasonCode: value.reason_code, resolvedTarget: value.resolved_target,
        targetDigest: value.target_digest, commandManifestDigest: value.command_manifest_digest,
        contractItemId: args.contract_item_id, contractItemRevision: args.contract_item_revision,
      } }),
    },
    async execute(args, exec) {
      const action = args.semantic_action as StatefulAction
      const agent = exec.agent
      const empty = { resolved_target: {}, target_digest: '', command_manifest_digest: '' }
      if (!agent || !['install', 'apply', 'restart', 'publish', 'commit', 'push', 'pull', 'fetch'].includes(action)) {
        return { status: 'unavailable' as const, reason_code: 'action_adapter_unavailable', ...empty }
      }
      if (roots.hostCapability?.(action).status !== 'supported' && roots.hostCapability) {
        return { status: 'unavailable' as const, reason_code: 'host_capability_unavailable', ...empty }
      }
      let durable = false
      try {
        durable = await roots.prepareMutation?.(agent) === true
      } catch {
        durable = false
      }
      if (!durable) {
        return { status: 'unavailable' as const, reason_code: 'mutation_durability_unavailable', ...empty }
      }
      const resolution = findResolution(agent.session.events, args.resolution_call_id, action)
      if (!resolution) return { status: 'unavailable' as const, reason_code: 'resolution_evidence_missing', ...empty }
      const targetDigest = digest(resolution.target)
      const manifestDigest = digest(resolution.commandManifest)
      const identity = { resolved_target: jsonTuple(resolution.target), target_digest: targetDigest, command_manifest_digest: manifestDigest }
      if (args.target_digest !== targetDigest) {
        return { status: 'unavailable' as const, reason_code: 'target_digest_mismatch', ...identity }
      }
      let authorization: MutationAuthorizationDecision | undefined
      try {
        authorization = roots.authorizeMutation?.({
          action,
          contractItemId: args.contract_item_id,
          contractItemRevision: args.contract_item_revision,
          resolvedTarget: resolution.target,
        })
      } catch {
        authorization = undefined
      }
      if (authorization?.status !== 'authorized') {
        return {
          status: 'unavailable' as const,
          reason_code: authorization?.reasonCode ?? 'mutation_authority_unavailable',
          ...identity,
        }
      }
      const executable = executableFor(action)
      let currentExecutable: ExecutableIdentity | undefined
      if (executable) {
        currentExecutable = await (roots.readExecutableIdentity ?? executableIdentity)(executable, exec.signal)
        if (bindExecutableIdentity(resolution.executableIdentity, currentExecutable).status !== 'supported') {
          return { status: 'unavailable' as const, reason_code: 'executable_identity_drift', ...identity }
        }
      }
      try {
        const status = await executeGuardAction(
          action,
          resolution,
          roots,
          exec.signal,
          currentExecutable,
          args.resolution_call_id,
          agent,
        )
        return {
          status,
          reason_code: status === 'completed' ? 'action_completed'
            : status === 'handoff_pending' ? 'restart_handoff_pending' : 'action_execution_failed',
          ...identity,
        }
      } catch {
        return { status: 'unavailable' as const, reason_code: 'action_execution_failed', ...identity }
      }
    },
  })
}

export function createEvidenceTool(options: EvidenceToolRoots = {}): ToolDefinition {
  const roots = normalizedRoots(options)
  return defineTool({
    name: PRODUCER_TOOL,
    description: 'Create one trusted stateful resolution/effect/state fact from the live resource and persisted DSH tool events. Unsupported adapters fail closed.',
    parameters: {
      semantic_action: { type: 'string', required: true, enum: ['install', 'apply', 'create', 'modify', 'restart', 'commit', 'push', 'publish', 'pull', 'fetch'] },
      evidence_role: { type: 'string', required: true, enum: ['resolution', 'effect', 'state'] },
      selector: { type: 'object', additionalProperties: false, properties: {
        artifact_id: { type: 'string' }, package_id: { type: 'string' }, version: { type: 'string' },
        profile: { type: 'string' }, registry: { type: 'string' }, service_id: { type: 'string' },
        repository: { type: 'string' }, branch: { type: 'string' }, remote: { type: 'string' }, refspec: { type: 'string' },
      } },
      command_manifest: { type: 'object', additionalProperties: false, properties: {
        manifest_id: { type: 'string' }, tgz_path: { type: 'string' }, planned_tool: { type: 'string' },
        planned_arguments: { type: 'object', additionalProperties: false, properties: {
          file_path: { type: 'string' }, content: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' },
          command: { type: 'string' }, workdir: { type: 'string' },
        } },
      } },
      resolution_call_id: { type: 'string' },
      effect_call_id: { type: 'string' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', required: true, enum: ['supported', 'unavailable'] },
        reason_code: { type: 'string', required: true }, semantic_action: { type: 'string', required: true },
        evidence_role: { type: 'string', required: true, enum: ['resolution', 'effect', 'state'] },
        resolved_target: { type: 'object', required: true, additionalProperties: true },
        observed_state: { type: 'object', required: true, additionalProperties: true },
        adapter_id: { type: 'string', required: true }, adapter_version: { type: 'string', required: true },
        target_digest: { type: 'string', required: true }, command_manifest_digest: { type: 'string', required: true },
        expected_transition: { type: 'object', additionalProperties: false, properties: {
          predicateId: { type: 'string', required: true },
          version: { type: 'number', required: true },
          predParamsKind: { type: 'string', required: true, enum: ['inline'] },
          parameters: { type: 'object', required: true, additionalProperties: true },
        } },
        expected_transition_digest: { type: 'string' },
        git_binding: { type: 'object', additionalProperties: true },
        executable_identity: { type: 'object', additionalProperties: false, properties: {
          executable: { type: 'string', required: true }, realpath: { type: 'string', required: true }, version: { type: 'string', required: true },
          interpreterRealpath: { type: 'string' }, interpreterVersion: { type: 'string' },
        } },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => {
        if (value.status !== 'supported') {
          const disposition: JsonValue = { contextGuardDisposition: { status: value.status, reasonCode: value.reason_code } }
          return disposition
        }
        const meta: JsonValue = { contextGuard: {
          adapterId: value.adapter_id, adapterVersion: value.adapter_version,
          semanticAction: value.semantic_action, evidenceRole: value.evidence_role,
          resolvedTarget: value.resolved_target,
          targetDigest: value.target_digest,
          commandManifestDigest: value.command_manifest_digest,
          ...(value.expected_transition ? {
            expectedTransition: value.expected_transition,
            expectedTransitionDigest: value.expected_transition_digest,
          } : {}),
          ...(value.git_binding ? { gitBinding: value.git_binding } : {}),
          ...(value.executable_identity ? { executableIdentity: value.executable_identity } : {}),
          ...(value.evidence_role === 'state' ? { observedState: value.observed_state } : {}),
        } }
        return meta
      },
    },
    async execute(args, exec) {
      const action = args.semantic_action as StatefulAction
      const role = args.evidence_role as EvidenceRole
      if (!(SUPPORTED as readonly string[]).includes(action)) return unavailable(action, role, 'adapter_unavailable_for_pinned_host')
      if (roots.hostCapability?.(action).status !== 'supported' && roots.hostCapability) {
        return unavailable(action, role, 'host_capability_unavailable')
      }
      const agent = exec.agent
      if (!agent) return unavailable(action, role, 'producer_agent_unavailable')
      try {
        if (role === 'resolution') {
          const executable = executableFor(action)
          const executableBinding = executable
            ? await (roots.readExecutableIdentity ?? executableIdentity)(executable, exec.signal)
            : undefined
          if (executable && !executableBinding) return unavailable(action, role, 'executable_identity_unavailable')
          const resolved = await resolveTarget(
            action,
            record(args.selector) ?? {},
            record(args.command_manifest) ?? {},
            cwdOf(agent),
            roots,
            exec.signal,
            executableBinding,
          )
          if (!resolved) return unavailable(action, role, 'resolution_unavailable')
          const gitBinding = resolved.gitBinding
            ? JSON.parse(JSON.stringify(resolved.gitBinding)) as Record<string, JsonValue>
            : undefined
          const commandManifest = record(args.command_manifest) ?? {}
          const expectedTransition = await expectedTransitionForResolution(action, resolved.target, commandManifest)
          if (!expectedTransition) return unavailable(action, role, 'expected_transition_unavailable')
          return supported(action, role, resolved.target, {}, commandManifest, gitBinding, executableBinding, expectedTransition)
        }
        if (!args.resolution_call_id) return unavailable(action, role, 'producer_reference_missing')
        const resolution = findResolution(agent.session.events, args.resolution_call_id, action)
        if (!resolution) return unavailable(action, role, 'persisted_effect_mismatch')
        const executable = executableFor(action)
        let currentExecutable: ExecutableIdentity | undefined
        if (executable) {
          currentExecutable = await (roots.readExecutableIdentity ?? executableIdentity)(executable, exec.signal)
          if (bindExecutableIdentity(resolution.executableIdentity, currentExecutable).status !== 'supported') {
            return unavailable(action, role, 'executable_identity_drift')
          }
        }
        const ownedEffect = ['install', 'apply', 'restart', 'publish', 'commit', 'push', 'pull', 'fetch'].includes(action)
        if (!args.effect_call_id) return unavailable(action, role, 'producer_reference_missing')
        if (ownedEffect) {
          const actionCall = actionCallMatches(agent.session.events, args.effect_call_id, action, args.resolution_call_id, resolution.target)
          const completed = action === 'restart'
            ? actionCall && restartIntent(agent.session.events, args.resolution_call_id, resolution.target)
              && (await marketCapabilities(roots, exec.signal))?.bootId !== resolution.target.pre_generation
            : actionCall && actionResultCompleted(agent.session.events, args.effect_call_id)
          if (!completed) {
            return unavailable(action, role, 'persisted_effect_mismatch')
          }
          if (role === 'effect') return supported(action, role, resolution.target, {}, resolution.commandManifest, undefined, currentExecutable)
        } else {
          const effect = findEffect(agent.session.events, args.effect_call_id)
          if (!effect || !effectMatches(action, resolution, effect)) return unavailable(action, role, 'persisted_effect_mismatch')
          if (role === 'effect') return supported(action, role, resolution.target, {}, resolution.commandManifest, undefined, currentExecutable)
        }
        const observed = await readback(action, resolution.target, roots, exec.signal, currentExecutable)
        return observed ? supported(action, role, resolution.target, observed, resolution.commandManifest, undefined, currentExecutable) : unavailable(action, role, 'independent_readback_unavailable')
      } catch {
        return unavailable(action, role, 'adapter_readback_failed')
      }
    },
  })
}
