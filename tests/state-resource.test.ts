import { describe, it, expect, beforeEach } from 'vitest'
import { loopBus, renderStateResource } from '../src/loop-bus.js'

describe('debug://state resource', () => {
  beforeEach(() => loopBus.clear())

  it('reports empty when no state events', () => {
    const out = renderStateResource()
    expect(out).toMatch(/no state telemetry/i)
  })

  it('reports last known state per store from mutations', () => {
    loopBus.ingest({
      id: '1', ts: 1, wallTs: 1, source: 'state', kind: 'mutation',
      storeName: 'todos',
      actor: { type: 'human', name: 'user' },
      payload: { prev: { items: [] }, next: { items: ['a'] } },
    } as any)
    loopBus.ingest({
      id: '2', ts: 2, wallTs: 2, source: 'state', kind: 'gate.flip',
      storeName: 'todos',
      payload: { gate: 'isEmpty', from: true, to: false },
    } as any)
    loopBus.ingest({
      id: '3', ts: 3, wallTs: 3, source: 'state', kind: 'when.flip',
      storeName: 'todos',
      payload: { when: 'isLoading', from: true, to: false },
    } as any)

    const out = renderStateResource()
    expect(out).toContain('todos')
    expect(out).toContain('items')
    expect(out).toContain('mutations: 1')
    expect(out).toContain('lastActor: human:user')
    expect(out).toContain('isEmpty: false')
    expect(out).toContain('isLoading: false')
  })

  it('groups events from multiple stores', () => {
    loopBus.ingest({
      id: '1', ts: 1, wallTs: 1, source: 'state', kind: 'mutation',
      storeName: 'todos',
      payload: { prev: {}, next: { x: 1 } },
    } as any)
    loopBus.ingest({
      id: '2', ts: 2, wallTs: 2, source: 'state', kind: 'mutation',
      storeName: 'auth',
      payload: { prev: {}, next: { user: 'a' } },
    } as any)
    const out = renderStateResource()
    expect(out).toContain('## todos')
    expect(out).toContain('## auth')
  })
})
