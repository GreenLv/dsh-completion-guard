/** Task-owned UI metadata: strict UTF-8 and complete atomic publication. */
import { readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
export const parseJsonBytes = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
export const readUtf8File = path => new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path))
export const readJsonFile = path => parseJsonBytes(readFileSync(path))
export function writeUtf8Atomic(path, text, options = {}) {
  path = path instanceof URL ? fileURLToPath(path) : path
  if (typeof text !== 'string' || (options.flag !== undefined && options.flag !== 'wx')) throw new TypeError('atomic metadata requires a new UTF-8 text output')
  if (existsSync(path)) throw Object.assign(new Error('output already exists; preserved'), { code: 'EEXIST' })
  const temporary = `${path}.pending-${process.pid}-${randomUUID()}`
  let fd
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, text, { encoding: 'utf8' }); fsyncSync(fd); closeSync(fd); fd = undefined
    if (existsSync(path)) throw Object.assign(new Error('output already exists; preserved'), { code: 'EEXIST' })
    renameSync(temporary, path)
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
