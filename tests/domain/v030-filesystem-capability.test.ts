import type { Context } from '@deepseek-ai/cordis'
import { apply as applyFilesystemTools } from '@deepseek-ai/dsh-tool-fs'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { sha256 } from '../../src/domain/canonicalize.js'
import { deriveProjection } from '../../src/domain/derive.js'
import { evidenceFromPersistedToolResult } from '../../src/domain/evidence.js'
import {
  BASE_HOST_PACKAGES,
  EXPECTED_HOST_PACKAGES,
  HOST_CAPABILITY_PACKAGE_GROUPS,
  evaluateHostLock,
} from '../../src/domain/host-lock.js'

function rows(...names: Iterable<string>[]) {
  const selected = new Set([...names].flatMap((values) => [...values]))
  return EXPECTED_HOST_PACKAGES.filter((row) => selected.has(row.name))
}

function hostWith(...groups: Array<keyof typeof HOST_CAPABILITY_PACKAGE_GROUPS>) {
  return evaluateHostLock(rows(
    BASE_HOST_PACKAGES,
    ...groups.map((group) => HOST_CAPABILITY_PACKAGE_GROUPS[group]),
  ), { platform: 'posix', profileKind: 'headless' })
}

function toolEvents(name: string, args: Record<string, unknown>, meta: Record<string, unknown> = {}) {
  return [
    { seq: 0, type: 'command/run', data: { name: 'context-guard', args: 'on', source: { kind: 'user' } } },
    { seq: 1, type: 'tool/call', data: { callId: 'call-1', name, arguments: JSON.stringify(args) } },
    { seq: 2, type: 'tool/result', data: {
      message: { role: 'user', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: 'ok' }] },
      meta,
    } },
  ]
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

describe('v0.3 pinned filesystem tool capability', () => {
  it('reads the real pinned read/write/edit schemas, canonical outputs, and presentation shapes', () => {
    const registered: ToolDefinition[] = []
    const context = {
      systemPrompt: { section: () => undefined },
      tools: { register: (tool: ToolDefinition) => { registered.push(tool) } },
      fs: { sandboxMode: 'workspace-write' },
      inject: () => undefined,
      get: (name: string) => name === 'sandboxPolicy'
        ? { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/bounded-workspace' }) }
        : undefined,
    } as unknown as Context
    applyFilesystemTools(context, {
      readLimit: 2_000,
      readMaxLineLength: 2_000,
      readMaxBytes: 50 * 1_024,
      readStreamMinSize: 256 * 1_024,
    })

    expect(registered.map((tool) => tool.name)).toEqual(['read', 'write', 'edit'])
    const read = registered.find((tool) => tool.name === 'read')!
    const write = registered.find((tool) => tool.name === 'write')!
    const edit = registered.find((tool) => tool.name === 'edit')!
    expect(read.parameters).toMatchObject({ required: ['file_path'] })
    expect(write.parameters).toMatchObject({
      required: ['file_path', 'content'],
      properties: { sandbox_permissions: { enum: ['workspace-write', 'danger-full-access'] } },
    })
    expect(edit.parameters).toMatchObject({
      required: ['file_path', 'old_string', 'new_string'],
      properties: { replace_all: { type: 'boolean' } },
    })
    expect(read.output.schema).toMatchObject({ additionalProperties: false, required: ['path', 'offset', 'lines', 'totalLines'] })
    expect(write.output.schema).toMatchObject({ additionalProperties: false, required: ['path', 'operation', 'before', 'after'] })
    expect(edit.output.schema).toMatchObject({ additionalProperties: false, required: ['path', 'before', 'after'] })
    expect(read.output.presentationMeta?.({}, {
      path: '/bounded-workspace/a.txt', offset: 1, lines: [{ number: 1, text: 'a' }], totalLines: 1,
    })).toMatchObject({ path: '/bounded-workspace/a.txt', lines: [{ number: 1, text: 'a' }] })
    expect(write.output.presentationMeta?.({ file_path: 'a.txt' }, {
      path: '/bounded-workspace/a.txt', operation: 'create', before: null, after: 'a',
    })).toEqual({ diffs: [] })
    expect(edit.output.presentationMeta?.({ file_path: 'a.txt' }, {
      path: '/bounded-workspace/a.txt', before: 'old', after: 'new',
    })).toEqual({ diffs: [{ path: 'a.txt', oldText: 'old', newText: 'new' }] })
  })

  it('fails ordinary filesystem replay closed under a base-only lock and opens only with the full filesystem group', () => {
    const baseOnly = evaluateHostLock(rows(BASE_HOST_PACKAGES), { platform: 'posix', profileKind: 'headless' })
    const missing = deriveProjection(toolEvents('write', { file_path: 'a.txt', content: 'a' }),
      { activation: 'opt-in' }, { cwd: '/bounded-workspace' }, true, baseOnly).projection.evidence.get('E0001')!
    expect(missing).toMatchObject({
      parseStatus: 'adapter_unavailable',
      reasonCode: 'host_filesystem_capability_missing',
      outcome: 'unknown',
      capabilities: [],
    })

    const filesystem = hostWith('agent_loop', 'filesystem')
    const supported = deriveProjection(toolEvents('write', { file_path: 'a.txt', content: 'a' }),
      { activation: 'opt-in' }, { cwd: '/bounded-workspace' }, true, filesystem).projection.evidence.get('E0001')!
    expect(supported).toMatchObject({
      parseStatus: 'supported', outcome: 'success', capabilities: ['filesystem-write'],
      semanticAction: 'create', resolvedTarget: { artifact_id: '/bounded-workspace/a.txt', scope: '/bounded-workspace' },
    })
  })

  it('gates bash/pwsh by the active platform while leaving an independent capability usable', () => {
    const posix = hostWith('agent_loop', 'terminal_posix')
    const bash = deriveProjection(toolEvents('bash', { command: 'pnpm test', workdir: '/bounded-workspace' }),
      { activation: 'opt-in' }, { cwd: '/bounded-workspace' }, true, posix).projection.evidence.get('E0001')!
    expect(bash).toMatchObject({ parseStatus: 'supported', outcome: 'success', capabilities: ['shell', 'deterministic-check'] })

    const wrongPlatform = deriveProjection(toolEvents('pwsh', { command: 'pnpm test', workdir: '/bounded-workspace' }),
      { activation: 'opt-in' }, { cwd: '/bounded-workspace' }, true, posix).projection.evidence.get('E0001')!
    expect(wrongPlatform).toMatchObject({
      parseStatus: 'adapter_unavailable', reasonCode: 'host_tool_platform_mismatch', outcome: 'unknown', capabilities: [],
    })

    const baseOnly = evaluateHostLock(rows(BASE_HOST_PACKAGES), { platform: 'posix', profileKind: 'headless' })
    const missingTerminal = deriveProjection(toolEvents('bash', { command: 'pnpm test', workdir: '/bounded-workspace' }),
      { activation: 'opt-in' }, { cwd: '/bounded-workspace' }, true, baseOnly).projection.evidence.get('E0001')!
    expect(missingTerminal).toMatchObject({
      parseStatus: 'adapter_unavailable', reasonCode: 'host_terminal_capability_missing', outcome: 'unknown', capabilities: [],
    })

    const windows = evaluateHostLock(rows(
      BASE_HOST_PACKAGES,
      HOST_CAPABILITY_PACKAGE_GROUPS.agent_loop,
      HOST_CAPABILITY_PACKAGE_GROUPS.terminal_windows,
    ), { platform: 'windows', profileKind: 'headless' })
    const pwsh = deriveProjection(toolEvents('pwsh', { command: 'pnpm test', workdir: 'C:\\bounded-workspace' }),
      { activation: 'opt-in' }, { cwd: 'C:\\bounded-workspace' }, true, windows).projection.evidence.get('E0001')!
    const wrongWindowsTool = deriveProjection(toolEvents('bash', { command: 'pnpm test', workdir: 'C:\\bounded-workspace' }),
      { activation: 'opt-in' }, { cwd: 'C:\\bounded-workspace' }, true, windows).projection.evidence.get('E0001')!
    expect(pwsh).toMatchObject({ parseStatus: 'supported', outcome: 'success' })
    expect(wrongWindowsTool).toMatchObject({
      parseStatus: 'adapter_unavailable', reasonCode: 'host_tool_platform_mismatch', outcome: 'unknown', capabilities: [],
    })

    const filesystemDrift = evaluateHostLock([
      ...posix.packages,
      ...rows(HOST_CAPABILITY_PACKAGE_GROUPS.filesystem).map((row) => row.name === '@deepseek-ai/dsh-fs-sandbox'
        ? { ...row, version: '0.1.1-rc.3' }
        : row),
    ], { platform: 'posix', profileKind: 'headless' })
    const stillBash = deriveProjection(toolEvents('bash', { command: 'pnpm test', workdir: '/bounded-workspace' }),
      { activation: 'opt-in' }, { cwd: '/bounded-workspace' }, true, filesystemDrift).projection.evidence.get('E0001')!
    const blockedWrite = deriveProjection(toolEvents('edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' }),
      { activation: 'opt-in' }, { cwd: '/bounded-workspace' }, true, filesystemDrift).projection.evidence.get('E0001')!
    expect(stillBash).toMatchObject({ parseStatus: 'supported', outcome: 'success' })
    expect(blockedWrite).toMatchObject({
      parseStatus: 'adapter_unavailable', reasonCode: 'host_filesystem_capability_version_mismatch', outcome: 'unknown',
    })
  })

  it('preserves only a valid inline v1 expected transition from the Guard-owned evidence producer', () => {
    const expectedTransition = {
      predicateId: 'pred.create.v1', version: 1, predParamsKind: 'inline' as const,
      parameters: { post_digest: 'aa'.repeat(32) },
    }
    const expectedTransitionDigest = sha256(stable(expectedTransition))
    const fact = evidenceFromPersistedToolResult({
      callId: 'resolution-1', name: 'context_guard_evidence', arguments: JSON.stringify({ semantic_action: 'create', evidence_role: 'resolution' }),
    }, {
      seq: 1, textContent: 'bounded', meta: { contextGuard: {
        adapterId: 'context-guard.artifact.v1', adapterVersion: '1.0.0', semanticAction: 'create', evidenceRole: 'resolution',
        resolvedTarget: { artifact_id: '/bounded-workspace/a.txt', scope: '/bounded-workspace' },
        expectedTransition, expectedTransitionDigest,
      } },
    }, 1, 'E0001')
    expect(fact).toMatchObject({ expectedTransition, expectedTransitionDigest })

    const forged = evidenceFromPersistedToolResult({
      callId: 'ordinary-write', name: 'write', arguments: JSON.stringify({ file_path: 'a.txt', content: 'a' }),
    }, {
      seq: 2, textContent: 'bounded', meta: { expectedTransition, expectedTransitionDigest },
    }, 1, 'E0002')
    expect(forged.expectedTransition).toBeUndefined()
    expect(forged.expectedTransitionDigest).toBeUndefined()
  })
})
