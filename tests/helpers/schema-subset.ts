/**
 * A tiny, dependency-free JSON-Schema subset validator for the frozen v2
 * conformance schema (tests/helpers is test-only, so the package payload gains
 * nothing). It supports exactly the keywords the frozen schema uses —
 * `type`, `const`, `enum`, `required`, `properties`, `additionalProperties`,
 * `items`, `minItems`, `minimum`, `pattern`, `oneOf`, plus the ignored
 * documentation keywords `$schema` and `title`. An unsupported keyword is a
 * hard error rather than a silent pass: a fixture validated by a validator
 * that quietly ignored half its schema would not be a frozen-contract check.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

const SUPPORTED_KEYWORDS = new Set([
  '$schema', 'title', 'description',
  'type', 'const', 'enum', 'required', 'properties', 'additionalProperties',
  'propertyNames', 'items', 'minItems', 'minimum', 'minLength', 'pattern', 'oneOf',
])

export interface SchemaValidationError {
  path: string
  keyword: string
  message: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return isRecord(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value)
    case 'number': return typeof value === 'number'
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: throw new Error(`schema-subset: unsupported type ${JSON.stringify(type)}`)
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function validateNode(value: unknown, schema: unknown, path: string, errors: SchemaValidationError[]): void {
  if (!isRecord(schema)) {
    throw new Error(`schema-subset: schema node at ${path} is not an object`)
  }
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(`schema-subset: unsupported keyword ${JSON.stringify(keyword)} at ${path}`)
    }
  }
  const push = (keyword: string, message: string) => errors.push({ path, keyword, message })

  if (typeof schema.type === 'string' && !typeMatches(value, schema.type)) {
    push('type', `expected ${schema.type}, received ${describe(value)}`)
    return
  }
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    push('const', `expected ${JSON.stringify(schema.const)}, received ${JSON.stringify(value)}`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) {
    push('enum', `value ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`)
  }
  if (typeof schema.pattern === 'string' && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    push('pattern', `value ${JSON.stringify(value)} does not match ${schema.pattern}`)
  }
  if (typeof schema.minLength === 'number' && typeof value === 'string' && value.length < schema.minLength) {
    push('minLength', `string length ${value.length} is below ${schema.minLength}`)
  }
  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) {
    push('minimum', `value ${value} is below ${schema.minimum}`)
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => {
      const branchErrors: SchemaValidationError[] = []
      try {
        validateNode(value, branch, path, branchErrors)
      } catch {
        return false
      }
      return branchErrors.length === 0
    })
    if (matches.length !== 1) push('oneOf', `matched ${matches.length} of ${schema.oneOf.length} branches`)
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (typeof name !== 'string' || !Object.hasOwn(value, name)) push('required', `missing required property ${JSON.stringify(name)}`)
      }
    }
    if (isRecord(schema.propertyNames) && typeof schema.propertyNames.pattern === 'string') {
      const pattern = new RegExp(schema.propertyNames.pattern)
      for (const name of Object.keys(value)) {
        if (!pattern.test(name)) push('propertyNames', `property name ${JSON.stringify(name)} does not match ${schema.propertyNames.pattern}`)
      }
    }
    for (const [name, entry] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) {
        validateNode(entry, properties[name], `${path}/${name}`, errors)
        continue
      }
      if (schema.additionalProperties === false) push('additionalProperties', `unexpected property ${JSON.stringify(name)}`)
      else if (isRecord(schema.additionalProperties)) validateNode(entry, schema.additionalProperties, `${path}/${name}`, errors)
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      push('minItems', `expected at least ${schema.minItems} items, received ${value.length}`)
    }
    if (schema.items !== undefined) {
      value.forEach((entry, index) => validateNode(entry, schema.items, `${path}/${index}`, errors))
    }
  }
}

/** Validate `value` against `schema`; returns every violation, in document order. */
export function validateSchemaSubset(value: unknown, schema: unknown): SchemaValidationError[] {
  const errors: SchemaValidationError[] = []
  validateNode(value, schema, '', errors)
  return errors
}

export type { Json }
