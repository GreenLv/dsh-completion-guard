import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { maskLocatorObjects } from '../src/domain/locator-classification.js'
import { deriveProjection } from '../src/domain/derive.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'
import { kindOfScope, semanticActionOfScope, statefulActionsOfScope } from '../src/domain/semantics.js'

const HOST = { ...evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' }), goalAvailable: false, auditedForegroundRenderers: ['bash' as const] }

function project(text: string) {
  const events = [
    { seq: 0, type: 'command/run', data: { commandId: 'on', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
    { seq: 1, type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text: 'Context Guard protocol boundary: v6.0.0' }], source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: 'v6' } }) },
    { seq: 2, type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }) },
  ]
  return deriveProjection(events as never, { activation: 'opt-in' }, { cwd: '/work' }, true, HOST).projection
}

describe('locator objects in v6 classification', () => {
  it.each(['verify.pdf', 'verify.xlsx', 'verify.docx', 'verify.pptx', 'verify.png', 'verify.jpg', 'verify.csv', 'verify.log', 'verify.zip', 'verify.tar.gz', '验证.pptx'])('does not classify the filename %s as a verification', text => {
    expect(kindOfScope('directive', text)).not.toBe('acceptance')
    expect(semanticActionOfScope(text)).not.toBe('verify')
    const projection = project(text)
    expect(projection.boundaryProtocol).toBe(6)
    const items = [...projection.items.values()]
    expect(items.length).toBeGreaterThan(0)
    expect(items.every(item => item.kind !== 'acceptance' && item.semanticAction !== 'verify')).toBe(true)
    expect(items[0].rawTextSha256).toBe(createHash('sha256').update(text).digest('hex'))
    expect(items[0]!.spans![0]!.start).toBe(0)
    expect(items[0]!.spans![0]!.end).toBe(Buffer.byteLength(text))
    expect(items[0].status).toBe('pending')
    expect(items[0].authorityDisposition).not.toBe('executable_now')
    expect(items[0].executionQualification?.status).not.toBe('granted')
  })

  it.each(['verify.gitignore', 'verify.gitattributes', 'verify.requirements', 'verify.customextension', 'verify.one.two.verylongextension'])('treats long complete suffix in %s as a filename', text => {
    expect(kindOfScope('directive', text)).toBe('requirement')
    expect(semanticActionOfScope(text)).toBe('generic_run')
    const item = [...project(text).items.values()][0]!
    expect(item.kind).toBe('requirement')
    expect(item.semanticAction).toBe('generic_run')
    expect(item.authorityDisposition).not.toBe('executable_now')
    expect(item.rawTextSha256).toBe(createHash('sha256').update(text).digest('hex'))
    expect(item.spans![0]!.end).toBe(Buffer.byteLength(text))
    expect(item.status).toBe('pending')
  })

  it.each(['读取 verify.customextension', '读取 docs/verify.customextension', '读取 ./验证/verify.gitattributes', '读取 `verify.requirements`'])('does not extract an action from a long suffix in %s', text => {
    expect(semanticActionOfScope(text)).toBe('generic_run')
    expect([...project(text).items.values()].every(item => item.semanticAction !== 'verify')).toBe(true)
  })

  it.each(['打开 verify.customextension后验证结果', '打开 /work/verify.gitattributes后验证结果', '必须验证 verify.requirements 的内容'])('retains adjacent verification prose with a long suffix in %s', text => {
    expect(semanticActionOfScope(text)).toBe('verify')
    expect([...project(text).items.values()].some(item => item.semanticAction === 'verify')).toBe(true)
  })

  it.each([
    '读取 verify.pdf', '打开 /work/verify/a.txt', 'read ./verify/notes.md', 'read ../verify/x/y',
    'read ~/verify/notes.txt', '打开 C:\\work\\verify\\a.txt', '打开 D:/work/verify/a.txt',
    '打开 \\\\server\\share\\verify\\a.txt', 'read docs/verify/guide.md',
    '看看 https://example.com/verify/page', '打开 `verify.pdf`', '打开 "verify.pdf"',
    '打开 [说明](verify.pdf)', '打开 (verify.pdf)', '打开 <verify.pdf>', '打开 "C:\\Program Files\\verify\\a.txt"',
  ])('does not borrow an action from %s', text => {
    expect(semanticActionOfScope(text)).not.toBe('verify')
    const items = [...project(text).items.values()]
    expect(items.length).toBeGreaterThan(0)
    expect(items.every(item => item.semanticAction !== 'verify' && item.kind !== 'acceptance')).toBe(true)
  })

  it.each([
    '打开 [必须验证](test.pdf)', '请保留 "/work/a.txt must verify output" 这一条要求', '请保留 "/work/path must verify output" 这一条要求',
    '请验证/测试/实现这个模块', '必须验证/测试/验收', '打开 test.pdf后验证结果', '打开 /work/test.pdf后验证结果', '必须验证 test.png 的输出',
  ])('preserves real verification text in %s', text => {
    expect(semanticActionOfScope(text)).toBe('verify')
    expect([...project(text).items.values()].some(item => item.semanticAction === 'verify')).toBe(true)
  })

  it.each(['please verify/test/implement this module', 'verify/test/build this module', '请验证/测试/实现这个模块'])('retains a slash-joined instruction: %s', text => {
    expect(semanticActionOfScope(text)).toBe('verify')
    const items = [...project(text).items.values()]
    expect(items.some(item => item.semanticAction === 'verify' && item.status === 'pending' && item.authorityDisposition === 'executable_now')).toBe(true)
    expect(items[0]!.rawTextSha256).toBe(createHash('sha256').update(text).digest('hex'))
    expect(items[0]!.spans![0]!.end).toBe(Buffer.byteLength(text))
  })

  it.each(['read docs/verify/guide', 'open docs/verify/guide', '读取 docs/verify/guide', 'docs/verify/guide 中读取内容', 'read "docs/verify/guide"', 'open [guide](docs/verify/guide)'])('recognizes a relative path in an explicit object slot: %s', text => {
    expect(semanticActionOfScope(text)).not.toBe('verify')
    expect([...project(text).items.values()].every(item => item.semanticAction !== 'verify')).toBe(true)
  })

  it('keeps an ambiguous relative slash expression visible without an object slot', () => {
    expect(maskLocatorObjects('verify/test/implement this module')).toBe('verify/test/implement this module')
    expect(maskLocatorObjects('verify/test/build: read this document')).toBe('verify/test/build: read this document')
    expect(maskLocatorObjects('请验证/测试/实现这个模块')).toBe('请验证/测试/实现这个模块')
  })

  it('keeps suffix grammar and offsets stable on long and dotted tokens', () => {
    const longName = `verify.${'a'.repeat(30000)}`
    const dottedName = `verify.${'part.'.repeat(6000)}extension`
    for (const text of [longName, dottedName]) {
      const masked = maskLocatorObjects(text)
      expect(masked).toBe(' '.repeat(text.length))
      expect(masked.length).toBe(text.length)
    }
    expect(maskLocatorObjects('verify.customextension后验证结果')).toBe(`${' '.repeat(22)}后验证结果`)
    expect(maskLocatorObjects('请验证/测试/实现这个模块')).toBe('请验证/测试/实现这个模块')
  })

  it.each(['fix.pdf', 'update.xlsx', 'test.pdf', 'verify.pdf'])('does not gain execution authority from %s', text => {
    const items = [...project(text).items.values()]
    expect(items.length).toBeGreaterThan(0)
    expect(items.every(item => item.authorityDisposition !== 'executable_now' && item.executionQualification?.status !== 'granted')).toBe(true)
  })

  it.each(['读取 /work/restart/a.txt', '读取 /work/修改/a.txt', '读取 publish.pdf'])('does not manufacture stateful plan actions from %s', text => {
    expect(statefulActionsOfScope(text)).toEqual([])
  })

  it('does not take a prohibited action from a path object', () => {
    expect(semanticActionOfScope('读取 /work/修改/a.txt', '不要读取 /work/修改/a.txt', true)).toBe('generic_run')
  })

  it('preserves explicit test commands, prohibition, and replayed source identity', () => {
    const run = [...project('运行 test_case.py').items.values()]
    expect(run.some(item => item.status === 'pending' && item.authorityDisposition === 'executable_now')).toBe(true)
    const text = '不要修改 /work/verify/a.txt'
    const first = [...project(text).items.values()]
    expect(first.some(item => item.kind === 'prohibition' && item.semanticAction === 'modify' && item.authorityDisposition === 'prohibition')).toBe(true)
    expect([...project(text).items.values()]).toEqual(first)
  })
})
