import { describe, expect, it } from 'vitest'
import { captureClause } from '../../src/domain/capture.js'

const capture = (text: string) => captureClause(text, 'm1', 'R001', 1, { cwd: 'C:\\Work' })

describe('0.7.0 repository path token integrity', () => {
  it.each([
    ['Commit changes in repository C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\repo.', 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\repo'],
    ['Commit changes in repository "C:\\Work Space\\repo".', 'C:\\Work Space\\repo'],
    ['Commit changes in repository C:\\项目\\repo.', 'C:\\项目\\repo'],
  ])('preserves one complete named repository: %s', (text, repository) => {
    const item = capture(text)
    expect(item.semanticAction).toBe('commit')
    expect(item.targetCaptureStatus, JSON.stringify({ reason: item.targetCaptureReasonCode, target: item.requestedTarget })).toBe('resolved')
    expect(item.requestedTarget?.repository).toBe(repository)
  })

  it.each([
    'Commit changes in repository C:\\Work\\..\\repo.',
    'Commit changes in repository \\\\server\\share\\repo.',
    'Commit changes in repository C:\\Work\\repo^suffix.',
    'Commit changes in repository C:\\Work Space\\repo.',
    'Commit changes in repository C:\\Work Space.',
    'Commit changes in repository C:\\Work and More.',
    'Commit changes in repository C:\\Work on Hold.',
    'Commit changes in repository "C:\\Work\\repo"^suffix.',
    'Commit C:\\Work\\repo^suffix.',
    'Push repository C:\\Good or repository C:\\Bad^suffix.',
  ])('keeps an unsupported repository wholly unresolved: %s', (text) => {
    const item = capture(text)
    expect(item.targetCaptureStatus).toBe('clarification_required')
    expect(item.requestedTarget?.repository).not.toBe('C:\\Work')
    expect(item.requestedTarget?.repository).not.toBe('C:\\Work\\repo')
  })
})
