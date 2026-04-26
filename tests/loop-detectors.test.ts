import { describe, it, expect, beforeEach } from 'vitest'
import { LoopBus } from '../src/loop-bus.js'
import { startDetectors } from '../src/loop-detectors.js'
import type { LoopEvent } from '@stackpack/loop-protocol'

describe('loop detectors', () => {
  let bus: LoopBus
  let warnings: LoopEvent[]
  let stop: () => void

  beforeEach(() => {
    bus = new LoopBus()
    warnings = []
    stop = startDetectors(bus, w => warnings.push(w))
  })

  it('detects gate flicker (3 flips within 500ms)', () => {
    const now = Date.now()
    for (let i = 0; i < 3; i++) {
      bus.ingest({
        id: 'g' + i,
        ts: i * 100,
        wallTs: now + i * 100,
        source: 'state',
        kind: 'gate.flip',
        storeName: 's',
        payload: { gate: 'g', from: i % 2 === 0, to: i % 2 === 1 },
      } as any)
    }
    const flicker = warnings.find(w => w.kind === 'gate.flicker')
    expect(flicker).toBeDefined()
    expect((flicker!.payload as any).gate).toBe('g')
    expect((flicker!.payload as any).count).toBeGreaterThanOrEqual(3)
    expect(flicker!.storeName).toBe('s')
    stop()
  })

  it('does not detect flicker when flips are far apart in time', () => {
    const now = Date.now()
    for (let i = 0; i < 3; i++) {
      bus.ingest({
        id: 'g' + i,
        ts: i * 1000,
        wallTs: now + i * 1000, // 1s apart, beyond the 500ms window
        source: 'state',
        kind: 'gate.flip',
        storeName: 's',
        payload: { gate: 'g', from: false, to: true },
      } as any)
    }
    expect(warnings.find(w => w.kind === 'gate.flicker')).toBeUndefined()
    stop()
  })

  it('detects effect cascade beyond depth 5', () => {
    let prev = ''
    const now = Date.now()
    for (let i = 0; i < 7; i++) {
      const id = 'm' + i
      bus.ingest({
        id,
        ts: i,
        wallTs: now + i,
        source: 'state',
        kind: 'mutation',
        storeName: 's',
        actor: { type: i === 0 ? 'human' : 'effect', name: 'x' },
        causedBy: prev || undefined,
        payload: {},
      } as any)
      prev = id
    }
    const cascade = warnings.find(w => w.kind === 'effect.cascade')
    expect(cascade).toBeDefined()
    expect((cascade!.payload as any).depth).toBeGreaterThanOrEqual(6)
    stop()
  })

  it('does not detect cascade for short chains', () => {
    let prev = ''
    const now = Date.now()
    for (let i = 0; i < 3; i++) {
      const id = 'm' + i
      bus.ingest({
        id,
        ts: i,
        wallTs: now + i,
        source: 'state',
        kind: 'mutation',
        storeName: 's',
        actor: { type: i === 0 ? 'human' : 'effect', name: 'x' },
        causedBy: prev || undefined,
        payload: {},
      } as any)
      prev = id
    }
    expect(warnings.find(w => w.kind === 'effect.cascade')).toBeUndefined()
    stop()
  })

  it('stop() detaches the listener', () => {
    stop()
    const now = Date.now()
    for (let i = 0; i < 5; i++) {
      bus.ingest({
        id: 'g' + i,
        ts: i,
        wallTs: now + i,
        source: 'state',
        kind: 'gate.flip',
        storeName: 's',
        payload: { gate: 'g', from: false, to: true },
      } as any)
    }
    expect(warnings).toHaveLength(0)
  })

  it('detects presence-leak (item stuck in leaving for 5+ seconds)', () => {
    const now = Date.now()
    bus.ingest({
      id: 'l1',
      ts: 1,
      wallTs: now,
      source: 'state',
      kind: 'presence.leave',
      storeName: 's',
      payload: { path: 'items', id: 'x' },
    } as any)
    // No presence.enter follows. Wait 5 seconds.
    // Use vi.useFakeTimers + advance.
    // We add this with setTimeout, so we need real timers in this test.
    return new Promise<void>(resolve => {
      // Patch the detector to use a faster timeout for the test? No.
      // Instead, since we can't easily fake timers without restructuring,
      // we simulate by manually calling the leak logic. The detector exposes
      // its internal leak check via the emitted event after the timeout.
      setTimeout(() => {
        const leak = warnings.find(w => w.kind === 'presence.leak')
        expect(leak).toBeDefined()
        expect((leak!.payload as any).id).toBe('x')
        expect((leak!.payload as any).path).toBe('items')
        expect(leak!.storeName).toBe('s')
        resolve()
      }, 5200)
    })
  }, 6000)
})
