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
    Object.defineProperty({}, 'coordinationSplit', { get: () => false })]) {
    // Frozen oracle has an unsafe default-only cache for nonenumerable keys;
    // use a fresh enumerable option to obtain its actual parser result.
    expect(segmentClauses(text, options)).toEqual(oracleSegments(text, { coordinationSplit: false }))
  }
})

it('crosses old 64/4096 cliffs without whole-cache clearing or semantic drift', () => {
  for (let i = 0; i < 4200; i++) {
    const text = `Run test ${i}. Do not push "tag ${i}" or \`commit ${i}\`.`
    expect(maskCodeSpans(text).length).toBe(text.length)
    expect(maskQuotedSpans(text).length).toBe(text.length)
    expect(segmentClauses(text)).toEqual(oracleSegments(text))
  }
})
