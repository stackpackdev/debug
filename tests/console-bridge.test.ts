import { describe, it, expect, beforeEach } from 'vitest'
import { loopBus } from '../src/loop-bus.js'
import { ingestBrowserMessage } from '../src/capture-server.js'

describe('console-bridge', () => {
  beforeEach(() => loopBus.clear())

  it('ingests console.error as a loop event', () => {
    ingestBrowserMessage({ type: 'console', data: { level: 'error', args: ['boom'] }, ts: 1234 })
    const evs = loopBus.timeline().filter(e => e.kind === 'console.error')
    expect(evs).toHaveLength(1)
    expect((evs[0].payload as any).message).toContain('boom')
    expect(evs[0].source).toBe('browser')
  })

  it('ingests console.warn', () => {
    ingestBrowserMessage({ type: 'console', data: { level: 'warn', args: ['careful'] }, ts: 1234 })
    expect(loopBus.timeline().filter(e => e.kind === 'console.warn')).toHaveLength(1)
  })

  it('ignores console.log', () => {
    ingestBrowserMessage({ type: 'console', data: { level: 'log', args: ['hi'] }, ts: 1234 })
    expect(loopBus.timeline().filter(e => e.kind.startsWith('console.'))).toHaveLength(0)
  })

  it('ingests window.error', () => {
    ingestBrowserMessage({ type: 'error', data: { message: 'oops', source: 'app.js', line: 5 }, ts: 1 })
    const evs = loopBus.timeline().filter(e => e.kind === 'window.error')
    expect(evs).toHaveLength(1)
    expect((evs[0].payload as any).message).toBe('oops')
    expect((evs[0].payload as any).source).toBe('app.js')
  })

  it('ingests unhandledrejection', () => {
    ingestBrowserMessage({ type: 'unhandledrejection', data: { reason: 'rejected' }, ts: 1 })
    expect(loopBus.timeline().filter(e => e.kind === 'unhandled.rejection')).toHaveLength(1)
  })
})
