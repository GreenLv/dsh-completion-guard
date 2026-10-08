import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })))
const entry = new URL('../bin/dsh-completion-guard-activation.mjs', import.meta.url)
function fixture(all = false) {
  const root = mkdtempSync(join(tmpdir(), 'guard-selection-cli-')); dirs.push(root)
  const anchor = join(root, 'runtime', 'package.json')
  mkdirSync(join(root, 'runtime'), { recursive: true }); writeFileSync(anchor, '{}')
  function module(name: string, source: string) {
    const path = join(root, 'runtime', 'node_modules', '@deepseek-ai', name); mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }))
    writeFileSync(join(path, 'index.js'), source)
  }
  module('dsh-session-persistence', 'export class SessionFormatUnsupportedError extends Error {}')
  module('dsh-session-persistence-jsonl', `import {readFileSync} from 'node:fs';
    import {SessionFormatUnsupportedError} from '@deepseek-ai/dsh-session-persistence';
    export default config => { const rows = () => JSON.parse(readFileSync(config.root,'utf8'));
      return {list:async()=>rows().map(({header,revision})=>({header,revision})),
        stat:async id=>rows().find(r=>r.header.id===id),open:async(id,access)=>{
          if(access!=='read') throw new Error('write denied'); const r=rows().find(r=>r.header.id===id);
          if(r.error==='unsupported') throw new SessionFormatUnsupportedError('private body/path');
          if(r.error==='unknown') throw Object.assign(new Error('private credential'),{name:'SessionFormatUnsupportedError'});
          return {header:r.header,inheritedEventCount:0,close:async()=>{}};}};}`)
  module('cordis', `export class Context {constructor(){this.fiber={dispose:async()=>{}}}
    plugin(backend,config){this.sessionPersistence=backend(config);return {await:async()=>{}}}}`)
  const logs = join(root, 'logs.json'), rows = ['a', 'b', 'old'].map((id, i) => ({ header: { version: 4, id, createdAt: i + 1, isSeeded: false }, revision: 'r0', ...(id === 'old' && !all ? { error: 'unsupported' } : {}) }))
  writeFileSync(logs, JSON.stringify(rows))
  const prior = join(root, 'prior.json'); writeFileSync(prior, JSON.stringify({ schema: 'dsh-activation-prior-modes/v1', previousPackage: { name: 'dsh-completion-guard', version: '0.8.4', sha256: '1'.repeat(64) }, sourceSha256: '2'.repeat(64), cohorts: [{ name: 'verified', mode: 'opt-in' }] }))
  const run = (operation: string, args: string[] = []) => spawnSync(process.execPath, [entry.pathname, operation,
    ...(operation === 'select' ? [] : ['--runtime-anchor', anchor, '--persistence-root', logs]), ...args], { encoding: 'utf8' })
  return { root, logs, prior, rows, run }
}
it('packaged CLI keeps full default strict, selects exact rows, verifies/no-ops without log writes, reports pending and rejects scope drift', () => {
  const f = fixture(), before = readFileSync(f.logs), inventory = join(f.root, 'inventory.json'), selection = join(f.root, 'selection.json'), receipt = join(f.root, 'receipt.json')
  expect(f.run('inspect', ['--prior-modes', f.prior, '--output', receipt]).status).toBe(1)
  expect(existsSync(receipt)).toBe(false)
  const scanned = f.run('inventory', ['--output', inventory]); expect(scanned.status, scanned.stderr).toBe(0)
  expect(JSON.parse(scanned.stdout)).toMatchObject({ readableCount: 2, unsupportedCount: 1, totalCount: 3 })
  expect(scanned.stdout).not.toContain('private')
  const ids = join(f.root, 'ids.json'); writeFileSync(ids, '["a","b"]')
  expect(f.run('select', ['--inventory', inventory, '--include-file', ids, '--output', selection]).status).toBe(0)
  const inspected = f.run('inspect', ['--selection', selection, '--prior-modes', f.prior, '--output', receipt])
  expect(inspected.status, inspected.stderr).toBe(0)
  expect(JSON.parse(inspected.stdout)).toMatchObject({ status: 'ready', scope: 'receipt_selected', pending: [{ id: 'old', reason: 'session_format_unsupported' }] })
  const home = join(f.root, 'home'), args = ['--selection', selection, '--receipt', receipt, '--dsh-home', home]
  expect(f.run('adopt', ['--receipt', receipt, '--dsh-home', home]).stderr).toContain('activation_selection_required')
  expect(f.run('verify', args).status).toBe(2); expect(existsSync(home)).toBe(false)
  expect(JSON.parse(f.run('adopt', args).stdout)).toMatchObject({ status: 'selected_complete', wholeInventoryStatus: 'not_claimed', pending: [{ id: 'old' }] })
  const repeated = JSON.parse(f.run('adopt', args).stdout); expect(repeated.entries.every((r: {created: boolean}) => r.created === false)).toBe(true)
  expect(f.run('verify', args).status).toBe(0)
  expect(readFileSync(f.logs)).toEqual(before)
  expect(f.run('inventory', ['--output', inventory]).stderr).toContain('activation_output_exists')
  const digest = createHash('sha256').update(readFileSync(receipt)).digest('hex')
  f.rows[2].revision = 'r1'; writeFileSync(f.logs, JSON.stringify(f.rows))
  expect(f.run('adopt', args).stderr).toContain('activation_inventory_changed')
  expect(createHash('sha256').update(readFileSync(receipt)).digest('hex')).toBe(digest)
})
it('packaged CLI keeps all-readable full workflow, rejects full receipt in selection and does not classify a forged exception name', () => {
  const f = fixture(true), inventory = join(f.root, 'inventory.json'), selection = join(f.root, 'selection.json'), receipt = join(f.root, 'receipt.json'), ids = join(f.root, 'ids.json')
  expect(f.run('inspect', ['--prior-modes', f.prior, '--output', receipt]).status).toBe(0)
  expect(f.run('adopt', ['--receipt', receipt, '--dsh-home', join(f.root, 'home')]).status).toBe(0)
  expect(f.run('verify', ['--receipt', receipt, '--dsh-home', join(f.root, 'home')]).status).toBe(0)
  expect(f.run('inventory', ['--output', inventory]).status).toBe(0); writeFileSync(ids, '["a"]')
  expect(f.run('select', ['--inventory', inventory, '--include-file', ids, '--output', selection]).status).toBe(0)
  expect(f.run('verify', ['--receipt', receipt, '--selection', selection]).stderr).toContain('activation_selection_receipt_conflict')
  const rows = JSON.parse(readFileSync(f.logs, 'utf8')); rows[2].error = 'unknown'; writeFileSync(f.logs, JSON.stringify(rows))
  const output = join(f.root, 'refused.json'), refused = f.run('inventory', ['--output', output])
  expect(refused.status).toBe(1); expect(refused.stderr).toContain('activation_cli_failed'); expect(refused.stderr).not.toContain('private')
  expect(existsSync(output)).toBe(false)
  expect(f.run('inspect', ['--selection', selection, '--selection', selection]).stderr).toContain('activation_cli_options_invalid')
})
