// CG-083-F1 multi-process fixture: a standalone runner that contends for the
// generation-protocol writer lock under REAL parallelism. Bundled to a .mjs
// by the concurrency test and executed as child processes. Args:
//   <root> <label> [start-barrier]
// With a barrier path the child blocks until the barrier file disappears.
// The label "suicide" acquires the lock, prints a marker, then SIGKILLs its
// own process without cleanup (crash-while-holding).
import { appendPrivateLedger } from '../../src/domain/private-ledger.js'
import { writeFileSync, existsSync } from 'node:fs'
import type { PrivateLedgerContext } from '../../src/domain/private-ledger.js'

const [, , rootArg, labelArg, barrierArg] = process.argv
const root = rootArg as string
const label = labelArg as string

const context: PrivateLedgerContext = {
  sessionId: 'lock-race-session',
  sessionHeader: { id: 'lock-race-session', version: 4 },
  cwd: '/work', hostLockDigest: 'digest',
}

function waitBarrier(): void {
  if (!barrierArg) return
  const deadline = Date.now() + 60_000
  while (existsSync(barrierArg)) {
    if (Date.now() > deadline) process.exit(3)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
}

if (label === 'v2compat') {
  // S3 direction 1: behave like the 0.8.2 (v2) writer — O_EXCL on the root
  // .writer.lock; EEXIST means a v3 holder (or anyone) is present → refuse.
  waitBarrier()
  const { openSync, writeSync, closeSync, unlinkSync } = await import('node:fs')
  let fd: number
  try {
    fd = openSync(`${root}/.writer.lock`, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      process.stdout.write(JSON.stringify({ refused: true }))
      process.exit(0)
    }
    throw error
  }
  try { writeSync(fd, JSON.stringify({ version: 2, nonce: 'v'.repeat(32), pid: process.pid, hostname: '', created_at_epoch_ms: Date.now() }) + '\n') } finally { closeSync(fd) }
  const ok = appendPrivateLedger(root, context, 'restart_intent', {
    resolutionCallId: 'v2compat-1', serviceId: 's', preGeneration: 'g',
  })
  unlinkSync(`${root}/.writer.lock`)
  process.stdout.write(JSON.stringify({ refused: false, appended: ok }))
  process.exit(0)
}
if (label === 'slowappend') {
  // Recovery race fixture: HOLD the lock (via the production acquire path)
  // until the parent removes the barrier file, so the parent can run its
  // stale-admission attempt against a genuinely live holder.
  const internals = (await import('../../src/domain/private-ledger.js')).__writerLockInternals
  const held = internals.acquire(root)
  if (!held) {
    process.stdout.write(JSON.stringify({ appended: false }))
    process.exit(0)
  }
  process.stdout.write(JSON.stringify({ appended: true, holding: true }))
  const deadline = Date.now() + 30_000
  while (existsSync(`${root}/start-barrier`) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
  internals.release(root, held)
  process.exit(0)
}
if (label === 'repeat') {
  // Back-to-back appends so the parent can catch the process INSIDE the
  // critical section (the lock file exists) and SIGKILL it there.
  waitBarrier()
  let appended = 0
  for (let index = 0; index < 500; index += 1) {
    const ok = appendPrivateLedger(root, context, 'restart_intent', {
      resolutionCallId: `repeat-${index}`, serviceId: 's', preGeneration: 'g',
    })
    if (ok) appended += 1
  }
  process.stdout.write(JSON.stringify({ appended, done: true }))
  process.exit(0)
} else {
  waitBarrier()
  const outcome = { label, succeeded: 0, refused: 0 }
  for (let index = 0; index < 5; index += 1) {
    const ok = appendPrivateLedger(root, context, 'restart_intent', {
      resolutionCallId: `${label}-${index}`, serviceId: 's', preGeneration: 'g',
    })
    if (ok) outcome.succeeded += 1
    else outcome.refused += 1
  }
  writeFileSync(`${root}/result-${label}.json`, JSON.stringify(outcome))
  process.stdout.write(JSON.stringify(outcome))
}
