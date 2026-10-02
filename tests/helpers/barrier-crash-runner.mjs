// Pause the production runner at an exact barrier-publication syscall boundary.
import fs from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { syncBuiltinESMExports } from 'node:module'

const [, , runner, root, stage] = process.argv
const originalOpen = fs.openSync
const originalWrite = fs.writeSync
const originalLink = fs.linkSync
const paths = new Map()
let firstPendingWrite = true
function pause() {
  fs.writeFileSync(join(root, 'paused'), JSON.stringify({ stage, pid: process.pid }))
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
}
fs.openSync = function (...args) {
  const fd = originalOpen(...args)
  paths.set(fd, String(args[0]))
  return fd
}
fs.writeSync = function (...args) {
  if (firstPendingWrite && basename(paths.get(args[0]) ?? '').startsWith('pending.')) {
    firstPendingWrite = false
    if (stage === 'before-write') pause()
    if (stage === 'partial-write') {
      originalWrite(args[0], args[1], args[2], 10, args[4])
      pause()
    }
  }
  return originalWrite(...args)
}
fs.linkSync = function (...args) {
  if (stage === 'before-link') pause()
  const result = originalLink(...args)
  if (stage === 'after-link') pause()
  return result
}
syncBuiltinESMExports()
process.argv = [process.execPath, runner, root, 's2-checkpoint']
await import(pathToFileURL(runner).href)
