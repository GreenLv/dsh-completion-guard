import { describe, expect, it } from 'vitest'
import { createCheckpointTool } from '../../src/tools/checkpoint.js'
import { createProjection } from '../../src/domain/types.js'

describe('checkpoint tool registration', () => {
  it('instantiates against the DSH value-schema DSL without throwing', () => {
    const projection = createProjection()
    expect(() => createCheckpointTool(() => projection, () => {})).not.toThrow()
  })
})
