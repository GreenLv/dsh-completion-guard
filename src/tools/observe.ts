import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { snapshotSessionEvents } from '../domain/session-events.js'
import { canonicalArgvFromCommand } from '../domain/shell-parse.js'
import { extractTextContent } from '../domain/evidence.js'
import type { GuardProjection } from '../domain/types.js'

const execFileAsync = promisify(execFile)

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined

/** Read-only, post-effect file observer. The path comes from a persisted native edit call. */
export function createNativeFileObserver(host: {
  flush?: (session: unknown) => Promise<boolean>
  fs?: {
    resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<{ displayPath: string; targetKey?: unknown }>
    processPath?(target: unknown): string
    contains?(parent: unknown, child: unknown): boolean
    stat(target: unknown, signal?: AbortSignal): Promise<{ type: string; version: unknown; size?: number } | undefined>
    readText(target: unknown, signal?: AbortSignal): Promise<string>
  }
}): ToolDefinition {
  return defineTool({
    name: 'context_guard_observe_file',
    description: 'Read back the exact UTF-8 file after an already persisted native write or edit. This tool does not modify files or authorize the edit.',
    parameters: { effect_call_id: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', required: true, enum: ['observed','unavailable'] },
        reason_code: { type: 'string', required: true },
        effect_call_id: { type: 'string', required: true },
        path: { type: 'string', required: true },
        sha256: { type: 'string', required: true },
        action: { type: 'string', required: true, enum: ['create','modify','unknown'] },
        canonical_path: { type: 'string' }, canonical_base: { type: 'string' },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value): JsonValue => value.status === 'observed'
        ? { contextGuardNativeFile: { effectCallId: value.effect_call_id, path: value.path, sha256: value.sha256, action: value.action,
          ...(value.canonical_path ? { canonicalPath: value.canonical_path } : {}),
          ...(value.canonical_base ? { canonicalBase: value.canonical_base } : {}) } }
        : { contextGuardNativeFileUnavailable: { reasonCode: value.reason_code } },
    },
    async execute(args, exec) {
      const missing = (reason: string) => ({ status: 'unavailable' as const, reason_code: reason, effect_call_id: args.effect_call_id, path: '', sha256: '', action: 'unknown' as const })
      const agent = exec.agent
      if (!agent || !host.fs || !host.flush) return missing('host_fs_unavailable')
      if (!await host.flush(agent.session)) return missing('native_effect_not_durable')
      let call: RecordValue | undefined
      let result: RecordValue | undefined
      let callSeq = -1
      let resultSeq = -1
      let duplicate = false
      for (const raw of snapshotSessionEvents(agent.session)) {
        const event = record(raw)
        const data = record(event?.data)
        if (event?.type === 'tool/call' && data?.callId === args.effect_call_id) {
          if (call) duplicate = true
          call = data; callSeq = Number(event.seq)
        }
        if (event?.type === 'tool/result' && record(record(data?.message)?.source)?.callId === args.effect_call_id) {
          if (result) duplicate = true
          result = data; resultSeq = Number(event.seq)
        }
      }
      if (!call || !result || duplicate || callSeq >= resultSeq || call.turn !== result.turn || call.step !== result.step
        || !['write','write_file','edit','edit_file'].includes(String(call.name))) return missing('native_effect_missing')
      const message = record(result.message)
      const source = record(message?.source)
      if (source?.kind !== 'tool' || source.callId !== args.effect_call_id) return missing('native_effect_missing')
      if (result.error !== undefined || (Array.isArray(message?.content) && message.content.some((block) => record(block)?.isError === true))) return missing('native_effect_failed')
      let effectArgs: RecordValue | undefined
      try { effectArgs = record(JSON.parse(String(call.arguments))) } catch { return missing('native_effect_arguments_invalid') }
      const filePath = effectArgs?.file_path
      if (typeof filePath !== 'string' || !filePath) return missing('native_effect_target_missing')
      const action = String(call.name).startsWith('write') ? 'create' as const : 'modify' as const
      const cwd = record((agent.session as { header?: unknown }).header)?.cwd
      try {
        const target = await host.fs.resolve(filePath, { ...(typeof cwd === 'string' ? { cwd } : {}), signal: exec.signal })
        const before = await host.fs.stat(target, exec.signal)
        if (!before || before.type !== 'file' || (before.size !== undefined && before.size > 20_000_000)) return missing('native_file_readback_unavailable')
        const content = await host.fs.readText(target, exec.signal)
        const after = await host.fs.stat(target, exec.signal)
        if (!after || after.type !== 'file' || before.version !== after.version) return missing('native_file_readback_raced')
        let canonicalPath: string | undefined
        let canonicalBase: string | undefined
        if (typeof cwd === 'string' && host.fs.processPath && host.fs.contains) {
          const base = await host.fs.resolve(cwd, { signal: exec.signal })
          const path = host.fs.processPath(target)
          const root = host.fs.processPath(base)
          if (host.fs.contains(base, target) && path.startsWith('/') && root.startsWith('/')) {
            canonicalPath = path; canonicalBase = root
          }
        }
        return { status: 'observed' as const, reason_code: 'file_state_observed', effect_call_id: args.effect_call_id,
          path: target.displayPath, sha256: createHash('sha256').update(content, 'utf8').digest('hex'), action,
          ...(canonicalPath && canonicalBase ? { canonical_path: canonicalPath, canonical_base: canonicalBase } : {}) }
      } catch { return missing('native_file_readback_unavailable') }
    },
  })
}

/** Fixed-argv Git readback for a persisted native shell commit/push result. */
export function createNativeGitObserver(host: { flush?: (session: unknown) => Promise<boolean> }): ToolDefinition {
  return defineTool({
    name: 'context_guard_observe_git',
    description: 'Read back a repository after a persisted native Git command; performs only fixed Git queries.',
    parameters: { effect_call_id: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', required: true, enum: ['observed', 'unavailable'] }, reason_code: { type: 'string', required: true },
        effect_call_id: { type: 'string', required: true }, action: { type: 'string', required: true, enum: ['commit', 'push', 'unknown'] },
        repository: { type: 'string', required: true }, branch: { type: 'string', required: true },
        remote: { type: 'string', required: true }, refspec: { type: 'string', required: true },
        post_oid: { type: 'string', required: true }, parent_oid: { type: 'string', required: true }, tree_oid: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value): JsonValue => value.status === 'observed'
        ? { contextGuardNativeGit: { effectCallId: value.effect_call_id, action: value.action, repository: value.repository,
          branch: value.branch, remote: value.remote, refspec: value.refspec, postOid: value.post_oid,
          parentOid: value.parent_oid, treeOid: value.tree_oid } }
        : { contextGuardNativeGitUnavailable: { reasonCode: value.reason_code } },
    },
    async execute(args, exec) {
      const missing = (reason: string) => ({ status: 'unavailable' as const, reason_code: reason, effect_call_id: args.effect_call_id,
        action: 'unknown' as const, repository: '', branch: '', remote: '', refspec: '', post_oid: '', parent_oid: '', tree_oid: '' })
      const session = exec.agent?.session
      if (!session || !host.flush || !await host.flush(session)) return missing('native_effect_not_durable')
      let call: RecordValue | undefined; let result: RecordValue | undefined; let callSeq = -1; let resultSeq = -1; let duplicate = false
      for (const raw of snapshotSessionEvents(session)) {
        const event = record(raw); const data = record(event?.data)
        if (event?.type === 'tool/call' && data?.callId === args.effect_call_id) {
          if (call) duplicate = true
          call = data; callSeq = Number(event.seq)
        }
        if (event?.type === 'tool/result' && record(record(data?.message)?.source)?.callId === args.effect_call_id) {
          if (result) duplicate = true
          result = data; resultSeq = Number(event.seq)
        }
      }
      if (!call || !result || duplicate || callSeq >= resultSeq || call.turn !== result.turn || call.step !== result.step
        || (call.name !== 'bash' && call.name !== 'pwsh')) return missing('native_effect_missing')
      const message = record(result.message); const source = record(message?.source)
      if (source?.kind !== 'tool' || source.callId !== args.effect_call_id || result.error !== undefined
        || (Array.isArray(message?.content) && message.content.some((block) => record(block)?.isError === true))) return missing('native_effect_failed')
      let effectArgs: RecordValue | undefined
      try { effectArgs = record(JSON.parse(String(call.arguments))) } catch { return missing('native_effect_arguments_invalid') }
      const command = effectArgs?.command; const repository = effectArgs?.workdir
      if (typeof command !== 'string' || typeof repository !== 'string' || !repository) return missing('native_git_target_missing')
      const parsed = canonicalArgvFromCommand(command, call.name)
      const argv = parsed.argv
      if (parsed.status !== 'supported' || argv[0] !== 'git') return missing('native_git_command_unsupported')
      const action = argv[1]
      if (action !== 'commit' && action !== 'push') return missing('native_git_command_unsupported')
      const gitAction: 'commit' | 'push' = action
      const output = Array.isArray(message?.content) ? extractTextContent(message.content) : ''
      const git = async (...query: string[]) => (await execFileAsync('git', ['-C', repository, ...query], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 })).stdout.trim()
      try {
        const top = await git('rev-parse', '--show-toplevel')
        if (!top || await realpath(top) !== await realpath(repository)) return missing('native_git_repository_mismatch')
        const branch = await git('symbolic-ref', '--short', 'HEAD')
        const postOid = await git('rev-parse', 'HEAD')
        if (!/^[0-9a-f]{40,64}$/.test(postOid)) return missing('native_git_readback_unavailable')
        if (action === 'commit') {
          if (argv.length !== 4 || argv[2] !== '-m' || !argv[3] || !new RegExp(`\\b${postOid.slice(0, 7)}[0-9a-f]*\\b`).test(output)) return missing('native_git_effect_output_unbound')
          const parentOid = await git('rev-parse', 'HEAD^')
          const treeOid = await git('rev-parse', 'HEAD^{tree}')
          return { status: 'observed' as const, reason_code: 'git_commit_observed', effect_call_id: args.effect_call_id,
            action: gitAction, repository: top, branch, remote: '', refspec: '', post_oid: postOid, parent_oid: parentOid, tree_oid: treeOid }
        }
        const remote = argv[2]; const refspec = argv[3]
        if (argv.length !== 4 || !remote || !/^refs\/heads\/[^:]+:refs\/heads\/[^:]+$/.test(refspec)) return missing('native_git_refspec_unsupported')
        const [src, dst] = refspec.split(':')
        const localOid = await git('rev-parse', src!)
        const remoteLine = await git('ls-remote', '--exit-code', remote, dst!)
        const remoteOid = remoteLine.split(/\s+/)[0]
        const destinationName = dst!.slice('refs/heads/'.length)
        const reportedUpdate = output.includes(localOid.slice(0, 7))
          || (output.includes('[new branch]') && output.includes(`-> ${destinationName}`))
        if (remoteOid !== localOid || !reportedUpdate) return missing('native_git_push_readback_mismatch')
        return { status: 'observed' as const, reason_code: 'git_push_observed', effect_call_id: args.effect_call_id,
          action: gitAction, repository: top, branch, remote, refspec, post_oid: remoteOid, parent_oid: '', tree_oid: '' }
      } catch { return missing('native_git_readback_unavailable') }
    },
  })
}

/** Specific package-script readiness, with a stable changed input for an
 * assessment. The observer never executes the script or infers success. */
export function createTestReadinessObserver(host: {
  getProjection: () => GuardProjection | undefined
  flush?: (session: unknown) => Promise<boolean>
  fs?: {
    resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<{ displayPath: string }>
    stat(target: unknown, signal?: AbortSignal): Promise<{ type: string; version: unknown; size?: number } | undefined>
    readText(target: unknown, signal?: AbortSignal): Promise<string>
  }
}): ToolDefinition {
  return defineTool({
    name: 'context_guard_observe_test_readiness',
    description: 'Read a pending test or assessment script and its concrete inputs; never runs the script.',
    parameters: { item_id: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', required: true, enum: ['ready', 'unavailable'] },
        reason_code: { type: 'string', required: true }, item_id: { type: 'string', required: true },
        scope: { type: 'string', required: true }, manifest_sha256: { type: 'string', required: true },
        predicate: { type: 'string', required: true }, script_name: { type: 'string', required: true },
        selected_path: { type: 'string', required: true }, effect_call_id: { type: 'string', required: true },
        input_sha256: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value): JsonValue => value.status === 'ready'
        ? { contextGuardTestReadiness: { itemId: value.item_id, scope: value.scope, manifestSha256: value.manifest_sha256,
          predicate: value.predicate, scriptName: value.script_name, selectedPath: value.selected_path,
          effectCallId: value.effect_call_id, inputSha256: value.input_sha256 } }
        : { contextGuardTestReadinessUnavailable: { reasonCode: value.reason_code } },
    },
    async execute(args, exec) {
      const missing = (reason: string) => ({ status: 'unavailable' as const, reason_code: reason, item_id: args.item_id,
        scope: '', manifest_sha256: '', predicate: '', script_name: '', selected_path: '', effect_call_id: '', input_sha256: '' })
      if (!exec.agent?.session || !host.flush || !host.fs || !await host.flush(exec.agent.session)) return missing('readiness_host_unavailable')
      const projection = host.getProjection()
      const item = projection?.items.get(args.item_id)
      if (!item || item.status !== 'pending' || !['test', 'verify'].includes(item.semanticAction ?? '') || item.authority !== 'root_instruction'
        || item.authorityDisposition !== 'executable_now' || item.legacyFlags?.length || item.waitAuthorization || item.condition
        || typeof item.requestedTarget?.scope !== 'string') return missing('readiness_item_unsupported')
      const scope = item.requestedTarget.scope
      const assessment = item.semanticAction === 'verify'
      const scriptName = assessment && /(?:吞吐|性能|时延|延迟|throughput|performance|latency)/iu.test(item.normalizedText) ? 'benchmark' : 'test'
      let selectedPath = '', effectCallId = '', inputSha256 = ''
      if (assessment) {
        const unitStart = item.unitId ? projection?.units.get(item.unitId)?.openedAtSeq : undefined
        if (unitStart === undefined) return missing('assessment_unit_unavailable')
        const changes = [...(projection?.evidence.values() ?? [])].filter((fact) => fact.epoch === projection?.epoch
          && fact.toolResultSeq >= unitStart && fact.outcome === 'success' && fact.parseStatus === 'supported'
          && fact.semanticAction === 'modify' && fact.evidenceRole === 'effect')
          .flatMap((fact) => (fact.operations ?? []).filter((op) => op.op === 'modify' && typeof op.path === 'string')
            .map((op) => ({ path: op.path!, callId: fact.callId })))
        const paths = [...new Set(changes.map((change) => change.path))]
        if (paths.length > 1) return missing('assessment_input_ambiguous')
        if (paths.length === 1) {
          const change = changes.find((entry) => entry.path === paths[0])!
          selectedPath = change.path; effectCallId = change.callId
          try {
            const changed = await host.fs.resolve(selectedPath, { signal: exec.signal })
            const before = await host.fs.stat(changed, exec.signal)
            if (!before || before.type !== 'file' || (before.size !== undefined && before.size > 20_000_000)) return missing('assessment_input_unavailable')
            const raw = await host.fs.readText(changed, exec.signal)
            const after = await host.fs.stat(changed, exec.signal)
            if (!after || after.type !== 'file' || before.version !== after.version) return missing('assessment_input_raced')
            inputSha256 = createHash('sha256').update(raw, 'utf8').digest('hex')
          } catch { return missing('assessment_input_unavailable') }
        }
      }
      try {
        const target = await host.fs.resolve(join(scope, 'package.json'), { signal: exec.signal })
        const before = await host.fs.stat(target, exec.signal)
        if (!before || before.type !== 'file' || (before.size !== undefined && before.size > 2_000_000)) return missing('readiness_manifest_unavailable')
        const raw = await host.fs.readText(target, exec.signal)
        const after = await host.fs.stat(target, exec.signal)
        if (!after || after.type !== 'file' || before.version !== after.version) return missing('readiness_manifest_raced')
        const manifest = record(JSON.parse(raw))
        if (typeof record(manifest?.scripts)?.[scriptName] !== 'string' || !String(record(manifest?.scripts)?.[scriptName]).trim()) return missing('readiness_script_missing')
        if (assessment && !selectedPath) {
          // An existing change may predate this session. A real package script
          // and its stable manifest are themselves sufficient current inputs;
          // requiring a fresh edit would manufacture new business work.
          selectedPath = target.displayPath
          inputSha256 = createHash('sha256').update(raw, 'utf8').digest('hex')
        }
        return { status: 'ready' as const, reason_code: assessment ? 'assessment_inputs_ready' : 'package_test_script_ready', item_id: args.item_id,
          scope, manifest_sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
          predicate: assessment ? 'verification_passed' : 'test_passed', script_name: scriptName,
          selected_path: selectedPath, effect_call_id: effectCallId, input_sha256: inputSha256 }
      } catch { return missing('readiness_manifest_unavailable') }
    },
  })
}
