import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
function physical(path: string): string {
  let ancestor = resolve(path)
  const tail: string[] = []
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    tail.unshift(ancestor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
    ancestor = parent
  }
  return resolve(realpathSync(ancestor), ...tail)
}
function contained(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
/** Bounded protection for the official file/shell tool surface. This is not
 * a sandbox for arbitrary executables or hostile same-owner plugins. */
export function privateStorageToolDenial(name: string, args: unknown, cwd: string | undefined,
  roots: readonly string[]): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const a = args as Record<string, unknown>
  const protectedRoots = roots.map(root => { try { return physical(root) } catch { return resolve(root) } })
  // A relative target is only decidable against a TRUSTED working directory:
  // the caller-supplied cwd the host would actually use. Without one, the
  // target's identity cannot be proven either way, so it fails closed.
  const privatePath = (path: string, base: string | undefined): boolean | 'unresolved' => {
    if (isAbsolute(path)) {
      try { return protectedRoots.some(root => contained(root, physical(resolve(path)))) }
      catch { return roots.some(root => contained(resolve(root), resolve(path))) }
    }
    if (base === undefined) return 'unresolved'
    try { return protectedRoots.some(root => contained(root, physical(resolve(base, path)))) }
    catch { return roots.some(root => contained(resolve(root), resolve(base, path))) }
  }
  const denial = (detail: string) => `[activation_private_storage_protected] ${detail}`
  if (['write', 'edit', 'read', 'read_image'].includes(name) && typeof a.file_path === 'string') {
    // The official file tools carry no directory argument: a relative path is
    // resolved by the host against its current working directory, which is the
    // caller-provided effective cwd.
    const verdict = privatePath(a.file_path, cwd)
    if (verdict === true) return denial('Guard private storage is operator-owned; use the independent inspect/adopt/verify entrypoint.')
    if (verdict === 'unresolved') return denial('A relative file target cannot be proven outside Guard private storage without a trusted working directory.')
  }
  if (['bash', 'pwsh'].includes(name)) {
    const command = typeof a.command === 'string' ? a.command : ''
    // The official Bash/Pwsh tools take `workdir` (absolute or relative,
    // resolved against the current working directory); a legacy `cwd` field is
    // still honored if a host ever sends one. Omitting both means the host's
    // current working directory itself.
    const declared = typeof a.workdir === 'string' && a.workdir.length > 0 ? a.workdir
      : typeof a.cwd === 'string' && a.cwd.length > 0 ? a.cwd : undefined
    // RF02: with no declared workdir the call runs in the host's current
    // working directory. When that directory cannot be established from a
    // trusted source (no usable cwd, corrupt timeline), the target of the
    // command is UNPROVABLE — refusing is the only closed answer; treating
    // it as "outside private storage" would let an unknown default directory
    // through. An empty-string workdir is ambiguous the same way.
    const working = declared ?? (cwd !== undefined && cwd.length > 0 ? cwd : undefined)
    const workingVerdict = working === undefined ? 'unresolved' as const : privatePath(working, cwd)
    if (workingVerdict === true) return denial('Shell access to Guard private storage requires the independent operator entrypoint.')
    if (workingVerdict === 'unresolved') return denial('A relative shell workdir cannot be proven outside Guard private storage without a trusted working directory.')
    if (roots.some(root => command.includes(root) || command.includes(root.replaceAll('\\', '/')))
      || /(?:completion-guard[/\\]|activation-bindings-v1|dsh-completion-guard-activation)/u.test(command)) {
      return denial('Shell access to Guard private storage requires the independent operator entrypoint.')
    }
  }
  return undefined
}
