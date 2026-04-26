import { describe, it, expect, beforeEach } from 'vitest'
import { loopBus, renderTimelineResource } from '../src/loop-bus.js'

describe('debug://timeline', () => {
  beforeEach(() => loopBus.clear())

  it('renders empty placeholder when bus is empty', () => {
    const out = renderTimelineResource({})
    expect(out).toMatch(/empty/)
  })

  it('renders interleaved events in arrival order with causal links', () => {
    loopBus.ingest({ id: 'a', ts: 1, wallTs: 1, source: 'state', kind: 'mutation', storeName: 'todos', payload: { prev: {}, next: { x: 1 } } } as any)
    loopBus.ingest({ id: 'b', ts: 2, wallTs: 2, source: 'browser', kind: 'console.error', payload: { message: 'boom' } } as any)
    loopBus.ingest({ id: 'c', ts: 3, wallTs: 3, source: 'state', kind: 'gate.flip', storeName: 'todos', payload: { gate: 'isEmpty', from: true, to: false }, causedBy: 'a' } as any)
    const out = renderTimelineResource({})
    expect(out.indexOf('mutation')).toBeLessThan(out.indexOf('console.error'))
    expect(out.indexOf('console.error')).toBeLessThan(out.indexOf('gate.flip'))
    expect(out).toContain('caused by: a')
    expect(out).toContain('id=a')
  })

  it('shows actor in the entry when present', () => {
    loopBus.ingest({ id: 'a', ts: 1, wallTs: 1, source: 'state', kind: 'mutation', storeName: 'todos', actor: { type: 'human', name: 'user' }, payload: { prev: {}, next: {} } } as any)
    const out = renderTimelineResource({})
    expect(out).toMatch(/by human:user/)
  })

  it('filters by kinds when provided', () => {
    loopBus.ingest({ id: 'a', ts: 1, wallTs: 1, source: 'state', kind: 'mutation', storeName: 'todos', payload: { prev: {}, next: {} } } as any)
    loopBus.ingest({ id: 'b', ts: 2, wallTs: 2, source: 'browser', kind: 'console.error', payload: { message: 'x' } } as any)
    const out = renderTimelineResource({ kinds: ['mutation'] })
    expect(out).toContain('mutation')
    expect(out).not.toContain('console.error')
  })
})
