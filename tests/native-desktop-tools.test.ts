import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

it('initializes the Desktop profile with templates from the official-bundles package', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-template-route-'))
  try {
    const archive = join(root, 'app.asar'), profile = join(root, 'profile')
    const packages = join(archive, 'dsh/node_modules/@deepseek-ai')
    for (const name of ['dsh', 'dsh-app-boot', 'dsh-official-bundles']) {
      const dir = join(packages, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/' + name, type: 'module', exports: './index.js' }))
    }
    writeFileSync(join(packages, 'dsh-app-boot/index.js'), `
      import {mkdir,writeFile} from 'node:fs/promises';
      export async function initProfile(profile,bundles) {
        await mkdir(profile,{recursive:true});
        await writeFile(profile+'/bundles.json',JSON.stringify(bundles));
      }
    `)
    const template = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
    writeFileSync(join(packages, 'dsh-official-bundles/index.js'), `export const PROFILE_TEMPLATES={web:{bundles:${JSON.stringify(template)}}};`)
    const driver = fileURLToPath(new URL('../scripts/native_desktop_tools.mjs', import.meta.url))
    execFileSync(process.execPath, [driver, 'init', archive, profile], { timeout: 10_000 })
    expect(JSON.parse(readFileSync(join(profile, 'bundles.json'), 'utf8'))).toEqual(template)
    rmSync(join(packages, 'dsh-official-bundles/index.js'))
    expect(() => execFileSync(process.execPath, [driver, 'init', archive, profile], { timeout: 10_000, stdio: 'pipe' })).toThrow()
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 30_000)
