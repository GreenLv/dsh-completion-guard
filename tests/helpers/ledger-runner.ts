// CG-083-R2 multi-process fixture: a standalone runner that performs real
// appends against a ledger root under real process contention. Bundled to a
// temp .mjs by the concurrency test and executed as child processes.
import { appendPrivateLedger } from '../../src/domain/private-ledger.js'
import { writeFileSync } from 'node:fs'
import type { PrivateLedgerContext } from '../../src/domain/private-ledger.js'

const [, , root, label] = process.argv
const context: PrivateLedgerContext = {
  sessionId: 'lock-race-session',
  sessionHeader: { id: 'lock-race-session', version: 4 },
  cwd: '/work', hostLockDigest: 'digest',
}
const outcome = { label, succeeded: 0, refused: 0 }
for (let index = 0; index < 5; index += 1) {
  const ok = appendPrivateLedger(root, context, 'restart_intent',
    { resolutionCallId: `${label}-${index}`, serviceId: 's', preGeneration: 'g' })
  if (ok) outcome.succeeded += 1
  else outcome.refused += 1
}
writeFileSync(`${root}/result-${label}.json`, JSON.stringify(outcome))
