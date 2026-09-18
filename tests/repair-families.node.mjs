import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { families, selectFiles, run } from './run-repair-families.mjs'

test('selection refuses unknown and empty inputs; all includes every declared bundle once', () => {
  assert.throws(() => selectFiles([]), /Choose/)
  assert.throws(() => selectFiles(['all', 'typo']), /Unknown/)
  assert.deepEqual(selectFiles(['all']), [...new Set(Object.values(families).flat())].sort())
  assert.deepEqual(selectFiles(['qualification', 'qualification']), selectFiles(['qualification']))
})

test('missing input fails before execution; failure, interruption and launch error cannot pass', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repair-families-'))
  try {
    const spawn = () => { throw new Error('should not execute') }
    assert.throws(() => run(['target-identity'], { repoRoot, spawn }), /Missing required input/)
    for (const file of [...selectFiles(['target-identity']), 'node_modules/vitest/vitest.mjs']) {
      const path = join(repoRoot, file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, '')
    }
    assert.equal(run(['target-identity'], { repoRoot, spawn: (command, args, options) => {
      assert.equal(command, process.execPath)
      assert.equal(options.shell, false)
      assert.equal(options.cwd, repoRoot)
      assert.deepEqual(args.slice(1), ['run', ...selectFiles(['target-identity'])])
      return { status: 7 }
    } }), 7)
    assert.throws(() => run(['target-identity'], { repoRoot, spawn: () => ({ status: null, signal: 'SIGTERM' }) }), /interrupted/)
    assert.throws(() => run(['target-identity'], { repoRoot, spawn: () => ({ error: new Error('launch failed') }) }), /launch failed/)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})
