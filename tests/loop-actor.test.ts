import { describe, it, expect, beforeEach } from 'vitest'
import { loopBus } from '../src/loop-bus.js'
import { attributeError } from '../src/loop-actor.js'

describe('attributeError', () => {
  beforeEach(() => loopBus.clear())

  it('returns the most recent mutation actor before an error', () => {
    loopBus.ingest({ id: 'a', ts: 1, wallTs: 1000, source: 'state', kind: 'mutation', actor: { type: 'human', name: 'user' }, payload: {} } as any)
    loopBus.ingest({ id: 'b', ts: 2, wallTs: 1500, source: 'state', kind: 'mutation', actor: { type: 'effect', name: 'sync' }, payload: {} } as any)
    expect(attributeError(2000)).toEqual({ type: 'effect', name: 'sync' })
  })

  it('returns null when no mutations precede the timestamp', () => {
    expect(attributeError(2000)).toBeNull()
  })

  it('returns null when mutations exist but only after the timestamp', () => {
    loopBus.ingest({ id: 'a', ts: 1, wallTs: 5000, source: 'state', kind: 'mutation', actor: { type: 'human', name: 'user' }, payload: {} } as any)
    expect(attributeError(2000)).toBeNull()
  })

  it('skips events without actor', () => {
    loopBus.ingest({ id: 'a', ts: 1, wallTs: 1000, source: 'state', kind: 'mutation', actor: { type: 'human', name: 'user' }, payload: {} } as any)
    loopBus.ingest({ id: 'b', ts: 2, wallTs: 1500, source: 'state', kind: 'mutation', payload: {} } as any) // no actor
    // Should still find 'a'
    expect(attributeError(2000)).toEqual({ type: 'human', name: 'user' })
  })
})
