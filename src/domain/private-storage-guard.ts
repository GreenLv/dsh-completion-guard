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
export function privateStorageToolDenial(name: string, args: unknown, cwd: string,
  roots: readonly string[]): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const a = args as Record<string, unknown>
  const protectedRoots = roots.map(root => { try { return physical(root) } catch { return resolve(root) } })
  const privatePath = (path: string): boolean => {
    try { return protectedRoots.some(root => contained(root, physical(resolve(cwd, path)))) }
    catch { return roots.some(root => contained(resolve(root), resolve(cwd, path))) }
  }
  if (['write', 'edit', 'read', 'read_image'].includes(name) && typeof a.file_path === 'string' && privatePath(a.file_path)) {
    return '[activation_private_storage_protected] Guard private storage is operator-owned; use the independent inspect/adopt/verify entrypoint.'
  }
  if (['bash', 'pwsh'].includes(name)) {
    const command = typeof a.command === 'string' ? a.command : ''
    const working = typeof a.cwd === 'string' ? a.cwd : cwd
    if (privatePath(working) || roots.some(root => command.includes(root) || command.includes(root.replaceAll('\\', '/')))
      || /(?:completion-guard[/\\]|activation-bindings-v1|dsh-completion-guard-activation)/u.test(command)) {
      return '[activation_private_storage_protected] Shell access to Guard private storage requires the independent operator entrypoint.'
    }
  }
  return undefined
}
