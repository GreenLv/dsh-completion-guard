import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { activationCanonical, activationDigest, sessionBirthIdentity } from '../src/domain/session-activation.js'
import { createActivationMigrationReceipt } from '../src/domain/activation-bindings.js'
it('matches independent Python canonical bytes and SHA-256 for the binding/receipt input family', () => {
  const python = [process.env.DSH_TEST_PYTHON, 'python3', 'python'].filter((name): name is string => Boolean(name)).find(name => {
    const result = spawnSync(name, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)'])
    return result.status === 0
  })
  expect(python, 'Python 3.11+ is required for cross-language conformance').toBeTruthy()
  const identity = sessionBirthIdentity({ version: 4, id: '会话-Ω', createdAt: Number.MAX_SAFE_INTEGER, isSeeded: true,
    parentSession: 'parent', origin: 'subagent', delegationDepth: 2 }, 17)
  const receipt = createActivationMigrationReceipt([{ identity, mode: 'opt-in', cohort: 'old-中文' }],
    { source: '1'.repeat(64), '\uE000': '2'.repeat(64), '😀': '3'.repeat(64) })
  const vectors = [identity, receipt, { schema: 'dsh-session-activation/v1', identity, initialMode: 'always',
    source: 'fresh_creation', provenanceSha256: '4'.repeat(64) }]
  // Sort UTF-16 code units independently, matching JSON object-key order for
  // non-BMP names too. This input family has safe integers, not JSON floats.
  const oracle = `import sys,json,hashlib
values=json.load(sys.stdin)
def canonical(value):
 if isinstance(value,dict):
  return '{'+','.join(json.dumps(k,ensure_ascii=False)+':'+canonical(value[k]) for k in sorted(value,key=lambda k:k.encode('utf-16-be','surrogatepass')))+'}'
 if isinstance(value,list): return '['+','.join(canonical(v) for v in value)+']'
 return json.dumps(value,ensure_ascii=False,separators=(',',':'),allow_nan=False)
print(json.dumps([{'canonical':canonical(v),'sha256':hashlib.sha256(canonical(v).encode('utf-8')).hexdigest()} for v in values],ensure_ascii=False))`
  const result = spawnSync(python!, ['-c', oracle], { input: JSON.stringify(vectors), encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(vectors.map(value => ({ canonical: activationCanonical(value), sha256: activationDigest(value) })))
})
