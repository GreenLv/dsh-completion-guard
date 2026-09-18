type Spec = Record<string, unknown>

function validate(value: unknown, schema: Spec, path: string): void {
  if (Array.isArray(schema.anyOf)) {
    for (const option of schema.anyOf) {
      try { validate(value, option as Spec, path); return } catch { /* next branch */ }
    }
    throw new Error(`${path}: no_matching_schema`)
  }
  if ('const' in schema && value !== schema.const) throw new Error(`${path}: wrong_constant`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new Error(`${path}: unknown_enum`)
  const kinds = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type]
  const matches = (kind: unknown): boolean => {
    switch (kind) {
      case 'null': return value === null
      case 'boolean': return typeof value === 'boolean'
      case 'integer': return typeof value === 'number' && Number.isSafeInteger(value)
      case 'string': return typeof value === 'string'
      case 'array': return Array.isArray(value)
      case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
      default: return false
    }
  }
  if (kinds.length && !kinds.some(matches)) throw new Error(`${path}: wrong_type`)
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const fields = (schema.properties ?? {}) as Record<string, Spec>
    const row = value as Record<string, unknown>
    if (schema.additionalProperties === false && Object.keys(row).some((key) => !(key in fields))) throw new Error(`${path}: unknown_fields`)
    if (Array.isArray(schema.required) && schema.required.some((key) => !(key in row))) throw new Error(`${path}: missing_fields`)
    for (const [key, child] of Object.entries(row)) if (key in fields) validate(child, fields[key]!, `${path}.${key}`)
  } else if (Array.isArray(value) && schema.items) {
    for (const child of value) validate(child, schema.items as Spec, `${path}[]`)
  } else if (typeof value === 'string') {
    if (value.length < (schema.minLength as number ?? 0) || (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value))) throw new Error(`${path}: invalid_string`)
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i)
      if (c >= 0xd800 && c <= 0xdbff) { if (!(value.charCodeAt(++i) >= 0xdc00 && value.charCodeAt(i) <= 0xdfff)) throw new Error(`${path}: invalid_string`) }
      else if (c >= 0xdc00 && c <= 0xdfff) throw new Error(`${path}: invalid_string`)
    }
  } else if (typeof value === 'number') {
    if ((typeof schema.minimum === 'number' && value < schema.minimum) || (typeof schema.maximum === 'number' && value > schema.maximum)) throw new Error(`${path}: number_out_of_range`)
  }
}

/** Validate the frozen core observation schema without adding a JSON Schema runtime dependency. */
export function validateCoreSnapshot(value: unknown, schema: Spec): void { validate(value, schema, '$') }
