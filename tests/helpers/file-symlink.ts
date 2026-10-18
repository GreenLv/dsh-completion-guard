import { symlinkSync, lstatSync, realpathSync } from 'node:fs'
import assert from 'node:assert/strict'
import type { TestContext } from 'vitest'

/** Only a file-link-only case may use this capability boundary. Directory
 * fixtures use real junctions on Windows and do not skip their assertions. */
export function fileSymlinkOrSkip(target: string, link: string, context: TestContext): void {
  try {
    symlinkSync(target, link, 'file')
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      context.skip('Windows file-symlink privilege unavailable; this file-link-only case runs on privileged Windows CI')
      return
    }
    throw error
  }
  assert.ok(lstatSync(link).isSymbolicLink())
  assert.equal(realpathSync(link), realpathSync(target))
}
