import { createHash } from 'node:crypto'
import { parse } from 'acorn'

/** ECMAScript syntax tree identity: ignores source locations, comments and
 * non-semantic Literal spelling, preserves every executable node/value/import/export. */
export function hostProgramDigest(source: string): string {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true })
  const normalized = JSON.stringify(ast, function (this: { type?: string }, key, value: unknown) {
    if ((['start', 'end', 'loc'].includes(key) && typeof this.type === 'string')
      || (key === 'raw' && this.type === 'Literal')) return undefined
    if (typeof value === 'bigint') return { bigint: String(value) }
    return value
  })
  return createHash('sha256').update(normalized).digest('hex')
}
