// FROZEN BASELINE ORACLE (CG-083-V1): exact 913a4c7a6f0f600f4146ef4af694d3af6e477ef2 copy of src/domain/host-node-conditions.ts. Do not edit except wholesale replacement.
import { createHash } from 'node:crypto'

export interface HostNodeConditions { require: string[]; import: string[]; childArgs: string[]; requireModule: boolean; digest: string }
/** Node's NODE_OPTIONS lexer is not a shell. Accept its bounded double-quote
 * form; refuse ambiguous escapes/quotes instead of dropping a condition. */
function optionWords(text: string): string[] {
  const words: string[] = []; let word = '', quoted = false, active = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '"') { quoted = !quoted; active = true }
    else if (char === '\\') {
      const next = text[++index]
      if (!quoted || !['"', '\\'].includes(next)) throw new Error('host_route_conditions_unparseable')
      word += next; active = true
    } else if (/\s/.test(char) && !quoted) { if (active) words.push(word); word = ''; active = false }
    else { word += char; active = true }
  }
  if (quoted) throw new Error('host_route_conditions_unparseable')
  if (active) words.push(word)
  return words
}
export function resolveHostNodeConditions(argv: readonly string[], nodeOptions: string, requireModule: boolean): HostNodeConditions {
  const options = [...optionWords(nodeOptions), ...argv]
  const custom = new Set<string>(); let addons = true
  for (let index = 0; index < options.length; index++) {
    const raw = options[index], equals = raw.indexOf('=')
    // Node accepts underscores as hyphens in long option names. Normalize
    // only that name; condition values and following arguments stay exact.
    const name = equals < 0 ? raw : raw.slice(0, equals)
    const value = name.startsWith('--') ? name.replaceAll('_', '-') + (equals < 0 ? '' : raw.slice(equals)) : raw
    if (/^(?:--(?:experimental-)?loader|--import|--require|--(?:experimental-)?policy|--policy-integrity|--preserve-symlinks(?:-main)?|--experimental-default-type|--experimental-config-file|--experimental-specifier-resolution)(?:=|$)/.test(value) || /^-r/.test(value)) throw new Error('host_route_custom_loader_unsupported')
    if (value === '--no-addons') addons = false
    if (value === '--addons') addons = true
    if (value === '--conditions' || value === '-C' || value.startsWith('--conditions=') || value.startsWith('-C=')) {
      const condition = value.includes('=') ? value.slice(value.indexOf('=') + 1) : options[++index]
      if (!condition || condition.includes('\0')) throw new Error('host_route_conditions_unparseable')
      custom.add(condition)
    }
  }
  const common = ['node', ...(addons ? ['node-addons'] : []), ...(requireModule ? ['module-sync'] : []), ...custom]
  const require = [...new Set([...common, 'require', 'default'])].sort()
  const esm = [...new Set([...common, 'import', 'default'])].sort()
  const childArgs = [...(addons ? [] : ['--no-addons']), ...(requireModule ? [] : ['--no-experimental-require-module']), ...[...custom].sort().map((value) => `--conditions=${value}`)]
  return { require, import: esm, childArgs, requireModule, digest: createHash('sha256').update(JSON.stringify({ require, import: esm, requireModule })).digest('hex') }
}
// Capture startup inputs once: later environment edits do not change the
// conditions this Node process already activated. New processes requalify.
const startupArgv = [...process.execArgv]
const startupOptions = process.env.NODE_OPTIONS ?? ''
const startupRequireModule = (process.features as { require_module?: boolean }).require_module === true
export function hostNodeConditions(): HostNodeConditions {
  return resolveHostNodeConditions(startupArgv, startupOptions, startupRequireModule)
}
