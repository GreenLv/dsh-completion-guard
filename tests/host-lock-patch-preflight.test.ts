import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const begin = '# >>> BEGIN DSH COMPLETION GUARD HOST LOCK (managed) >>>'
const end = '# <<< END DSH COMPLETION GUARD HOST LOCK (managed) <<<'
const managed = `${begin}\n- id: context-guard\n  name: dsh-completion-guard\n  config:\n    hostLockPolicy: dsh-core/v1\n    hostLockPackages: []\n${end}\n`
function run(text?: string) {
  const profile = mkdtempSync(join(tmpdir(), 'guard-patch-preflight-')); roots.push(profile)
  const patch = join(profile, 'cordis.patch.yml')
  if (text !== undefined) writeFileSync(patch, text)
  const result = spawnSync(process.execPath, ['bin/dsh-completion-guard-host-lock.mjs', 'inspect-patch', '--profile-root', profile], { encoding: 'utf8' })
  if (text !== undefined) expect(readFileSync(patch, 'utf8')).toBe(text)
  return { result, json: JSON.parse(result.status === 0 ? result.stdout : result.stderr) }
}
it('checks missing and managed patches read-only through the shipped CLI', () => {
  expect(run().json).toMatchObject({ status: 'supported', managed: false, unmanaged_entries: 0 })
  expect(run(`- id: another\n  name: example\n${managed}`).json).toMatchObject({ status: 'supported', managed: true, unmanaged_entries: 1 })
})
it('refuses malformed markers, non-Guard entries and unsafe ordering without writes', () => {
  for (const text of [begin + '\n', managed + managed, `${begin}\n- id: other\n  name: other\n${end}\n`, managed + '- id: another\n  name: example\n']) {
    const r = run(text); expect(r.result.status).toBe(1); expect(r.json.status).toBe('unavailable')
  }
})
