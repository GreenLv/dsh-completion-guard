import type { CwdEpoch, DerivedEnvelope } from './types.js'

/** The 0.2.1 durable working-directory transition event type. */
export const WORKING_DIRECTORY_CHANGE_EVENT = 'working-directory/change'

/** Absolute directory identities; preserve spelling and case, never normalize a bound path. */
export function isAbsoluteWorkingDirectory(value: unknown, base?: string): value is string {
  if (typeof value !== 'string' || !value || value.includes('\0')) return false
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  // Windows UNC needs both a server and share. Device namespaces are not UNC.
  if (value.startsWith('//') && base?.startsWith('/') && !base.startsWith('//')) return true
  if (value.startsWith('\\\\') || value.startsWith('//')) {
    const unc = /^(?:\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)(?:[\\/].*)?$/.exec(value)
    return !!unc && [unc[1]!, unc[2]!].every((part) => !['.', '..', '?'].includes(part) && !/[<>:"|?*]/.test(part))
  }
  const windowsBase = !!base && (/^[A-Za-z]:/.test(base) || base.startsWith('\\\\') || base.startsWith('//'))
  return !windowsBase && value.startsWith('/')
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/**
 * Build the cwd epoch timeline of one log. The header cwd governs from the
 * start; every VALID `working-directory/change` replaces the effective
 * directory from its sequence on. Returns `undefined` when any change event
 * carries a shape this reader cannot interpret (non-string, empty, or
 * non-absolute cwd): callers must fail closed on that marker instead of
 * guessing an epoch boundary — derive records the corruption, the workdir
 * observer emits no receipt under it.
 *
 * Duplicates are collapsed exactly like the host service commits them: a
 * change to the directory that is already effective adds no epoch, because a
 * re-derivation of the same log must not manufacture boundary identity.
 */
export function cwdEpochsFromEvents(events: readonly DerivedEnvelope[], headerCwd: string | undefined): CwdEpoch[] | undefined {
  if (typeof headerCwd !== 'string' || headerCwd.length === 0) return undefined
  const epochs: CwdEpoch[] = []
  let current = headerCwd
  for (const event of events) {
    if (event.type !== WORKING_DIRECTORY_CHANGE_EVENT) continue
    const cwd = asRecord(event.data)?.cwd
    if (!isAbsoluteWorkingDirectory(cwd, headerCwd)) return undefined
    if (cwd === current) continue
    epochs.push({ seq: event.seq, cwd })
    current = cwd
  }
  return epochs
}

/** The effective cwd at one sequence of the timeline's own log. */
export function effectiveCwdAt(epochs: readonly CwdEpoch[] | undefined, headerCwd: string | undefined, seq: number): string | undefined {
  if (typeof headerCwd !== 'string' || headerCwd.length === 0) return undefined
  let cwd = headerCwd
  for (const epoch of epochs ?? []) {
    if (epoch.seq > seq) break
    cwd = epoch.cwd
  }
  return cwd
}
