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

if (label === 'slowappend') {
  // Recovery race fixture: append once and hold the slot briefly so the
  // parent can run its delayed finalize against the live holder.
  const ok = appendPrivateLedger(root, context, 'restart_intent', {
    resolutionCallId: 'slowappend-1', serviceId: 's', preGeneration: 'g',
  })
  if (!ok) {
    process.stdout.write(JSON.stringify({ appended: false }))
    process.exit(0)
  }
  // Hold until the parent removes the barrier file OR a safety timeout.
  process.stdout.write(JSON.stringify({ appended: true, holding: true }))
  const deadline = Date.now() + 30_000
  while (existsSync(`${root}/start-barrier`) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
  process.exit(0)
}
if (label === 'slowpending') {
  // Deterministic L2: create a pending candidate (phase 1, no authority),
  // pause on the barrier while the parent takes the slot, then attempt the
  // link (phase 2) — it must fail EEXIST and the candidate must refuse.
  const internals = (await import('../../src/domain/private-ledger.js')).__writerLockInternals
  const nonce = 'b'.repeat(32)
  internals.prepareCandidate(root, nonce)
  waitBarrier()
  const linked = internals.linkCandidate(root, nonce)
  const slot = internals.readSlot(root)
  process.stdout.write(JSON.stringify({
    linked,
    refused: linked === 'eexist',
    holderIsParent: slot !== 'legacy' && slot !== undefined,
  }))
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
