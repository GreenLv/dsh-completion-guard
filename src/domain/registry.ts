const MAX_REGISTRY_URL_LENGTH = 2048
const ENCODED_SEPARATOR_OR_CONTROL = /%(?:0[0-9a-f]|1[0-9a-f]|7f|2f|5c)/i
const ENCODED_DOT = /%2e/i

export interface RegistryUrlOptions {
  /** Isolated-test seam only; production callers omit this option. */
  allowLoopbackHttp?: boolean
}

function rawPath(value: string): string {
  const authorityStart = value.indexOf('//')
  if (authorityStart < 0) return ''
  const afterAuthority = value.slice(authorityStart + 2)
  const slash = afterAuthority.indexOf('/')
  return slash < 0 ? '' : afterAuthority.slice(slash)
}

function hasControlOrBackslash(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return character === '\\' || code <= 0x1f || code === 0x7f
  })
}

function safePath(path: string): boolean {
  if (!path || path === '/') return true
  if (path.includes('//') || ENCODED_SEPARATOR_OR_CONTROL.test(path) || ENCODED_DOT.test(path)) return false
  const withoutTrailing = path.endsWith('/') ? path.slice(0, -1) : path
  return withoutTrailing.split('/').slice(1).every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

/**
 * Canonical npm registry base. The canonical value is the only value persisted
 * into requested/resolved/state tuples and is reused verbatim for npm argv.
 */
export function canonicalRegistryBase(value: string, options: RegistryUrlOptions = {}): string | undefined {
  if (!value || value.length > MAX_REGISTRY_URL_LENGTH || value !== value.trim()
    || hasControlOrBackslash(value) || !safePath(rawPath(value))) return undefined
  let parsed: URL
  try { parsed = new URL(value) } catch { return undefined }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]'
  if (parsed.protocol !== 'https:' && !(options.allowLoopbackHttp && parsed.protocol === 'http:' && loopback)) return undefined
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.hostname.endsWith('.')) return undefined
  if (!safePath(parsed.pathname)) return undefined
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/`
  return parsed.toString()
}

/** npm's packument route preserves @ and escapes the scope separator. */
export function npmEscapedPackageName(packageId: string): string {
  return encodeURIComponent(packageId).replace(/^%40/i, '@').replace(/%2F/gi, '%2f')
}
