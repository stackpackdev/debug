import { describe, it, expect, beforeEach } from 'vitest'
import { LoopBus } from '../src/loop-bus.js'

describe('LoopBus', () => {
  let bus: LoopBus
  beforeEach(() => { bus = new LoopBus({ capacity: 100 }) })

  it('records events in arrival order', () => {
    bus.ingest({ id: '01', ts: 1, wallTs: 1, source: 'state', kind: 'mutation', payload: {} } as any)
    bus.ingest({ id: '02', ts: 2, wallTs: 2, source: 'state', kind: 'mutation', payload: {} } as any)
    expect(bus.timeline().map(e => e.id)).toEqual(['01', '02'])
  })

  it('evicts oldest when capacity exceeded', () => {
    const small = new LoopBus({ capacity: 3 })
    for (let i = 1; i <= 5; i++) {
      small.ingest({ id: String(i), ts: i, wallTs: i, source: 'state', kind: 'mutation', payload: {} } as any)
    }
    expect(small.timeline().map(e => e.id)).toEqual(['3', '4', '5'])
  })

  it('walks causal chain backward', () => {
    bus.ingest({ id: 'a', ts: 1, wallTs: 1, source: 'state', kind: 'mutation', payload: {} } as any)
    bus.ingest({ id: 'b', ts: 2, wallTs: 2, source: 'state', kind: 'mutation', payload: {}, causedBy: 'a' } as any)
    bus.ingest({ id: 'c', ts: 3, wallTs: 3, source: 'state', kind: 'mutation', payload: {}, causedBy: 'b' } as any)
    expect(bus.causalChain('c').map(e => e.id)).toEqual(['c', 'b', 'a'])
  })

  it('lastBefore returns most recent event matching predicate before a timestamp', () => {
    bus.ingest({ id: 'a', ts: 1, wallTs: 100, source: 'state', kind: 'mutation', payload: {} } as any)
    bus.ingest({ id: 'b', ts: 2, wallTs: 200, source: 'browser', kind: 'console.error', payload: {} } as any)
    bus.ingest({ id: 'c', ts: 3, wallTs: 300, source: 'state', kind: 'mutation', payload: {} } as any)
    const result = bus.lastBefore(250, e => e.kind === 'mutation')
    expect(result?.id).toBe('a')
  })

  it('on() listener fires synchronously per ingest', () => {
    const seen: string[] = []
    const off = bus.on(ev => { seen.push(ev.id) })
    bus.ingest({ id: 'a', ts: 1, wallTs: 1, source: 'state', kind: 'mutation', payload: {} } as any)
    bus.ingest({ id: 'b', ts: 2, wallTs: 2, source: 'state', kind: 'mutation', payload: {} } as any)
    off()
    bus.ingest({ id: 'c', ts: 3, wallTs: 3, source: 'state', kind: 'mutation', payload: {} } as any)
    expect(seen).toEqual(['a', 'b'])
  })
})
