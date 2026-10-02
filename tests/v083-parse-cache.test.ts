import { expect, it } from 'vitest'
import { ParseCache } from '../src/domain/parse-cache.js'
import { segmentClauses } from '../src/domain/capture.js'
import { maskCodeSpans, maskQuotedSpans } from '../src/domain/semantics.js'
import { segmentClauses as oracleSegments } from './helpers/baseline-oracle/capture.js'

it('evicts only the oldest entries and enforces both storage budgets', () => {
  const cache = new ParseCache<string>(600, 3)
  for (let i = 0; i < 10; i++) cache.set(String(i), 'x', 2)
  expect(cache.storage().entries).toBe(3)
  expect(cache.get('8')).toBe('x')
  expect(cache.get('7')).toBe('x')
  expect(cache.get('6')).toBeUndefined()
  const before = cache.storage()
  cache.set('oversize', 'x', 601)
  expect(cache.storage()).toEqual(before)
  cache.set('9', 'xx', 4)
  expect(cache.storage().entries).toBe(3)
  expect(cache.storage().bytes).toBeLessThanOrEqual(600)
})

it('callers cannot contaminate cached clause arrays or nested records', () => {
  const text = '修改 src/app.ts 并运行测试。禁止推送 main 分支。'
  const expected = oracleSegments(text)
  const a = segmentClauses(text)
  a[0]!.paths.push('injected')
  a[0]!.interpretation.qualification.status = 'executable_now' as never
  a[0]!.interpretation.body = 'injected'
  a[0]!.body = 'injected'
  a.reverse(); a.pop()
  expect(segmentClauses(text)).toEqual(expected)
  const b = segmentClauses(text)
  expect(b).not.toBe(segmentClauses(text))
  expect(b[0]!.interpretation.qualification).not.toBe(segmentClauses(text)[0]!.interpretation.qualification)
})

it('nondefault, nonenumerable and getter options retain uncached semantics', () => {
  const text = '修改 src/app.ts 并运行测试。'
  segmentClauses(text)
  for (const options of [Object.freeze({ coordinationSplit: false }),
    Object.defineProperty({}, 'coordinationSplit', { value: false }),
    Object.defineProperty({}, 'coordinationSplit', { get: () => false }),
    Object.create({ coordinationSplit: false }),
    Object.create(Object.defineProperty({}, 'coordinationSplit', { get: () => false }))]) {
    // Frozen oracle has an unsafe default-only cache for nonenumerable keys;
    // use a fresh enumerable option to obtain its actual parser result.
    expect(segmentClauses(text, options)).toEqual(oracleSegments(text, { coordinationSplit: false }))
  }
  const mutable = { coordinationSplit: false }
  expect(segmentClauses(text, mutable)).toEqual(oracleSegments(text, { coordinationSplit: false }))
  mutable.coordinationSplit = true
  expect(segmentClauses(text, mutable)).toEqual(oracleSegments(text, { coordinationSplit: true }))
  expect(segmentClauses(text, Object.freeze({}))).toEqual(oracleSegments(text, { coordinationSplit: true }))
})

it('crosses old 64/4096 cliffs without whole-cache clearing or semantic drift', () => {
  for (let i = 0; i < 4200; i++) {
    const text = `Run test ${i}. Do not push "tag ${i}" or \`commit ${i}\`.`
    expect(maskCodeSpans(text).length).toBe(text.length)
    expect(maskQuotedSpans(text).length).toBe(text.length)
    expect(segmentClauses(text)).toEqual(oracleSegments(text))
  }
})

it('protects reused parses through an over-capacity scan of one-use fragments', () => {
  const cache = new ParseCache<string>(1600, 10)
  cache.set('hot', 'preserved', 20)
  expect(cache.get('hot')).toBe('preserved')
  for (let i = 0; i < 200; i++) cache.set(`fragment${i}`, 'one-use', 20)
  expect(cache.get('hot')).toBe('preserved')
  expect(cache.storage().bytes).toBeLessThanOrEqual(1600)
  expect(cache.storage().entries).toBeLessThanOrEqual(10)
  // A larger recurring hot set also remains bounded: promotion demotes the
  // oldest hot entries rather than retaining them forever.
  for (let i = 0; i < 200; i++) {
    cache.set(`hot${i}`, 'reused', 20)
    cache.get(`hot${i}`)
  }
  expect(cache.storage().bytes).toBeLessThanOrEqual(1600)
  expect(cache.storage().entries).toBeLessThanOrEqual(10)
  expect(cache.get('hot')).toBeUndefined()
})
