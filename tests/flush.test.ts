import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'

describe('session flush durability', () => {
  it('dispatches session/flush for a live session and reports participation', async () => {
    const ctx = new Context()
    const store = new SessionStore(ctx)
    const session = store.create(SessionId('flush-session'), { meta: { cwd: '/tmp' } })

    let flushed = false
    ctx.on('session/flush', () => {
      flushed = true
    })

    const participated = await store.flush(session)
    expect(participated).toBe(true)
    expect(flushed).toBe(true)
  })

  it('reports no participation when no durability listener is registered', async () => {
    const ctx = new Context()
    const store = new SessionStore(ctx)
    const session = store.create(SessionId('flush-session-empty'), { meta: { cwd: '/tmp' } })

    const participated = await store.flush(session)
    expect(participated).toBe(false)
  })
})
