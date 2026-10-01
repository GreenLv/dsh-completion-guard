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
