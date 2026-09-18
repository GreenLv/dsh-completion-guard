#!/usr/bin/env node
/**
 * Record a REAL 0.6.2 obligation projection, so the 0.6.3 upgrade-eligibility
 * evidence is built on what the earlier release actually emitted instead of a
 * record this batch edited by hand.
 *
 * The recorder EXECUTES the committed 0.6.2 build. It never imports the current
 * source, so the recorded records keep the earlier release's own semantics:
 * `id`, `normalizedText`, `textSha256`, `kind`, `directive`,
 * `authorityDisposition`, `taskKind`, `status`, `spans`, `revision`,
 * `semanticAction`, `requestedTarget` and `targetCaptureStatus`, exactly as that
 * build derived them.
 *
 * Usage (from the repository root; the module directory is a checkout or export
 * of the baseline commit's `dist/`):
 *
 *   git archive <baseline-commit> dist | tar -x -C /tmp/dsh-baseline
 *   node scripts/record_legacy_upgrade_fixture.mjs \
 *     --module-dir /tmp/dsh-baseline/dist --commit <baseline-commit> \
 *     --output tests/fixtures/upgrade/legacy-0.6.2.json
 *
 * The output is deterministic: the same baseline bytes produce the same fixture.
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1])
}
const moduleDir = args.get('--module-dir')
const commit = args.get('--commit')
const output = args.get('--output')
if (!moduleDir || !commit || !output) {
  console.error('usage: --module-dir <baseline dist dir> --commit <sha> --output <fixture path>')
  process.exit(2)
}

/**
 * Every module file the baseline build emitted, keyed by its repository-relative
 * path (`dist/domain/index.js`), so the recording is auditable and re-recordable.
 */
async function moduleHashes(directory, prefix) {
  const hashes = {}
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      Object.assign(hashes, await moduleHashes(join(directory, entry.name), path))
      continue
    }
    const bytes = await readFile(join(directory, entry.name))
    hashes[path] = createHash('sha256').update(bytes).digest('hex')
  }
  return hashes
}

const domainEntry = join(resolve(moduleDir), 'domain', 'index.js')
const moduleHashesByFile = await moduleHashes(resolve(moduleDir), 'dist')
const moduleSha256 = moduleHashesByFile['dist/domain/index.js']
const { deriveProjection } = await import(pathToFileURL(domainEntry).href)

const config = { activation: 'always' }
const scope = { cwd: '/repo-a', sessionHeader: { version: 3, id: 'legacy-birth', createdAt: 1 } }
/**
 * The protocol boundary notice the earlier release recognized, written out here
 * so this recorder never imports the current source. A session that announced the
 * v5 boundary makes the earlier release apply its delivery pass — the mixed
 * record is then closed as `answered` with a real `answeredBy`, which is the
 * state the upgrade has to preserve. A session with NO notice keeps the older
 * protocol, where the same record stays `pending`. Both are recorded, because
 * both are real 0.6.2 output.
 */
const V5_NOTICE = 'Context Guard protocol boundary: v5.0.0'
const NOTICE_EVENT = (seq) => ({
  seq, type: 'user/message', data: {
    source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
    content: [{ type: 'text', text: V5_NOTICE }],
  },
})
/** The inputs a 0.6.2 session recorded, each answered in its own single turn. */
const CASES = [
  {
    caseId: 'legacy-0.6.2-mixed-chinese',
    text: '更新插件，检查是否存在更新，安装新主题，记录变更。',
    answer: '已是最新版本。',
    notice: false,
    why: 'The reproduced F062-01 defect on the older protocol: the whole mixed clause is ONE information range, still pending.',
  },
  {
    caseId: 'legacy-0.6.2-mixed-chinese-v5',
    text: '更新插件，检查是否存在更新，安装新主题，记录变更。',
    answer: '已是最新版本。',
    notice: true,
    why: 'The same defect on a session that announced the v5 boundary: the earlier release CLOSED the whole mixed clause, so this record carries status=answered and a delivered answeredBy.',
  },
  {
    caseId: 'legacy-0.6.2-mixed-english-v5',
    text: 'Check whether an update exists and install the package.',
    answer: 'An update exists.',
    notice: true,
    why: 'The same answered shape with an unpunctuated English conjunction.',
  },
  {
    caseId: 'legacy-0.6.2-pure-question-v5',
    text: '检查是否有更新吗？',
    answer: '已是最新版本。',
    notice: true,
    why: 'The successful control: a supported pure-question record closed by its own answer, which must keep its birth rule and must NOT be flagged.',
  },
]

function derive(text, answer, notice) {
  let seq = 0
  const events = []
  if (notice) events.push(NOTICE_EVENT(seq++))
  events.push(
    { seq: seq++, type: 'turn/start', data: { turn: 1 } },
    { seq: seq++, type: 'user/message', data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text }] } },
    { seq: seq++, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: answer }] } } },
    { seq: seq++, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  )
  return deriveProjection(events, config, scope, true).projection
}

/**
 * Only the durable fields are recorded. A projection also carries runtime-only
 * bookkeeping (cursors, digests of the run that produced it), and copying those
 * would claim the earlier build persisted more than it did.
 */
const DURABLE_FIELDS = [
  'id', 'revision', 'kind', 'sourceMessageId', 'normalizedText', 'textSha256', 'status',
  'verification', 'semanticAction', 'requestedTarget', 'targetCaptureStatus',
  'targetCaptureReasonCode', 'targetSource', 'taskKind', 'authority', 'actionPlan',
  'directive', 'executee', 'authorityDisposition', 'condition', 'resumeEvent',
  'interpretationFingerprint', 'spans', 'rawTextSha256', 'unitId', 'answeredBy',
]

const cases = CASES.map((entry) => {
  const projection = derive(entry.text, entry.answer, entry.notice)
  const records = [...projection.items.values()].map((item) => {
    const record = {}
    for (const field of DURABLE_FIELDS) {
      if (item[field] !== undefined) record[field] = item[field]
    }
    return record
  })
  return {
    caseId: entry.caseId,
    why: entry.why,
    turn: { text: entry.text, answer: entry.answer, v5Notice: entry.notice },
    boundaryProtocol: projection.boundaryProtocol ?? null,
    records,
  }
})

const fixture = {
  recordingVersion: '1',
  product: 'dsh-completion-guard',
  productVersion: '0.6.2',
  baselineCommit: commit,
  moduleEntry: 'dist/domain/index.js',
  moduleSha256,
  moduleHashes: moduleHashesByFile,
  entryPoint: 'deriveProjection(events, config, scope, true)',
  executedHere: ['deriveProjection'],
  note: 'Records emitted by executing the committed 0.6.2 build. Nothing in this file was written by the 0.6.3 batch: the 0.6.3 upgrade-eligibility evidence reads them as the earlier release left them.',
  scope,
  cases,
}
await mkdir(dirname(resolve(output)), { recursive: true })
await writeFile(resolve(output), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')
console.log(`recorded ${cases.length} cases from ${moduleSha256} -> ${output}`)
