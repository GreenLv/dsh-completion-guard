import { describe, expect, it } from 'vitest'
import { desktopInstallationLocation } from '../src/domain/host-desktop-graph.js'

describe('Desktop pnpm installation locations', () => {
  it.each([
    ['node_modules/guard', 'guard', 'guard'],
    ['node_modules\\guard', 'guard', 'guard'],
    ['node_modules\\@deepseek-ai\\dsh-session', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session'],
    ['node_modules/@deepseek-ai\\dsh-session', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session'],
    ['node_modules\\guard\\node_modules\\@deepseek-ai\\dsh-session', '@deepseek-ai/dsh-session', 'guard/node_modules/@deepseek-ai/dsh-session'],
    ['node_modules\\guard/node_modules/@deepseek-ai\\dsh-session', '@deepseek-ai/dsh-session', 'guard/node_modules/@deepseek-ai/dsh-session'],
  ])('canonicalizes a relative Windows location %s', (path, name, id) => {
    expect(desktopInstallationLocation(path, name, 'win32')).toBe(id)
  })

  it('keeps POSIX backslashes invalid and Windows equivalent spellings identical', () => {
    expect(() => desktopInstallationLocation('node_modules\\guard', 'guard', 'darwin')).toThrow(/location invalid/)
    expect(() => desktopInstallationLocation('node_modules\\guard', 'guard', 'linux')).toThrow(/location invalid/)
    expect(desktopInstallationLocation('node_modules/guard', 'guard', 'win32'))
      .toBe(desktopInstallationLocation('node_modules\\guard', 'guard', 'win32'))
  })

  it.each([
    null, 1, '', 'guard', '/node_modules/guard', 'C:\\node_modules\\guard',
    '\\\\server\\share\\node_modules\\guard', 'node_modules/../guard',
    'node_modules\\..\\guard', 'node_modules/./guard', 'node_modules//guard',
    'node_modules/guard/', 'node_modules/@scope/../guard', 'node_modules/guard/extra',
    'node_modules/other', 'node_modules/guard/node_modules/../guard',
  ])('rejects absolute, escaping, malformed or wrong-identity location %j', (path) => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(() => desktopInstallationLocation(path, 'guard', platform)).toThrow(/location invalid/)
    }
  })
})
