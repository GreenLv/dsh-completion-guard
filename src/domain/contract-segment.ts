import { sha256 } from './canonicalize.js'

export type AuthorityBlockKind = 'instruction' | 'reference' | 'quoted' | 'code' | 'uncertain'
export type AuthorityKind = 'root_instruction' | 'root_adoption' | 'none'

export interface AuthorityBlock {
  kind: AuthorityBlockKind
  authority: AuthorityKind
  text: string
  capture: boolean
  blockId: string
}

const REFERENCE_FRAME = /(?:以下|下面|下列|附上|粘贴|提供).{0,12}(?:报告|材料|内容|记录|日志).{0,12}(?:供参考|参考|如下)|(?:for reference|pasted|attached|following).{0,16}(?:report|material|log)/i
const INSTRUCTION_SIGNAL = /(?:请|需要|必须|务必|禁止|不要|不得|运行|执行|修改|创建|读取|验证|检查|安装|拉取|提交|推送|发布|重启)|\b(?:please|must|shall|do not|run|execute|modify|create|read|verify|check|install|pull|commit|push|publish|restart)\b/i
const ADOPTION_SIGNAL = /(?:按照|依照|采用|执行).{0,16}(?:下面|以下|报告|材料|第\s*([0-9一二三四五六七八九十]+)\s*节).{0,16}(?:全部执行|执行|作为验收|作为要求)|(?:把|将).{0,16}(?:上一条|前述|上述).{0,8}(?:报告|材料).{0,12}第\s*([0-9一二三四五六七八九十]+)\s*节.{0,20}(?:执行|采用)|(?:adopt|follow|apply).{0,20}(?:section\s+(\d+)|below|report)/i
const PREVIOUS_REFERENCE_ADOPTION = /(?:把|将).{0,16}(?:上一条|前述|上述).{0,8}(?:报告|材料).{0,12}第\s*[0-9一二三四五六七八九十]+\s*节.{0,20}(?:执行|采用)|(?:adopt|follow|apply).{0,16}(?:the\s+)?(?:previous|above).{0,12}(?:report|material).{0,12}section\s+\d+/i

function chineseNumber(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value)
  const basic: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  return basic[value]
}

function block(kind: AuthorityBlockKind, text: string, authority: AuthorityKind, capture: boolean): AuthorityBlock {
  const normalized = text.trim()
  return { kind, authority, text: normalized, capture, blockId: `block:${sha256(`${kind}\0${normalized}`).slice(0, 16)}` }
}

function parseAdoptedSection(text: string): number | undefined {
  const zh = text.match(/第\s*([0-9一二三四五六七八九十]+)\s*节/)
  if (zh) return chineseNumber(zh[1])
  const en = text.match(/section\s+(\d+)/i)
  return en ? Number(en[1]) : undefined
}

function sectionNumber(text: string): number | undefined {
  const heading = text.match(/^#{1,6}\s*(?:第\s*)?([0-9一二三四五六七八九十]+)\s*(?:节|\b)/)
  return heading ? chineseNumber(heading[1]) : undefined
}

function referencedSection(text: string, target: number): string | undefined {
  if (!REFERENCE_FRAME.test(text)) return undefined
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const selected: string[] = []
  let active = false
  for (const line of lines) {
    const section = sectionNumber(line.trim())
    if (section !== undefined) {
      if (active && section !== target) break
      active = section === target
    }
    if (active) selected.push(line)
  }
  const value = selected.join('\n').trim()
  return value || undefined
}

/**
 * Split a direct root-user message into authority blocks before clause capture.
 * Framed reports, blockquotes and fenced code remain in the native DSH log but
 * never become Guard items. Uncertain prose is captured fail-closed. Explicit
 * adoption can promote only the referenced section, never the whole report by
 * virtue of normative words inside the report itself.
 */
export function segmentAuthorityBlocks(text: string, priorRootMessages: readonly string[] = []): AuthorityBlock[] {
  const adoptedSection = parseAdoptedSection(text)
  if (ADOPTION_SIGNAL.test(text) && PREVIOUS_REFERENCE_ADOPTION.test(text)
    && adoptedSection !== undefined && priorRootMessages.length > 0) {
    const selected = referencedSection(priorRootMessages.at(-1) ?? '', adoptedSection)
    if (selected) return [block('reference', selected, 'root_adoption', true)]
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const result: AuthorityBlock[] = []
  const adoption = ADOPTION_SIGNAL.test(text)
  const inlineAdoptedSection = adoption ? adoptedSection : undefined
  let referenceMode = false
  let fence = false
  let buffer: string[] = []
  let bufferKind: AuthorityBlockKind = 'uncertain'
  let currentSection: number | undefined

  const flush = () => {
    const value = buffer.join('\n').trim()
    buffer = []
    if (!value) return
    if (bufferKind === 'reference' && adoption && inlineAdoptedSection !== undefined && currentSection === inlineAdoptedSection) {
      result.push(block('reference', value, 'root_adoption', true))
      return
    }
    if (bufferKind === 'instruction') result.push(block('instruction', value, 'root_instruction', true))
    else if (bufferKind === 'uncertain') result.push(block('uncertain', value, 'root_instruction', true))
    else result.push(block(bufferKind, value, 'none', false))
  }

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (!fence) { flush(); fence = true; bufferKind = 'code'; buffer = [line] }
      else { buffer.push(line); flush(); fence = false; bufferKind = referenceMode ? 'reference' : 'uncertain' }
      continue
    }
    if (fence) { buffer.push(line); continue }
    if (/^\s*>/.test(line)) {
      if (bufferKind !== 'quoted') { flush(); bufferKind = 'quoted' }
      buffer.push(line)
      continue
    }
    if (bufferKind === 'quoted') { flush(); bufferKind = referenceMode ? 'reference' : 'uncertain' }
    if (REFERENCE_FRAME.test(line)) {
      flush()
      referenceMode = true
      bufferKind = 'reference'
      currentSection = undefined
      buffer.push(line)
      continue
    }
    if (referenceMode) {
      const nextSection = sectionNumber(line.trim())
      if (nextSection !== undefined) {
        flush()
        currentSection = nextSection
      }
      bufferKind = 'reference'
      buffer.push(line)
      continue
    }
    if (/^\s*---+\s*$/.test(line)) { flush(); continue }
    if (!line.trim()) { flush(); continue }
    const kind: AuthorityBlockKind = INSTRUCTION_SIGNAL.test(line) ? 'instruction' : 'uncertain'
    if (bufferKind !== kind) { flush(); bufferKind = kind }
    buffer.push(line)
  }
  flush()
  return result
}

export function authorityCaptureCounts(blocks: readonly AuthorityBlock[]): Record<string, number> {
  return {
    capturedInstructionClauses: blocks.filter((entry) => entry.kind === 'instruction' && entry.capture).length,
    ignoredReferenceClauses: blocks.filter((entry) => entry.kind === 'reference' && !entry.capture).length,
    ignoredQuotedClauses: blocks.filter((entry) => entry.kind === 'quoted').length,
    ignoredCodeClauses: blocks.filter((entry) => entry.kind === 'code').length,
    capturedUncertainClauses: blocks.filter((entry) => entry.kind === 'uncertain' && entry.capture).length,
  }
}
