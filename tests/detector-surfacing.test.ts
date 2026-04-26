import { describe, it, expect, beforeEach } from 'vitest'
import { loopBus, renderDetectorWarnings } from '../src/loop-bus.js'

describe('renderDetectorWarnings', () => {
  beforeEach(() => loopBus.clear())

  it('returns empty string when no detector warnings', () => {
    expect(renderDetectorWarnings()).toBe('')
  })

  it('renders gate.flicker warnings', () => {
    loopBus.ingest({
      id: 'w1', ts: 1, wallTs: 1, source: 'debug', kind: 'gate.flicker',
      storeName: 'auth',
      payload: { gate: 'isLoggedIn', count: 3, windowMs: 500 },
    } as any)
    const out = renderDetectorWarnings()
    expect(out).toContain('gate.flicker')
    expect(out).toContain('auth')
    expect(out).toContain('isLoggedIn')
    expect(out).toContain('3')
  })

  it('renders effect.cascade warnings', () => {
    loopBus.ingest({
      id: 'w1', ts: 1, wallTs: 1, source: 'debug', kind: 'effect.cascade',
      payload: { depth: 6, chain: ['a', 'b', 'c', 'd', 'e', 'f'] },
    } as any)
    const out = renderDetectorWarnings()
    expect(out).toContain('effect.cascade')
    expect(out).toContain('6')
  })

  it('renders presence.leak warnings', () => {
    loopBus.ingest({
      id: 'w1', ts: 1, wallTs: 1, source: 'debug', kind: 'presence.leak',
      storeName: 's',
      payload: { path: 'items', id: 'x', stuckMs: 5000 },
    } as any)
    const out = renderDetectorWarnings()
    expect(out).toContain('presence.leak')
    expect(out).toContain('s')
    expect(out).toContain('x')
    expect(out).toContain('5000')
  })

  it('renders all kinds together', () => {
    loopBus.ingest({ id: 'w1', ts: 1, wallTs: 1, source: 'debug', kind: 'gate.flicker', storeName: 'a', payload: { gate: 'g', count: 3, windowMs: 500 } } as any)
    loopBus.ingest({ id: 'w2', ts: 2, wallTs: 2, source: 'debug', kind: 'effect.cascade', payload: { depth: 6, chain: [] } } as any)
    loopBus.ingest({ id: 'w3', ts: 3, wallTs: 3, source: 'debug', kind: 'presence.leak', storeName: 'b', payload: { path: 'items', id: 'x', stuckMs: 5000 } } as any)
    const out = renderDetectorWarnings()
    expect(out).toContain('gate.flicker')
    expect(out).toContain('effect.cascade')
    expect(out).toContain('presence.leak')
    expect(out).toContain('## Loop detectors')
  })
})
