import { createHash } from 'node:crypto'
import { hostLockDigest, type HostLockManifest, type PackageRow } from './digest.js'
import { SEMANTIC_ACTIONS, type SemanticAction } from './protocol-manifest.js'

export type HostLockStatus = 'supported' | 'unsupported' | 'unavailable'
export type HostPlatform = 'posix' | 'windows'
export type HostProfileKind = 'headless' | 'web'

export const SUPPORTED_HOST_MANIFEST: HostLockManifest = {
  manifestVersion: 1,
  supportedGoalVersions: ['0.1.1-rc.2'],
  capabilities: [
    { name: 'goal_complete_precommit_guard', value: { k: 's', v: 'required' } },
    { name: 'goal_disarm_readback', value: { k: 's', v: 'required' } },
    { name: 'session_flush_before_control', value: { k: 's', v: 'required' } },
    { name: 'tool_guard_monotonic', value: { k: 's', v: 'required' } },
    { name: 'host_capability_model', value: { k: 's', v: 'action-platform-v1' } },
    { name: 'external_wait_jobs_readback', value: { k: 's', v: 'dsh.jobs.v1' } },
    { name: 'filesystem_tool_contract', value: { k: 's', v: 'dsh.fs-tools.v1' } },
    ...SEMANTIC_ACTIONS.map((action) => ({ name: 'supported_action', value: { k: 's' as const, v: action } })),
  ],
}

/**
 * Audited package identities. This is a catalogue, not one indivisible lock:
 * evaluateHostLock requires only BASE_HOST_PACKAGES globally and evaluates the
 * remaining action/platform groups independently.
 */
export const EXPECTED_HOST_PACKAGES: PackageRow[] = [
  { name: '@deepseek-ai/cordis', version: '4.0.1', integrity: 'sha512-YBdskTU2Po1kru3GgcUWUbkTsPMA9LkSQDAY8rBkFJeajdgcQad3QPJZE26JyK99Xb6HaASvoXg2DSUTeN/0Nw==' },
  { name: '@deepseek-ai/dsh-agent', version: '0.1.1-rc.2', integrity: 'sha512-cC7lnJe7JgPFcreNXxcxLMxQd78LnpVO9ZXROjZsGRQN1zGH6i/DduI892F1am85IfzzO+XTxMwwUHmfwamb0g==' },
  { name: '@deepseek-ai/dsh-commands', version: '0.1.1-rc.2', integrity: 'sha512-BOIe4Sht9rmMv1a6b3GWjWBbeWr7PtHlAy41vgpaymvUUuzOapOIA648ZMGCI/crRIt72Umev2FHtSwCNSbYZg==' },
  { name: '@deepseek-ai/dsh-goal', version: '0.1.1-rc.2', integrity: 'sha512-lSHTh4vfS6eRb9to/y+bjRf2+0QkNpY3tHJ29HMTewR9fJYZsEVVu4Hc+GPhPEjF7RpiD35/sKx+akijtDasyg==' },
  { name: '@deepseek-ai/dsh-llm', version: '0.1.1-rc.2', integrity: 'sha512-ASJfjIdZbIXvLwi3rGo+eZb/GxMVV/WO5/XVD3B96mT8EIzrlw3+nMR6/CvmJVzcycKQ2XN0wj7jD6TasPRySA==' },
  { name: '@deepseek-ai/dsh-session', version: '0.1.1-rc.2', integrity: 'sha512-4/cv6X9HPhm47eyRhCu/WZwzrtJKegk5J+0xaxcZ9i8S0smdxP57tqy8a0jkSshLQn7BzMFxneQrlYExrLrDhQ==' },
  { name: '@deepseek-ai/dsh-tools', version: '0.1.1-rc.2', integrity: 'sha512-0GGL4D55MwYDepzZMOI3L0ycu5b2qr96GL0Y7snwhAnpK2Di61rbX3fJE+PB3ZrovGX0csIRdt9n3iJZDVtDrw==' },
  { name: '@deepseek-ai/dsh-tool-goal', version: '0.1.1-rc.2', integrity: 'sha512-kTECpE732uwlxRJr/jBZb1BqaxZzrA7Rv4KuM3eolvhoTJ5zjyiR2YHmDmCSfuI6zmA/BEfWss7D0mLbVtJEZA==' },
  { name: '@deepseek-ai/dsh-agent-loop', version: '0.1.1-rc.2', integrity: 'sha512-2uJZ6kjJ3IYLRGn6/NhiZgD576ABcbERB/nkReR9TEUMO2zWkz6OuKtVwLyFCFSni2T25Jv+clKQWt7D4MhU3A==' },
  { name: '@deepseek-ai/dsh-tool-bash', version: '0.1.1-rc.2', integrity: 'sha512-YNmrKmBanj5EQn1zejjbo4UUFtg2/h3s9y0lY3vBu+dezNz4HdUlSkSZACbNUAZywyLomdhlt4rJdtdnrqyS7Q==' },
  { name: '@deepseek-ai/dsh-tool-pwsh', version: '0.1.1-rc.2', integrity: 'sha512-Gr0F4VWCIIR25qWVv4mMEJnewXILHLCkZwrLfbHA2OOI7DNvvdB5wjJxhuo+ZQa8/3KJ/byQGtEBqCY9mb10Zg==' },
  { name: '@deepseek-ai/dsh-shell', version: '0.1.1-rc.2', integrity: 'sha512-gEqPUxKOpOV66wvM4o8Z5FEuWmsEvYzD9OQy3cyo/kjzlx+2+KUWi22cl/YWtBs/zUtRJbdG5UqMnh8GUeO8Hg==' },
  { name: '@deepseek-ai/dsh-subprocess-local', version: '0.1.1-rc.2', integrity: 'sha512-I4pyzpohZEVRQQbuEpMP0t8oKsf+XIlRo64aJVKGXI2eMcg9f9gbfhKQNYNqRGbegQL1HYpSLU6Rzyibldgwaw==' },
  { name: '@deepseek-ai/dsh-bash-sandbox', version: '0.1.1-rc.2', integrity: 'sha512-bagZDMZ73C1dVDBjFCn1flNZ8aOEel4dsmDJTfmagqeYPXfIJDFKPhDc3lWjc+o6jMNfmumeUJ62dwhHkjJHKA==' },
  { name: '@deepseek-ai/dsh-pwsh-sandbox', version: '0.1.1-rc.2', integrity: 'sha512-hBUTg5p8TTQifZrfstbimVlBFyUOb7JhNkWKc+n6UpTzoFRSkPAvrjGeXKDmFI6jXpL4nXzLJoaIssfYnRg7bw==' },
  { name: '@deepseek-ai/dsh-shell-env', version: '0.1.1-rc.2', integrity: 'sha512-dDKKqsxsbklUpxX5ornd/SKJ2yfr/SOHOWDgeJkYvx3SMSXq8EvhCK/VEvHswXQ25rRLFWM4/Mr3htk1hn/GPA==' },
  { name: '@deepseek-ai/dsh', version: '0.1.1-rc.2', integrity: 'sha512-UP1UIh6q3Gme/yXRn/QL2P8IsVlv8Shpg22TRJIZPsCRWLm4CBiA1MUvXmJAfsOEETBMLAl+xWPtFw6ICsN3wg==' },
  { name: '@deepseek-ai/dsh-host-plugin-inventory', version: '0.1.1-rc.2', integrity: 'sha512-Hud9ezW0bexWfhX7C+c5rdUDX1xzbEGDzj1lGQyj/QxdrxHYHjGrJq3tLRyvN6K4FSmEdG2IBKdQGCOLVrIthA==' },
  { name: 'dshmarket', version: '1.36.0', integrity: 'sha512-xX8CCoXdIALaxtLosj+5qGg8r1cykW2zo1AOPJcSQepg2r4Vd2K0NmERldDqfeyFV0pCuZsUoAPe1Q/BW7De/g==' },
  { name: '@deepseek-ai/dsh-host-webserver', version: '0.1.1-rc.2', integrity: 'sha512-t9MrjC65QHiiWhG9V8UZxgfE/aWYhJHHrIM0kbTvtXxg4tLGIKo/upHp7iiag65F3HTkVLrH/DUyPMi4v2ZA7g==' },
  { name: '@deepseek-ai/dsh-web-app', version: '0.1.1-rc.2', integrity: 'sha512-1zGHY7qwBVlVJrzIWu+86SuBZXaVUxe2JRfffsuRvKXq2QcR/K4CoJJfZ43cDoWKu9xPvvxz7w2ezV+EdXgg1A==' },
  { name: '@deepseek-ai/dsh-jobs', version: '0.1.1-rc.2', integrity: 'sha512-SXvDJMvcUrGrlzIyE7j8/lI4Pj1nDe/UOR8C05Zagp+/0R8p46n6KylySvZdPAFENV5t8WX3Fw3eOaS4No0+wQ==' },
  { name: '@deepseek-ai/dsh-jobs-local', version: '0.1.1-rc.2', integrity: 'sha512-26lg7mi9RKnu8IP8SWLbY+uZenbqF2AkAZvgZaLDlw1z58NtBsbgKgh6FNC8JXEyknAwYc6auQQKF+nLTlEjCw==' },
  { name: '@deepseek-ai/dsh-tool-jobs', version: '0.1.1-rc.2', integrity: 'sha512-wCU7mo2uoQcAtz7de4ZXP2es9lALsmz6XzC+KAlS2e7/yTBi9a5LL2vdSr6XhExVAuhu/6f9eM/w4EQBOxtKlw==' },
  { name: '@deepseek-ai/dsh-tool-fs', version: '0.1.1-rc.2', integrity: 'sha512-llX8AWbaI3CGme/a2eeTSfy5atk8u3iJeOFzmZV/KZ0v0hMhKZIK1xQInWwC9OmSDJ/StStJe0hDPVLWbB7hVg==' },
  { name: '@deepseek-ai/dsh-fs', version: '0.1.1-rc.2', integrity: 'sha512-8j+6MffvCHATLQrhAVfc9rKyunKu/O7mjjJzmdsUSdID7V4iUYMwqPamhlAyI+tfohZu/vcforKzCRIZGmCYug==' },
  { name: '@deepseek-ai/dsh-fs-local', version: '0.1.1-rc.2', integrity: 'sha512-jvn1MsAMqCmt5SjRNkPjmpc+RIWrZQrBVtf/OpmKr2PaBEGqSbCkPApWDE9iSMhcuQg6k5evScOXwAsduzKOLA==' },
  { name: '@deepseek-ai/dsh-fs-sandbox', version: '0.1.1-rc.2', integrity: 'sha512-PI65uLZ3ARkfVV/PXvACS1HEXggoOaXgYQzXQFdLOfm7AiHOdZWZccUAXBetpZhcNYIOKsVoLnfZkXcHByqecQ==' },
  { name: '@deepseek-ai/dsh-fs-observation-policy', version: '0.1.1-rc.2', integrity: 'sha512-rlq7yu4xavkKK1Oa1/aNCOeUW7t/3OXJJOfOcZXuUgJn5f8G0AbpTDpp2CeuL1cHlKpbunGhEkKQ2N/dv7ZR9w==' },
  { name: '@deepseek-ai/dsh-sandbox', version: '0.1.1-rc.2', integrity: 'sha512-rnO2RqZ+ycpwrXrXlMcrhWAICdui3ZVTjNQ8eZrOPE18hAbX3tw0nLFq26sBjMSnBfDQHNZ4VaFpt0p8qhkPWQ==' },
  { name: '@deepseek-ai/dsh-sandbox-policy', version: '0.1.1-rc.2', integrity: 'sha512-cpoIUxCzpZJDTMXVt9gS+qgWEDAWf6rIe715uY1NF0ROoiEXPlmToLsHLF+4pXTW3wWWzpGVswO0bPYEKrQr3g==' },
  { name: '@deepseek-ai/dsh-user-approval', version: '0.1.1-rc.2', integrity: 'sha512-SdsO4Rs+NeJFoertkVilXBACREOLfkKPJJznYKqDhJxeRo38RJ56dtj0Xd0/6rERmsQiMck4Bwdrzg1ubUqPNA==' },
  { name: '@deepseek-ai/dsh-attachment', version: '0.1.1-rc.2', integrity: 'sha512-rCYAt8QsawP1yfDCU7XxNwYT/XWvyFsxYrkwhLLkdfW83QVD0CQHizSkTQE7RFX74nKUD1z3sTLfnLr7xneArw==' },
  { name: '@deepseek-ai/dsh-system-prompt', version: '0.1.1-rc.2', integrity: 'sha512-on4hjAlYI5uX9q7Sf95YkMMBVe6heywtA/H50ksrIMUub8U2B98hO9iQpHhjwIO1F1vu+5pLcPvRr6yUGGmtXQ==' },
]

const packageNames = (...names: string[]): ReadonlySet<string> => new Set(names)

export const BASE_HOST_PACKAGES: ReadonlySet<string> = packageNames(
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-tools',
)

export const GOAL_HOST_PACKAGES: ReadonlySet<string> = packageNames('@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-tool-goal')

export type HostCapabilityId =
  | 'agent_loop'
  | 'terminal_posix'
  | 'terminal_windows'
  | 'dsh_cli'
  | 'plugin_inventory'
  | 'web_control'
  | 'jobs'
  | 'filesystem'

export const HOST_CAPABILITY_PACKAGE_GROUPS: Readonly<Record<HostCapabilityId, ReadonlySet<string>>> = {
  agent_loop: packageNames('@deepseek-ai/dsh-agent-loop'),
  terminal_posix: packageNames(
    '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-shell', '@deepseek-ai/dsh-subprocess-local',
    '@deepseek-ai/dsh-bash-sandbox', '@deepseek-ai/dsh-shell-env',
  ),
  terminal_windows: packageNames(
    '@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-shell', '@deepseek-ai/dsh-subprocess-local',
    '@deepseek-ai/dsh-pwsh-sandbox', '@deepseek-ai/dsh-shell-env',
  ),
  dsh_cli: packageNames('@deepseek-ai/dsh'),
  plugin_inventory: packageNames('@deepseek-ai/dsh-host-plugin-inventory'),
  web_control: packageNames('dshmarket', '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-web-app'),
  // `dsh-jobs` owns the lifecycle/status contract, `dsh-jobs-local` is the
  // process-local provider behind ctx.jobs, and `dsh-tool-jobs` attaches the
  // controller without which the pinned registry refuses job admission.
  jobs: packageNames('@deepseek-ai/dsh-jobs', '@deepseek-ai/dsh-jobs-local', '@deepseek-ai/dsh-tool-jobs'),
  // `dsh-tool-fs` owns the exact read/write/edit schemas, results, and
  // presentation surface. The rest of this group is the mounted local,
  // observation, sandbox-policy, and approval chain that decides whether a
  // persisted result denotes the same protected filesystem effect.
  filesystem: packageNames(
    '@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-fs', '@deepseek-ai/dsh-fs-local',
    '@deepseek-ai/dsh-fs-sandbox', '@deepseek-ai/dsh-fs-observation-policy',
    '@deepseek-ai/dsh-sandbox', '@deepseek-ai/dsh-sandbox-policy', '@deepseek-ai/dsh-user-approval',
    '@deepseek-ai/dsh-attachment', '@deepseek-ai/dsh-system-prompt',
  ),
}

export interface HostCapabilityEvaluation {
  id: string
  status: HostLockStatus
  digest: string
  requiredPackages: string[]
  missingPackages: string[]
  reasonCode?:
    | 'host_capability_missing'
    | 'host_capability_version_mismatch'
    | 'host_capability_integrity_mismatch'
    | 'host_capability_duplicate_package'
    | 'host_capability_context_missing'
    | 'host_capability_request_unsupported'
}

export interface HostLockEvaluation {
  status: HostLockStatus
  digest: string
  goalAvailable: boolean
  reasonCode?:
    | 'host_lock_missing'
    | 'host_lock_version_mismatch'
    | 'host_lock_integrity_mismatch'
    | 'host_lock_unknown_package'
    | 'host_lock_duplicate_package'
    | 'host_lock_goal_graph_incomplete'
    | 'host_lock_goal_capability_mismatch'
  packages: PackageRow[]
  capabilities: Record<HostCapabilityId, HostCapabilityEvaluation>
  platform?: HostPlatform
  profileKind?: HostProfileKind
  liveGoalAvailable?: boolean
}

export interface HostLockContext {
  platform?: HostPlatform
  profileKind?: HostProfileKind
  capabilityId?: string
}

function stableRows(rows: readonly PackageRow[]): PackageRow[] {
  return [...rows].map((row) => ({ ...row })).sort((a, b) =>
    a.name.localeCompare(b.name)
      || (a.version ?? '').localeCompare(b.version ?? '')
      || (a.integrity ?? '').localeCompare(b.integrity ?? ''))
}

function statusForPackages(
  id: string,
  rows: readonly PackageRow[],
  requiredNames: ReadonlySet<string>,
): HostCapabilityEvaluation {
  const requiredPackages = [...requiredNames].sort()
  const relevant = rows.filter((row) => requiredNames.has(row.name))
  const counts = new Map<string, number>()
  for (const row of relevant) counts.set(row.name, (counts.get(row.name) ?? 0) + 1)
  const missingPackages = requiredPackages.filter((name) => !counts.has(name))
  const digest = safeHostLockDigest(relevant, { capabilityId: id })
  if ([...counts.values()].some((count) => count > 1)) {
    return { id, status: 'unavailable', digest, requiredPackages, missingPackages, reasonCode: 'host_capability_duplicate_package' }
  }
  if (missingPackages.length > 0) {
    return { id, status: 'unavailable', digest, requiredPackages, missingPackages, reasonCode: 'host_capability_missing' }
  }
  const expected = new Map(EXPECTED_HOST_PACKAGES.map((row) => [row.name, row]))
  for (const row of relevant) {
    const pinned = expected.get(row.name)!
    if (!row.version || !row.integrity) {
      return { id, status: 'unavailable', digest, requiredPackages, missingPackages, reasonCode: 'host_capability_missing' }
    }
    if (row.version !== pinned.version) {
      return { id, status: 'unsupported', digest, requiredPackages, missingPackages, reasonCode: 'host_capability_version_mismatch' }
    }
    if (row.integrity !== pinned.integrity) {
      return { id, status: 'unsupported', digest, requiredPackages, missingPackages, reasonCode: 'host_capability_integrity_mismatch' }
    }
  }
  return { id, status: 'supported', digest, requiredPackages, missingPackages }
}

function capabilityEvaluations(rows: readonly PackageRow[]): Record<HostCapabilityId, HostCapabilityEvaluation> {
  return Object.fromEntries(Object.entries(HOST_CAPABILITY_PACKAGE_GROUPS).map(([id, packages]) => (
    [id, statusForPackages(id, rows, packages)]
  ))) as Record<HostCapabilityId, HostCapabilityEvaluation>
}

export function evaluateHostLock(rows: readonly PackageRow[], context: HostLockContext = {}): HostLockEvaluation {
  const supplied = stableRows(rows)
  const capabilities = capabilityEvaluations(supplied)
  const counts = new Map<string, number>()
  for (const row of supplied) counts.set(row.name, (counts.get(row.name) ?? 0) + 1)
  const goalRows = [...GOAL_HOST_PACKAGES].filter((name) => counts.has(name))
  const goalAvailable = goalRows.length === GOAL_HOST_PACKAGES.size
  const digest = safeHostLockDigest(supplied, context)
  const base = statusForPackages('base', supplied, BASE_HOST_PACKAGES)
  const baseDuplicate = supplied.find((row) => BASE_HOST_PACKAGES.has(row.name) && (counts.get(row.name) ?? 0) > 1)
  const goalDuplicate = supplied.find((row) => GOAL_HOST_PACKAGES.has(row.name) && (counts.get(row.name) ?? 0) > 1)
  const expectedNames = new Set(EXPECTED_HOST_PACKAGES.map((row) => row.name))
  const unknown = supplied.find((row) => !expectedNames.has(row.name))
  const baseResult = {
    digest,
    goalAvailable,
    packages: supplied,
    capabilities,
    ...(context.platform ? { platform: context.platform } : {}),
    ...(context.profileKind ? { profileKind: context.profileKind } : {}),
  }
  if (unknown) return { ...baseResult, status: 'unsupported', reasonCode: 'host_lock_unknown_package' }
  if (baseDuplicate || goalDuplicate) return { ...baseResult, status: 'unavailable', goalAvailable: false, reasonCode: 'host_lock_duplicate_package' }
  if (goalRows.length > 0 && !goalAvailable) {
    return { ...baseResult, status: 'unavailable', goalAvailable: false, reasonCode: 'host_lock_goal_graph_incomplete' }
  }
  if (base.status !== 'supported') {
    const reasonCode = base.reasonCode === 'host_capability_version_mismatch'
      ? 'host_lock_version_mismatch'
      : base.reasonCode === 'host_capability_integrity_mismatch'
        ? 'host_lock_integrity_mismatch'
        : base.reasonCode === 'host_capability_duplicate_package'
          ? 'host_lock_duplicate_package'
          : 'host_lock_missing'
    return { ...baseResult, status: base.status, reasonCode }
  }
  if (goalAvailable) {
    const goal = statusForPackages('goal', supplied, GOAL_HOST_PACKAGES)
    if (goal.status !== 'supported') {
      return {
        ...baseResult,
        status: goal.status,
        goalAvailable: false,
        reasonCode: goal.reasonCode === 'host_capability_version_mismatch'
          ? 'host_lock_version_mismatch'
          : goal.reasonCode === 'host_capability_integrity_mismatch'
            ? 'host_lock_integrity_mismatch'
            : 'host_lock_missing',
      }
    }
  }
  return { ...baseResult, status: 'supported' }
}

const TERMINAL_ACTIONS: ReadonlySet<SemanticAction> = new Set([
  'inspect_remote_updates', 'install', 'apply', 'test', 'verify', 'pull', 'fetch',
  'commit', 'push', 'publish', 'generic_run',
])

export interface HostCapabilityRequest {
  action: SemanticAction
  platform?: HostPlatform
  profileKind?: HostProfileKind
}

/** Evaluate only the packages needed for one effect/readback capability. */
export function evaluateHostCapability(
  evaluation: HostLockEvaluation,
  request: HostCapabilityRequest,
): HostCapabilityEvaluation {
  const platform = request.platform ?? evaluation.platform
  const profileKind = request.profileKind ?? evaluation.profileKind
  const groups: HostCapabilityId[] = ['agent_loop']
  if (TERMINAL_ACTIONS.has(request.action)) {
    if (!platform) {
      return {
        id: `action.${request.action}`,
        status: 'unavailable',
        digest: evaluation.digest,
        requiredPackages: [],
        missingPackages: [],
        reasonCode: 'host_capability_context_missing',
      }
    }
    groups.push(platform === 'windows' ? 'terminal_windows' : 'terminal_posix')
  }
  if (request.action === 'create' || request.action === 'modify') groups.push('filesystem')
  if (request.action === 'install' || request.action === 'apply') groups.push('dsh_cli')
  if (request.action === 'apply') groups.push('plugin_inventory')
  if ((request.action === 'apply' || request.action === 'restart') && profileKind === 'web') groups.push('web_control')
  if (request.action === 'restart' && profileKind !== 'web') {
    return {
      id: 'action.restart',
      status: 'unavailable',
      digest: evaluation.digest,
      requiredPackages: [],
      missingPackages: [],
      reasonCode: profileKind ? 'host_capability_request_unsupported' : 'host_capability_context_missing',
    }
  }
  const required = new Set<string>(BASE_HOST_PACKAGES)
  for (const group of groups) for (const name of HOST_CAPABILITY_PACKAGE_GROUPS[group]) required.add(name)
  const result = statusForPackages(`action.${request.action}.${platform ?? 'native'}.${profileKind ?? 'unknown'}`, evaluation.packages, required)
  if (evaluation.status !== 'supported') {
    return { ...result, status: evaluation.status, digest: evaluation.digest }
  }
  return result
}

/**
 * Bind external_wait qualification and pre-effect requalification to the
 * exact jobs service definition, local provider, and live controller graph.
 * This is deliberately independent of the global/base lock so profiles that
 * do not support background jobs can still use unrelated Guard actions.
 */
export function evaluateExternalWaitCapability(
  evaluation: HostLockEvaluation,
): HostCapabilityEvaluation {
  const required = new Set<string>(BASE_HOST_PACKAGES)
  for (const name of HOST_CAPABILITY_PACKAGE_GROUPS.jobs) required.add(name)
  const result = statusForPackages('boundary.external_wait.jobs', evaluation.packages, required)
  if (evaluation.status !== 'supported') {
    return { ...result, status: evaluation.status, digest: evaluation.digest }
  }
  return result
}

export type HostToolSurface = 'bash' | 'pwsh' | 'filesystem'

/**
 * Gate automatically replayed ordinary tool results by the exact host
 * capability that owns their registration and outcome surface. Tool names are
 * intentionally separate from semantic actions: a `bash` result on Windows,
 * or a `pwsh` result on POSIX, is not evidence from the active host stack.
 */
export function evaluateToolSurfaceCapability(
  evaluation: HostLockEvaluation,
  surface: HostToolSurface,
): HostCapabilityEvaluation {
  const platform = evaluation.platform
  if (surface !== 'filesystem' && !platform) {
    return {
      id: `tool.${surface}.unknown`, status: 'unavailable', digest: evaluation.digest,
      requiredPackages: [], missingPackages: [], reasonCode: 'host_capability_context_missing',
    }
  }
  if ((surface === 'bash' && platform !== 'posix') || (surface === 'pwsh' && platform !== 'windows')) {
    return {
      id: `tool.${surface}.${platform}`, status: 'unsupported', digest: evaluation.digest,
      requiredPackages: [], missingPackages: [], reasonCode: 'host_capability_request_unsupported',
    }
  }
  const groups: HostCapabilityId[] = ['agent_loop']
  if (surface === 'filesystem') groups.push('filesystem')
  if (surface === 'bash') groups.push('terminal_posix')
  if (surface === 'pwsh') groups.push('terminal_windows')
  const required = new Set<string>(BASE_HOST_PACKAGES)
  for (const group of groups) for (const name of HOST_CAPABILITY_PACKAGE_GROUPS[group]) required.add(name)
  const result = statusForPackages(`tool.${surface}.${platform ?? 'native'}`, evaluation.packages, required)
  if (evaluation.status !== 'supported') {
    return { ...result, status: evaluation.status, digest: evaluation.digest }
  }
  return result
}

function safeHostLockDigest(packages: readonly PackageRow[], context: HostLockContext = {}): string {
  try {
    const capabilities = [
      ...(SUPPORTED_HOST_MANIFEST.capabilities ?? []),
      ...(context.platform ? [{ name: 'active_platform', value: { k: 's' as const, v: context.platform } }] : []),
      ...(context.profileKind ? [{ name: 'active_profile', value: { k: 's' as const, v: context.profileKind } }] : []),
      ...(context.capabilityId ? [{ name: 'active_capability', value: { k: 's' as const, v: context.capabilityId } }] : []),
    ]
    return hostLockDigest({ ...SUPPORTED_HOST_MANIFEST, capabilities, packages: [...packages] })
  } catch {
    const bounded = {
      packages: packages.map((row) => [String(row.name), row.version ?? null, row.integrity ?? null]),
      platform: context.platform ?? null,
      profileKind: context.profileKind ?? null,
      capabilityId: context.capabilityId ?? null,
    }
    return createHash('sha256')
      .update('ccg.invalidHostLockDigest.v1\n', 'utf8')
      .update(JSON.stringify(bounded), 'utf8')
      .digest('hex')
  }
}

/** Bind the injected Goal graph to the live Goal service for this agent. */
export function bindLiveGoalCapability(
  evaluation: HostLockEvaluation,
  liveGoalAvailable: boolean,
): HostLockEvaluation {
  if (evaluation.status !== 'supported') return { ...evaluation, liveGoalAvailable }
  if (evaluation.goalAvailable !== liveGoalAvailable) {
    return {
      ...evaluation,
      status: 'unavailable',
      reasonCode: 'host_lock_goal_capability_mismatch',
      liveGoalAvailable,
    }
  }
  return { ...evaluation, liveGoalAvailable }
}

export type AuditedExecutable = 'git' | 'npm' | 'pnpm' | 'dsh'

export interface ExecutableIdentity {
  executable: AuditedExecutable
  realpath: string
  version: string
}

export interface ExecutableIdentityBinding {
  status: HostLockStatus
  digest: string
  identity?: ExecutableIdentity
  reasonCode?: 'executable_identity_missing' | 'executable_realpath_invalid' | 'executable_identity_drift'
}

function executableDigest(identity: ExecutableIdentity | undefined): string {
  return createHash('sha256')
    .update('ccg.executableIdentity.v1\n', 'utf8')
    .update(JSON.stringify(identity ?? null), 'utf8')
    .digest('hex')
}

function validExecutableIdentity(identity: ExecutableIdentity | undefined): identity is ExecutableIdentity {
  if (!identity || !['git', 'npm', 'pnpm', 'dsh'].includes(identity.executable)) return false
  if (!identity.version || /[\r\n\0]/.test(identity.version)) return false
  return (identity.realpath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(identity.realpath))
    && !/[\r\n\0]/.test(identity.realpath)
}

/** Bind resolution and effect to the exact same canonical executable tuple. */
export function bindExecutableIdentity(
  resolution: ExecutableIdentity | undefined,
  effect: ExecutableIdentity | undefined,
): ExecutableIdentityBinding {
  if (!resolution || !effect) {
    return { status: 'unavailable', digest: executableDigest(resolution), reasonCode: 'executable_identity_missing' }
  }
  if (!validExecutableIdentity(resolution) || !validExecutableIdentity(effect)) {
    return { status: 'unavailable', digest: executableDigest(resolution), reasonCode: 'executable_realpath_invalid' }
  }
  if (resolution.executable !== effect.executable
    || resolution.realpath !== effect.realpath
    || resolution.version !== effect.version) {
    return { status: 'unsupported', digest: executableDigest(resolution), reasonCode: 'executable_identity_drift' }
  }
  return { status: 'supported', digest: executableDigest(resolution), identity: { ...resolution } }
}

export const DEFAULT_HOST_LOCK: HostLockEvaluation = evaluateHostLock(
  EXPECTED_HOST_PACKAGES.filter((row) => BASE_HOST_PACKAGES.has(row.name)),
)
