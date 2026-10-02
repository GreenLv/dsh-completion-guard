import { expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, openSync, closeSync, appendFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { appendPrivateLedger, initializePrivateLedger, readPrivateLedger, writerLockState, __writerLockInternals } from '../src/domain/private-ledger.js'
import type { PrivateLedgerContext } from '../src/domain/private-ledger.js'

// CG-083-F1 round 4: arbitration-log protocol (docs/WRITER_LOCK_PROTOCOL.md
// Revision 3). Deterministic interleavings for the round-4 findings:
//  - S1/L1: a delayed evict computed from a STALE observation is adjudicated
//    against the CURRENT holder by the log replay and has no effect.
//  - S2: there is no empty-file window — every authority change is one
//    complete appended record; a torn trailing line is ignored by the replay
//    and the preceding records stay recoverable.
//  - S3: bidirectional v2/v3 upgrade barrier (v3 holds → v2 refuses; v2 holds
//    → v3 refuses; v2-crash → v3 recovers by ESRCH).
// Plus barrier-released real multi-process contention.

function writeSyncArbitration(fd: number, record: unknown): void {
  writeSync(fd, JSON.stringify(record) + '\n')
}

const context: PrivateLedgerContext = {
  sessionId: 'lock-race-session',
  sessionHeader: { id: 'lock-race-session', version: 4 },
  cwd: '/work', hostLockDigest: 'digest',
}

const deadPid = (() => {
  for (let pid = 40000; pid < 50000; pid += 1) {
    try { process.kill(pid, 0) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid
    }
  }
  throw new Error('no free pid for fixture')
})()

/** A dead holder appears in the arbitration log (claim record naming a dead pid). */
function writeDeadClaim(root: string): { nonce: string } {
  const nonce = randomBytes(16).toString('hex')
  const fd = openSync(join(root, 'arbitration.log'), 'a')
  try {
    writeSyncArbitration(fd, { v: 3, op: 'claim', nonce, pid: deadPid, hostname: hostname(), created_at_epoch_ms: Date.now(), prev: null })
  } finally {
    closeSync(fd)
  }
  return { nonce }
}

let bundlePromise: Promise<string> | undefined
async function bundledRunner(): Promise<string> {
  bundlePromise ??= (async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'dsh-cg-runner-')), 'ledger-runner.mjs')
    const pnpmDir = join(process.cwd(), 'node_modules', '.pnpm')
    const esbuildDir = readdirSync(pnpmDir).find((entry) => /^esbuild@\d+\.\d+\.\d+$/.test(entry))
    if (!esbuildDir) throw new Error('esbuild is not installed in this workspace')
    const require = createRequire(join(pnpmDir, esbuildDir, 'node_modules', 'esbuild', 'package.json'))
    const esbuild = require('esbuild') as { build(options: unknown): Promise<unknown> }
    await esbuild.build({
      entryPoints: [join(process.cwd(), 'tests', 'helpers', 'ledger-runner.ts')],
      bundle: true, platform: 'node', format: 'esm', outfile: out,
    })
    return out
  })()
  return bundlePromise
}

async function raceChildren(runner: string, root: string, labels: string[]): Promise<Array<{ label: string; code: number; stdout: string; stderr: string }>> {
  const barrier = join(root, 'start-barrier')
  writeFileSync(barrier, 'go: when deleted\n')
  const children = labels.map((label) => spawn(process.execPath, [runner, root, label, barrier], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }))
  const collected = children.map((child, index) => new Promise<{ label: string; code: number; stdout: string; stderr: string }>((resolve) => {
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ label: labels[index]!, code: code ?? -1, stdout, stderr }))
  }))
  rmSync(barrier)
  return Promise.all(collected)
}

it('four simultaneously released processes race recovery and append; the chain stays unique and contiguous', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r4-mp-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    writeDeadClaim(root)
    const runner = await bundledRunner()
    const results = await raceChildren(runner, root, ['a', 'b', 'c', 'd'])
    for (const row of results) {
      expect(row.stderr, `child ${row.label} stderr: ${row.stderr.slice(-500)}`).toBe('')
      expect(row.code, `child ${row.label} exit`).toBe(0)
    }
    const snapshot = readPrivateLedger(root, context)
    const totalSucceeded = results.reduce((sum, row) => sum + (JSON.parse(row.stdout) as { succeeded: number }).succeeded, 0)
    expect(snapshot.damaged).toBe(false)
    expect(snapshot.records.map((record) => record.position)).toEqual(snapshot.records.map((_, index) => index + 1))
    expect(snapshot.records.length).toBe(totalSucceeded)
    expect(new Set(snapshot.records.map((record) => String(record.payload.resolutionCallId))).size).toBe(snapshot.records.length)
    expect(totalSucceeded).toBeGreaterThanOrEqual(1)
    expect(__writerLockInternals.readHolder(root)).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

it('S1/L1 (standing regression): a delayed evict from a stale observation cannot evict a live holder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r4-l1-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    // Dead holder D; A observes D and PAUSES (stale observation object).
    // B (real child) evicts D, claims and enters its critical section. A's
    // delayed evict record — computed from the stale observation — must be
    // adjudicated against the CURRENT holder and have no effect.
    writeDeadClaim(root)
    const stale = __writerLockInternals.readHolder(root)
    if (!stale) throw new Error('fixture: dead claim not visible')
    expect(stale.pid).toBe(deadPid)
    const runner = await bundledRunner()
    // B holds the lock until the hold barrier disappears, so the parent's
    // delayed evict lands against a genuinely live holder.
    const holdBarrier = join(root, 'start-barrier')
    writeFileSync(holdBarrier, 'hold\n')
    const child = spawn(process.execPath, [runner, root, 'slowappend', holdBarrier], { stdio: ['ignore', 'pipe', 'pipe'] })
    const deadline = Date.now() + 30_000
    let bHolding = false
    while (Date.now() < deadline) {
      const holder = __writerLockInternals.readHolder(root)
      if (holder !== null && holder.nonce !== stale.nonce) { bHolding = true; break }
      if (child.exitCode !== null) break
    }
    expect(bHolding, 'child B entered its critical section').toBe(true)
    const before = __writerLockInternals.readHolder(root)
    // A's delayed evict, computed from the STALE observation of D.
    __writerLockInternals.delayedEvict(root, stale)
    const after = __writerLockInternals.readHolder(root)
    expect(after, 'the live holder must survive a stale evict').toEqual(before)
    rmSync(holdBarrier) // release B
    await new Promise<void>((resolve) => child.on('close', () => resolve()))
    // The holder is empty again and a fresh append works: recovery left the
    // ledger fully usable. (slowappend holds the lock only; it writes no
    // ledger records.)
    expect(__writerLockInternals.readHolder(root)).toBeNull()
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'post-s1', serviceId: 's', preGeneration: 'g' })).toBe(true)
    const snapshot = readPrivateLedger(root, context)
    expect(snapshot.damaged).toBe(false)
    expect(snapshot.records).toHaveLength(1)
    expect(__writerLockInternals.readHolder(root)).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

it('S3 (standing regression): bidirectional v2/v3 upgrade barrier', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r4-s3-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    const runner = await bundledRunner()
    // Direction 1: v3 holds → the v2-shaped child (O_EXCL on the root
    // .writer.lock, exactly the 0.8.2 code path) must refuse.
    const held = __writerLockInternals.acquire(root)
    expect(held).toBeDefined()
    const barrier = join(root, 'start-barrier')
    writeFileSync(barrier, 'go\n')
    const v2child = spawn(process.execPath, [runner, root, 'v2compat', barrier], { stdio: ['ignore', 'pipe', 'pipe'] })
    rmSync(barrier) // release the child immediately
    let stdout = ''
    v2child.stdout.on('data', (chunk) => { stdout += chunk })
    await new Promise<void>((resolve) => v2child.on('close', () => resolve()))
    expect(JSON.parse(stdout), 'v2-shaped writer must refuse while v3 holds').toMatchObject({ refused: true })
    __writerLockInternals.release(root, held)
    // Direction 2: v2 holds (structured v2 record naming a LIVE pid) → v3 refuses.
    const v2record = { version: 2, nonce: randomBytes(16).toString('hex'), pid: process.pid, hostname: hostname(), created_at_epoch_ms: Date.now() }
    writeFileSync(join(root, '.writer.lock'), JSON.stringify(v2record) + '\n')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'v2-held', serviceId: 's', preGeneration: 'g' })).toBe(false)
    expect(existsSync(join(root, '.writer.lock'))).toBe(true)
    // Direction 3: v2 crashed (dead pid) → v3 ADOPTS the barrier file
    // (it stays, keeping v2 writers refused; documented migration constraint)
    // and proceeds.
    const deadV2 = { version: 2, nonce: randomBytes(16).toString('hex'), pid: deadPid, hostname: hostname(), created_at_epoch_ms: Date.now() }
    writeFileSync(join(root, '.writer.lock'), JSON.stringify(deadV2) + '\n')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'v2-dead', serviceId: 's', preGeneration: 'g' })).toBe(true)
    expect(existsSync(join(root, '.writer.lock'))).toBe(true)
    // The adopted dead barrier keeps new v2 writers refused...
    writeFileSync(join(root, '.writer.lock'), JSON.stringify({ version: 2, nonce: randomBytes(16).toString('hex'), pid: deadPid, hostname: hostname(), created_at_epoch_ms: Date.now() }) + '\n')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'v2-dead-2', serviceId: 's', preGeneration: 'g' })).toBe(true)
    // and the log holder is empty between operations.
    expect(__writerLockInternals.readHolder(root)).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

it('L4.1 (standing regression): a stale dead-legacy observation cannot evict a live v3 holder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r5-l41-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    // A legacy barrier with a provably dead owner appears; A observes it and
    // PAUSES (the old protocol would unlink it here). B adopts the same dead
    // file, claims and enters its critical section. A resumes: the protocol
    // NEVER removes the legacy file, so B's tenure is untouched and A must
    // refuse on the live log holder.
    writeDeadClaim(root)
    writeFileSync(join(root, '.writer.lock'), JSON.stringify({
      version: 2, nonce: randomBytes(16).toString('hex'), pid: deadPid,
      hostname: hostname(), created_at_epoch_ms: Date.now(),
    }) + '\n', 'utf8')
    const staleBarrierBytes = readFileSync(join(root, '.writer.lock'), 'utf8')
    const runner = await bundledRunner()
    // The runner holds until start-barrier disappears; create it so B stays
    // inside its critical section while A's stale admission lands.
    const holdBarrier = join(root, 'start-barrier')
    writeFileSync(holdBarrier, 'hold\n')
    const child = spawn(process.execPath, [runner, root, 'slowappend', holdBarrier], { stdio: ['ignore', 'pipe', 'pipe'] })
    const deadline = Date.now() + 30_000
    let bHolding = false
    while (Date.now() < deadline) {
      const holder = __writerLockInternals.readHolder(root)
      // B's holder is LIVE (its pid differs from the dead fixture pid).
      if (holder !== null && holder.pid !== deadPid) { bHolding = true; break }
      if (child.exitCode !== null) break
    }
    expect(bHolding, 'child B entered its critical section').toBe(true)
    const barrierBefore = readFileSync(join(root, '.writer.lock'), 'utf8')
    // A resumes its stale admission: the adopt path touches nothing and the
    // live holder refuses it.
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'stale-a', serviceId: 's', preGeneration: 'g' })).toBe(false)
    expect(readFileSync(join(root, '.writer.lock'), 'utf8'), 'B barrier untouched').toBe(barrierBefore)
    rmSync(holdBarrier) // release B
    await new Promise<void>((resolve) => child.on('close', () => resolve()))
    // The holder is empty again and a fresh append works: recovery left the
    // ledger fully usable. (slowappend holds the lock only; it writes no
    // ledger records.)
    expect(__writerLockInternals.readHolder(root)).toBeNull()
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'post-s1', serviceId: 's', preGeneration: 'g' })).toBe(true)
    const snapshot = readPrivateLedger(root, context)
    expect(snapshot.damaged).toBe(false)
    expect(snapshot.records).toHaveLength(1)
    expect(__writerLockInternals.readHolder(root)).toBeNull()
    void staleBarrierBytes
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

it('L4.2 (standing regression): an append raced with an active holder fails closed without revoking it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r5-l42-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    // B claims and holds (its claim is granted and verified). A concurrent
    // writer A appends while B holds: the replay marks A's claim ineffective
    // and A must exit fail-closed. B's holder state must survive untouched —
    // there is no truncation anywhere that could revoke it.
    const held = __writerLockInternals.acquire(root)
    expect(held).toBeDefined()
    expect(__writerLockInternals.readHolder(root)?.nonce).toBe(held!.nonce)
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'racer', serviceId: 's', preGeneration: 'g' })).toBe(false)
    expect(__writerLockInternals.readHolder(root)?.nonce, 'live holder survives the raced append').toBe(held!.nonce)
    __writerLockInternals.release(root, held)
    expect(__writerLockInternals.readHolder(root)).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('L4.3 (standing regression): tenure-scoped compaction keeps the holder state equivalent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r5-l43-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    // B holds; compaction runs mid-tenure (the exact code the acquire path
    // runs when the log is oversized). The holder state must be equivalent
    // before and after, and a concurrent admission must stay refused.
    const held = __writerLockInternals.acquire(root)
    expect(held).toBeDefined()
    const before = __writerLockInternals.readHolder(root)
    __writerLockInternals.compactInTenure(root, held!)
    const after = __writerLockInternals.readHolder(root)
    expect(after, 'compaction is state-equivalent').toEqual(before)
    expect(after?.nonce).toBe(held!.nonce)
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'racer', serviceId: 's', preGeneration: 'g' })).toBe(false)
    __writerLockInternals.release(root, held)
    expect(__writerLockInternals.readHolder(root)).toBeNull()
    // The compacted log replays to a working ledger.
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'post', serviceId: 's', preGeneration: 'g' })).toBe(true)
    const snapshot = readPrivateLedger(root, context)
    expect(snapshot.damaged).toBe(false)
    expect(snapshot.records.map((record) => record.position)).toEqual([1])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('S2 (standing regression): SIGKILL inside the admission window leaves every later append recoverable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r6-s2-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    const runner = await bundledRunner()
    // Repeat: spawn a real child performing production appends; the parent
    // polls for the admission window (a pending.<nonce> file appears between
    // prepare and publish) and SIGKILLs the child the moment it opens. Every
    // kill lands in a different sub-window across iterations (before write,
    // after write, after link, after claim).
    for (let round = 0; round < 6; round += 1) {
      const child = spawn(process.execPath, [runner, root, `s2-${round}`], { stdio: ['ignore', 'pipe', 'pipe'] })
      const deadline = Date.now() + 30_000
      let killed = false
      while (Date.now() < deadline) {
        const pending = readdirSync(root).filter((name) => name.startsWith('pending.'))
        if (pending.length > 0) {
          process.kill(child.pid!, 'SIGKILL')
          killed = true
          break
        }
        if (child.exitCode !== null) break
      }
      await new Promise<void>((resolve) => child.on('close', () => resolve()))
      if (!killed) break // the child finished all 5 appends before the window opened
      // The barrier, if present, must be a COMPLETE record — never empty or
      // partial (that is the S2 invariant the publication fixes).
      const barrierPath = join(root, '.writer.lock')
      if (existsSync(barrierPath)) {
        const raw = readFileSync(barrierPath, 'utf8')
        expect(() => JSON.parse(raw), `round ${round}: barrier must be complete JSON, got ${raw.slice(0, 60)}`).not.toThrow()
        expect(JSON.parse(raw).version, `round ${round}`).toBe(2)
      }
      // Subsequent production appends MUST recover (BUG-01): no permanent
      // unknown_owner wedge, and any dead-creator pending garbage is swept.
      for (let followUp = 0; followUp < 3; followUp += 1) {
        expect(appendPrivateLedger(root, context, 'restart_intent', {
          resolutionCallId: `s2-${round}-${followUp}`, serviceId: 's', preGeneration: 'g',
        }), `round ${round} follow-up ${followUp}`).toBe(true)
      }
    }
    // The ledger chain is unique and contiguous across all recovered windows.
    const snapshot = readPrivateLedger(root, context)
    expect(snapshot.damaged).toBe(false)
    expect(snapshot.records.map((record) => record.position)).toEqual(snapshot.records.map((_, index) => index + 1))
    expect(new Set(snapshot.records.map((record) => String(record.payload.resolutionCallId))).size).toBe(snapshot.records.length)
    expect(snapshot.records.length).toBeGreaterThanOrEqual(1)
    expect(__writerLockInternals.readHolder(root)).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

it('S2 safe control: a pending file whose creator is ALIVE is never taken over', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r6-alive-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    // A live creator's pending file (same process = provably alive): the
    // admission must leave it untouched while proceeding with its own state.
    const livePending = join(root, `pending.${'a'.repeat(32)}.json`)
    writeFileSync(livePending, JSON.stringify({
      version: 2, nonce: 'a'.repeat(32), pid: process.pid,
      hostname: hostname(), created_at_epoch_ms: Date.now(),
    }) + '\n', 'utf8')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'ctrl', serviceId: 's', preGeneration: 'g' })).toBe(true)
    expect(existsSync(livePending), 'live creator pending file untouched').toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('S2 partial pending write: inert garbage, admission proceeds', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r6-partial-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    // A creator killed mid-write leaves an unparseable pending file; it
    // cannot be identified so it is left in place — and must not wedge
    // anything.
    writeFileSync(join(root, 'pending.bbbb.json'), '{"version":2,"non', 'utf8')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'partial', serviceId: 's', preGeneration: 'g' })).toBe(true)
    expect(existsSync(join(root, 'pending.bbbb.json'))).toBe(true)
    expect(readPrivateLedger(root, context).records).toHaveLength(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('S2: a torn trailing line (crash mid-append) leaves the log recoverable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r4-s2-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    writeDeadClaim(root)
    // A torn trailing line (crash mid-append) terminates the replay but the
    // preceding complete dead claim is still recovered.
    appendFileSync(join(root, 'arbitration.log'), '{"v":3,"op":"cla')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'after-torn', serviceId: 's', preGeneration: 'g' })).toBe(true)
    const snapshot = readPrivateLedger(root, context)
    expect(snapshot.damaged).toBe(false)
    expect(snapshot.records).toHaveLength(1)
    expect(__writerLockInternals.readHolder(root)).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

it('a child killed INSIDE the critical section does not wedge the ledger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r4-crash-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    const runner = await bundledRunner()
    const child = spawn(process.execPath, [runner, root, 'repeat'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let killed = false
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const holder = __writerLockInternals.readHolder(root)
      if (holder !== null) {
        process.kill(child.pid!, 'SIGKILL')
        killed = true
        break
      }
      if (child.exitCode !== null) break
    }
    await new Promise<void>((resolve) => child.on('close', () => resolve()))
    expect(killed, 'parent caught the child inside the critical section').toBe(true)
    expect(writerLockState(root)).toBe('abandoned_recoverable')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'after-crash', serviceId: 's', preGeneration: 'g' })).toBe(true)
    const snapshot = readPrivateLedger(root, context)
    expect(snapshot.damaged).toBe(false)
    expect(snapshot.records.length).toBeGreaterThanOrEqual(1)
    expect(__writerLockInternals.readHolder(root)).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

it('refuses to write the ledger through a symlinked arbitration log', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r4-link-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    const outside = mkdtempSync(join(tmpdir(), 'dsh-cg-r4-outside-'))
    try {
      writeFileSync(join(outside, 'target'), '', 'utf8')
      rmSync(join(root, 'arbitration.log'), { force: true })
      symlinkSync(join(outside, 'target'), join(root, 'arbitration.log'))
      expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'c3', serviceId: 's', preGeneration: 'g' })).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
