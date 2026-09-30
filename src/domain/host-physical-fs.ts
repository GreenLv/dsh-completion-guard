import * as nodeFs from 'node:fs'
import { createRequire } from 'node:module'

/** Host identity reads must see physical files. Electron's ordinary fs turns
 * app.asar into a virtual directory, including guessed stat results. Its
 * built-in original-fs keeps these audits on the same raw bytes as the CLI.
 * Never change process.noAsar: the rest of the host needs archive loading.
 * A missing original-fs in Electron is a failed audit, not a fallback.
 */
export const physicalFs: typeof nodeFs = process.versions.electron
  ? createRequire(import.meta.url)('original-fs') as typeof nodeFs
  : nodeFs
