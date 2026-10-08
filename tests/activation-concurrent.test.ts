import { afterEach, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { activationBindingPath, readActivationBinding, writeActivationBinding } from '../src/domain/activation-bindings.js'
import { sessionBirthIdentity } from '../src/domain/session-activation.js'
const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
it('arbitrates concurrent same-id writers without overwrite and permits controlled exact no-op after the winner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mode-concurrent-')); directories.push(root)
  const domainUrl = pathToFileURL(join(process.cwd(), 'dist/domain/index.js')).href
  const script = `import {writeActivationBinding, sessionBirthIdentity} from ${JSON.stringify(domainUrl)};
    const identity=sessionBirthIdentity({version:4,id:'concurrent',createdAt:1,isSeeded:false},0);
    process.stdout.write(JSON.stringify(writeActivationBinding(process.argv[1],identity,process.argv[2],'legacy_adoption','1'.repeat(64))));`
  const run = (mode: string) => new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, mode])
    let output = '', error = ''
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { error += chunk })
    child.once('error', reject); child.once('exit', code => {
      if (code) reject(new Error(error)); else { try { resolve(JSON.parse(output)) } catch (e) { reject(e) } }
    })
  })
  const results = await Promise.all(['always', 'always', 'opt-in'].map(run))
  expect(results.some(r => r.status === 'bound')).toBe(true)
  const identity = sessionBirthIdentity({ version: 4, id: 'concurrent', createdAt: 1, isSeeded: false }, 0)
  const final = readActivationBinding(root, identity)
  expect(final.status).toBe('bound')
  if (final.status !== 'bound') return
  expect(results.filter(r => r.status === 'bound').every(r => r.mode === final.mode)).toBe(true)
  const file = activationBindingPath(root, identity.id), before = readFileSync(file)
  expect(writeActivationBinding(root, identity, final.mode, 'fresh_creation', '2'.repeat(64))).toMatchObject({ status: 'bound', created: false })
  expect(writeActivationBinding(root, identity, final.mode === 'always' ? 'opt-in' : 'always', 'legacy_adoption', '2'.repeat(64))).toMatchObject({ reasonCode: 'activation_mode_conflict' })
  expect(readFileSync(file)).toEqual(before)
}, 20_000)
