import type { TargetTuple } from './types.js'

export const STOP_PROTOCOL_VERSION = '2.0.0'
export const CERTIFICATE_VERSION = '1'
export const ACTION_MANIFEST_VERSION = 1

export const SUPPORTED_EVIDENCE_ADAPTERS: Readonly<Record<string, string>> = {
  'context-guard.git.v1': '1.0.0',
  'context-guard.package.v1': '1.0.0',
  'context-guard.artifact.v1': '1.0.0',
  'context-guard.service.v1': '1.0.0',
  'context-guard.registry.v1': '1.0.0',
}

export const SEMANTIC_ACTIONS = [
  'inspect_remote_updates', 'install', 'apply', 'create', 'modify',
  'test', 'verify', 'pull', 'fetch', 'commit', 'push', 'restart',
  'publish', 'generic_run',
] as const

export type SemanticAction = (typeof SEMANTIC_ACTIONS)[number]

export type StatefulAction = 'install' | 'apply' | 'create' | 'modify' | 'restart' | 'commit' | 'push' | 'publish' | 'pull' | 'fetch'

export const STATEFUL_ACTIONS: readonly StatefulAction[] = [
  'install', 'apply', 'create', 'modify', 'restart',
  'commit', 'push', 'publish', 'pull', 'fetch',
]

export interface ActionSpec {
  stateful: boolean
  evidenceProducer: 'supported' | 'unavailable'
  resolvedTargetKeys: string[]
  observedStateKeys: string[]
  predicateId: string
  commandManifestIds: string[]
}

export interface ActionManifest {
  version: number
  actions: Record<SemanticAction, ActionSpec>
  compatibility: Record<SemanticAction, SemanticAction[]>
}

export const ACTION_MANIFEST: ActionManifest = {
  version: ACTION_MANIFEST_VERSION,
  actions: {
    inspect_remote_updates: {
      stateful: false,
      evidenceProducer: 'supported',
      resolvedTargetKeys: ['repository', 'version', 'remote'],
      observedStateKeys: ['upstream_oid'],
      predicateId: 'pred.inspect_remote_updates.v1',
      commandManifestIds: ['git.ls_remote_exact.v2'],
    },
    install: {
      stateful: true,
      evidenceProducer: 'supported',
      resolvedTargetKeys: ['package_id', 'version', 'integrity_digest', 'profile'],
      observedStateKeys: ['package_id', 'version', 'integrity_digest', 'profile'],
      predicateId: 'pred.install.v1',
      commandManifestIds: ['dsh.plugin_add_tgz.install.v1'],
    },
    apply: {
      stateful: true,
      evidenceProducer: 'supported',
      resolvedTargetKeys: ['package_id', 'version', 'integrity_digest', 'profile'],
      observedStateKeys: ['package_id', 'version', 'integrity_digest', 'profile'],
      predicateId: 'pred.apply.v1',
      commandManifestIds: ['dsh.plugin_add_tgz.apply.v1'],
    },
    create: {
      stateful: true,
      evidenceProducer: 'supported',
      resolvedTargetKeys: ['artifact_id', 'scope', 'pre_digest', 'change_set_digest'],
      observedStateKeys: ['post_digest'],
      predicateId: 'pred.create.v1',
      commandManifestIds: ['artifact.create.v1'],
    },
    modify: {
      stateful: true,
      evidenceProducer: 'supported',
      resolvedTargetKeys: ['artifact_id', 'scope', 'pre_digest', 'change_set_digest'],
      observedStateKeys: ['post_digest'],
      predicateId: 'pred.modify.v1',
      commandManifestIds: ['artifact.modify.v1'],
    },
    test: {
      stateful: false,
      evidenceProducer: 'supported',
      resolvedTargetKeys: ['scope', 'executable'],
      observedStateKeys: [],
      predicateId: 'pred.test.outcome',
      commandManifestIds: ['python.unittest.v1', 'package.test.v1', 'test.runner.v1'],
    },
    verify: {
      stateful: false,
      evidenceProducer: 'supported',
      resolvedTargetKeys: ['scope'],
      observedStateKeys: [],
      predicateId: 'pred.verify.outcome',
      commandManifestIds: ['deterministic.verify.v1'],
    },
    pull: {
      stateful: true,
      evidenceProducer: 'supported',
      resolvedTargetKeys: ['repository', 'remote', 'refspec', 'upstream_oid', 'pre_head_oid', 'pull_mode'],
      observedStateKeys: ['post_head_oid', 'tracking_ref_oid'],
      predicateId: 'pred.pull.v1',
      commandManifestIds: ['git.pull_ff_only_explicit.v2'],
    },
    fetch: {
      stateful: true,
      evidenceProducer: 'supported',
      resolvedTargetKeys: ['repository', 'remote', 'refspec', 'upstream_oid', 'pre_head_oid'],
      observedStateKeys: ['tracking_ref_oid', 'post_head_oid'],
      predicateId: 'pred.fetch.v1',
      commandManifestIds: ['git.fetch_tracking_explicit.v2'],
    },
    commit: {
      stateful: true,
      evidenceProducer: 'supported',
      resolvedTargetKeys: ['repository', 'branch', 'change_set_digest', 'pre_head_oid'],
      observedStateKeys: ['post_head_oid', 'pre_head_oid'],
      predicateId: 'pred.commit.v1',
      commandManifestIds: ['git.commit_index_tree.v2'],
    },
    push: {
      stateful: true,
      evidenceProducer: 'supported',
      resolvedTargetKeys: ['repository', 'remote', 'refspec', 'local_oid'],
      observedStateKeys: ['remote_oid'],
      predicateId: 'pred.push.v1',
      commandManifestIds: ['git.push_explicit_refs.v2'],
    },
    restart: {
      stateful: true,
      evidenceProducer: 'supported',
      resolvedTargetKeys: ['service_id', 'pre_generation'],
      observedStateKeys: ['new_generation', 'health'],
      predicateId: 'pred.restart.v1',
      commandManifestIds: ['dshmarket.restart.v1'],
    },
    publish: {
      stateful: true,
      evidenceProducer: 'supported',
      resolvedTargetKeys: ['artifact_id', 'version', 'registry', 'integrity_digest'],
      observedStateKeys: ['artifact_id', 'version', 'registry', 'integrity_digest'],
      predicateId: 'pred.publish.v1',
      commandManifestIds: ['npm.publish_tgz.v1'],
    },
    generic_run: {
      stateful: false,
      evidenceProducer: 'supported',
      resolvedTargetKeys: ['scope', 'executable'],
      observedStateKeys: [],
      predicateId: 'pred.generic_run.outcome',
      commandManifestIds: ['generic.run.v1'],
    },
  },
  compatibility: {
    inspect_remote_updates: ['inspect_remote_updates'],
    install: ['install'], apply: ['apply'], create: ['create'], modify: ['modify'],
    test: ['test', 'verify'], verify: ['verify', 'test'], pull: ['pull'], fetch: ['fetch'],
    commit: ['commit'], push: ['push'], restart: ['restart'], publish: ['publish'],
    generic_run: ['generic_run'],
  },
}

const ORDERED_TEXT_RULES: Array<[SemanticAction, RegExp]> = [
  ['inspect_remote_updates', /检查.{0,12}(?:远端|上游).{0,8}(?:更新|版本)|inspect.{0,12}(?:remote|upstream).{0,8}(?:update|version)/i],
  ['test', /python(?:3)?\s+-m\s+(?:unittest|pytest|doctest)|\b(?:pnpm|npm|yarn|bun)\s+(?:test|tst)\b|\b(?:pytest|vitest|jest)\b/i],
  ['install', /安装|\binstall\b|\bplugin\s+(?:add|install)\b/i],
  ['apply', /应用|\bapply\b/i],
  ['create', /创建|新建|生成|\bcreat(?:e|es|ed|ing)\b/i],
  ['modify', /修改|编辑|更改|\bmodif(?:y|ies|ied|ying)\b|\bedit\b/i],
  ['pull', /拉取|\bgit\s+pull\b|\bpull\b/i],
  ['fetch', /抓取|\bgit\s+fetch\b|\bfetch\b/i],
  ['commit', /提交|\bgit\s+commit\b|\bcommit\b/i],
  ['push', /推送|\bgit\s+push\b|\bpush\b/i],
  ['restart', /重启|重新启动|\brestart\b|\breload\b/i],
  ['publish', /发布|\bpublish\b|\brelease\b/i],
  ['verify', /验证|确认|确保|\bverif(?:y|ies|ied|ying)\b|\bconfirm\b/i],
]

export function semanticActionFromText(text: string): SemanticAction {
  if (/^\s*(?:验证|确认|确保|verif(?:y|ies|ied|ying)\b|confirm\b)/i.test(text)) return 'verify'
  for (const [action, pattern] of ORDERED_TEXT_RULES) {
    if (pattern.test(text)) return action
  }
  return 'generic_run'
}

export function semanticActionFromCommand(command: string): SemanticAction {
  const normalized = command.trim().replace(/\s+/g, ' ')
  if (/\bpython(?:3)?\s+-m\s+(?:unittest|pytest|doctest)\b|\b(?:pnpm|npm|yarn|bun)\s+(?:test|tst)\b|^(?:pytest|vitest|jest)\b/i.test(normalized)) return 'test'
  if (/^git\s+pull(?:\s|$)/i.test(normalized)) return 'pull'
  if (/^git\s+fetch(?:\s|$)/i.test(normalized)) return 'fetch'
  if (/^git\s+commit(?:\s|$)/i.test(normalized)) return 'commit'
  if (/^git\s+push(?:\s|$)/i.test(normalized)) return 'push'
  if (/^dsh\s+plugin\b.*\sadd(?:\s|$)/i.test(normalized) || /^(?:pnpm|npm|yarn|bun)\s+(?:install|add)(?:\s|$)/i.test(normalized)) return 'install'
  if (/^dsh\b.*\b(?:restart|reload)\b/i.test(normalized)) return 'restart'
  if (/^(?:pnpm|npm|yarn|bun)\s+publish(?:\s|$)/i.test(normalized)) return 'publish'
  return 'generic_run'
}

export function isStatefulAction(action: SemanticAction): action is StatefulAction {
  return (STATEFUL_ACTIONS as readonly string[]).includes(action)
}

export function actionCompatible(required: SemanticAction, observed: SemanticAction): boolean {
  return ACTION_MANIFEST.compatibility[required].includes(observed)
}

function hasExactKeys(tuple: TargetTuple | undefined, required: readonly string[]): boolean {
  if (!tuple) return required.length === 0
  const keys = Object.keys(tuple)
  return keys.length === required.length
    && required.every((key) => Object.hasOwn(tuple, key))
}

export function validateActionTarget(action: SemanticAction, resolved: TargetTuple | undefined, observed: TargetTuple | undefined): boolean {
  const spec = ACTION_MANIFEST.actions[action]
  return hasExactKeys(resolved, spec.resolvedTargetKeys) && hasExactKeys(observed, spec.observedStateKeys)
}

const REQUESTED_IDENTITY_KEY: Readonly<Partial<Record<SemanticAction, string>>> = {
  install: 'package_id', apply: 'package_id', create: 'artifact_id', modify: 'artifact_id',
  pull: 'repository', fetch: 'repository', commit: 'repository', push: 'repository',
  restart: 'service_id', publish: 'artifact_id',
}

function stableTargetValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableTargetValue).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableTargetValue(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Compare identities captured from the root instruction with a complete
 * adapter-resolved target. Requested targets are partial by design: only
 * explicitly named identities (plus the active repository scope) are frozen.
 */
export function requestedTargetMatchesResolved(
  action: StatefulAction,
  requested: TargetTuple | undefined,
  resolved: TargetTuple | undefined,
): boolean {
  const identityKey = REQUESTED_IDENTITY_KEY[action]
  if (!identityKey || !requested || !resolved || !Object.hasOwn(requested, identityKey)) return false
  const allowed = new Set(ACTION_MANIFEST.actions[action].resolvedTargetKeys)
  return Object.entries(requested).every(([key, value]) => (
    allowed.has(key)
    && Object.hasOwn(resolved, key)
    && stableTargetValue(value) === stableTargetValue(resolved[key])
  ))
}

const MUTATION_AUTHORITY_KEYS: Readonly<Record<StatefulAction, readonly string[]>> = {
  install: ['package_id', 'version', 'profile'],
  apply: ['package_id', 'version', 'profile'],
  create: ['artifact_id', 'scope'],
  modify: ['artifact_id', 'scope'],
  restart: ['service_id'],
  commit: ['repository', 'branch'],
  push: ['repository', 'remote', 'refspec'],
  publish: ['artifact_id', 'version', 'registry'],
  pull: ['repository', 'remote', 'refspec'],
  fetch: ['repository', 'remote', 'refspec'],
}

/** A mutation requires every user-selectable identity field, not a partial match. */
export function requestedTargetAuthorizesMutation(
  action: StatefulAction,
  requested: TargetTuple | undefined,
  resolved: TargetTuple | undefined,
): boolean {
  const required = MUTATION_AUTHORITY_KEYS[action]
  return !!requested
    && required.every((key) => Object.hasOwn(requested, key))
    && requestedTargetMatchesResolved(action, requested, resolved)
}

export function validateActionManifest(): string[] {
  const issues: string[] = []
  if (Object.keys(ACTION_MANIFEST.actions).length !== SEMANTIC_ACTIONS.length) issues.push('action set mismatch')
  for (const action of SEMANTIC_ACTIONS) {
    const spec = ACTION_MANIFEST.actions[action]
    if (!spec) { issues.push(`missing action ${action}`); continue }
    if (!spec.predicateId || !spec.commandManifestIds.length) issues.push(`incomplete action ${action}`)
    if (isStatefulAction(action) && (!spec.stateful || !spec.resolvedTargetKeys.length || !spec.observedStateKeys.length)) {
      issues.push(`stateful action ${action} lacks closure keys`)
    }
  }
  return issues
}
