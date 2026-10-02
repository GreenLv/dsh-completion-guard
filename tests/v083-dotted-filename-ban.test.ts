import { expect, it } from 'vitest'
import { segmentClauses } from '../src/domain/capture.js'

it.each(['Do not modify add.test.cjs.', 'Do not modify add.cjs.', 'without changing add.test.cjs or package.json.', 'Do not modify `add.test.cjs`.'])('keeps the entire dotted-filename prohibition: %s', text => {
  const rows = segmentClauses(text)
  expect(rows).toHaveLength(1)
  expect(rows[0].kind).toBe('prohibition')
  expect(rows[0].text).toContain('add')
  expect(rows[0].text).not.toBe('Do not modify add')
})
it.each(['Do not modify add.cjs; run pnpm test.', 'Do not modify add.test.cjs. Run pnpm test.', 'Fix add.cjs, without changing add.test.cjs or package.json; rerun pnpm test.'])('keeps actual positive actions after the ban: %s', text => {
  const rows = segmentClauses(text)
  const bans = rows.filter(row => row.kind === 'prohibition')
  expect(bans).toHaveLength(1)
  expect(bans[0].text).toContain('.cjs')
  expect(rows.some(row => row.kind === 'requirement' && /(?:run|rerun) pnpm test/i.test(row.text))).toBe(true)
  expect(rows.some(row => row.kind === 'requirement' && /^test\.cjs|^cjs|^json/.test(row.text))).toBe(false)
})
it('ordinary sentence periods still end a prohibition, without losing the constraint', () => {
  expect(segmentClauses('Do not push. Run pnpm test.').map(row => row.kind)).toEqual(['prohibition', 'requirement'])
  expect(segmentClauses('Modify add.test.cjs.')).toHaveLength(1)
})
