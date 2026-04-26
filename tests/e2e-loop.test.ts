import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import { defineStore, storeRegistry } from 'stackpack-state'
import { attachTelemetry, createWebSocketTransport, type TelemetryHandle } from 'stackpack-state/telemetry'
import { decodeWireMessage } from '@stackpack/loop-protocol'
import { loopBus, renderStateResource, renderTimelineResource } from '../src/loop-bus.js'

let wss: WebSocketServer
let port: number

beforeAll(async () => {
  // Stand up a tiny WS server on a random port at the path state's autoAttach uses.
  wss = new WebSocketServer({ port: 0, path: '/__stackpack_debug/ws' })
  port = (wss.address() as any).port
  wss.on('connection', ws => {
    ws.on('message', raw => {
      const msg = decodeWireMessage(raw.toString())
      if (msg?.type === 'loop:event') loopBus.ingest(msg.event)
    })
  })
})

afterAll(() => {
  wss.close()
})

let handle: TelemetryHandle | null = null

beforeEach(() => {
  // Reset state and bus for this test.
  storeRegistry.clear()
  loopBus.clear()
})

describe('e2e — state to debug via WebSocket', () => {
  it('mutation and when.flip arrive at the debug LoopBus and render correctly', async () => {
    handle = attachTelemetry({
      transport: createWebSocketTransport({
        url: `ws://localhost:${port}/__stackpack_debug/ws`,
        sessionId: 'e2e',
      }),
    })

    const { store } = defineStore({
      name: 'todos',
      schema: z.object({ items: z.array(z.string()) }),
      initial: { items: [] },
      when: { isEmpty: (s: { items: string[] }) => s.items.length === 0 },
    })

    // Wait for WS handshake to complete and hello message to be sent.
    await new Promise(r => setTimeout(r, 150))

    // Trigger a mutation.
    store.update((d: any) => { d.items.push('a') })

    // Allow the message round-trip.
    await new Promise(r => setTimeout(r, 200))

    const tl = loopBus.timeline()
    expect(tl.length).toBeGreaterThan(0)
    const muts = tl.filter(e => e.kind === 'mutation' && e.storeName === 'todos')
    expect(muts.length).toBeGreaterThanOrEqual(1)
    const flips = tl.filter(e => e.kind === 'when.flip' && e.storeName === 'todos')
    expect(flips.length).toBeGreaterThanOrEqual(1)

    // Render output should mention the store.
    const stateMd = renderStateResource()
    expect(stateMd).toContain('todos')
    expect(stateMd).toContain('items')

    // Timeline should contain the mutation entry.
    const tlMd = renderTimelineResource({})
    expect(tlMd).toContain('mutation')
    expect(tlMd).toContain('todos')

    // Cleanup.
    handle.detach()
    handle = null
  }, 5000)
})
