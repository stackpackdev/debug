import { describe, it, expect, beforeEach } from 'vitest'
import { loopBus, buildStateContext } from '../src/loop-bus.js'

describe('buildStateContext', () => {
  beforeEach(() => loopBus.clear())

  it('returns null when no state events exist', () => {
    expect(buildStateContext({ wallTs: Date.now() })).toBeNull()
  })

  it('returns null when only non-state events exist', () => {
    loopBus.ingest({ id: 'b', ts: 1, wallTs: 1, source: 'browser', kind: 'console.error', payload: {} } as any)
    expect(buildStateContext({ wallTs: Date.now() })).toBeNull()
  })

  it('returns recent mutations + lastActor + affected stores', () => {
    const now = Date.now()
    loopBus.ingest({ id: 'm1', ts: 1, wallTs: now - 100, source: 'state', kind: 'mutation', storeName: 'todos', actor: { type: 'human', name: 'user' }, payload: { prev: {}, next: { x: 1 } } } as any)
    loopBus.ingest({ id: 'm2', ts: 2, wallTs: now - 50, source: 'state', kind: 'mutation', storeName: 'auth', actor: { type: 'agent', name: 'claude' }, payload: { prev: {}, next: { user: 'a' } } } as any)
    const ctx = buildStateContext({ wallTs: now })
    expect(ctx).not.toBeNull()
    expect(ctx!.recentMutations.map(m => m.id)).toEqual(['m1', 'm2'])
    expect(ctx!.lastActor).toEqual({ type: 'agent', name: 'claude' })
    expect(ctx!.affectedStores).toEqual(expect.arrayContaining(['todos', 'auth']))
  })

  it('walks the causal chain when anchorEventId is provided', () => {
    const now = Date.now()
    loopBus.ingest({ id: 'm1', ts: 1, wallTs: now - 100, source: 'state', kind: 'mutation', storeName: 'todos', actor: { type: 'human', name: 'user' }, payload: { prev: {}, next: { x: 1 } } } as any)
    loopBus.ingest({ id: 'g1', ts: 2, wallTs: now - 50, source: 'state', kind: 'gate.flip', storeName: 'todos', causedBy: 'm1', payload: { gate: 'isReady', from: false, to: true } } as any)
    const ctx = buildStateContext({ wallTs: now, anchorEventId: 'g1' })
    expect(ctx).not.toBeNull()
    expect(ctx!.causalChain.map(e => e.id)).toEqual(['g1', 'm1'])
    expect(ctx!.affectedStores).toContain('todos')
  })

  it('respects mutationLimit', () => {
    const now = Date.now()
    for (let i = 0; i < 20; i++) {
      loopBus.ingest({ id: 'm' + i, ts: i, wallTs: now - 200 + i, source: 'state', kind: 'mutation', storeName: 's', actor: { type: 'human', name: 'u' }, payload: { prev: {}, next: { i } } } as any)
    }
    const ctx = buildStateContext({ wallTs: now, mutationLimit: 5 })
    expect(ctx!.recentMutations).toHaveLength(5)
    expect(ctx!.recentMutations[0].id).toBe('m15') // last 5 of m0..m19
    expect(ctx!.recentMutations[4].id).toBe('m19')
  })

  it('does not include mutations after wallTs', () => {
    const now = Date.now()
    loopBus.ingest({ id: 'past', ts: 1, wallTs: now - 100, source: 'state', kind: 'mutation', storeName: 's', actor: { type: 'human', name: 'u' }, payload: {} } as any)
    loopBus.ingest({ id: 'future', ts: 2, wallTs: now + 100, source: 'state', kind: 'mutation', storeName: 's', actor: { type: 'human', name: 'u' }, payload: {} } as any)
    const ctx = buildStateContext({ wallTs: now })
    expect(ctx!.recentMutations.map(m => m.id)).toEqual(['past'])
  })
})
