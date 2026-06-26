// End-to-end smoke test that exercises ALL THREE packages in production wiring:
//   stackpack-state telemetry → ../src/loop-protocol.js wire → debug loop-server
//
// This is the canary that proves the cross-package contract holds after the
// 1.0.0 state release (zod peer-dep change) and the loop-server architecture
// move. If any of the three contracts drifts, this test breaks.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

// state — public API used by an app integrator
import { defineStore, storeRegistry } from 'stackpack-state'
import {
  attachTelemetry,
  createWebSocketTransport,
  type TelemetryHandle,
} from 'stackpack-state/telemetry'

// loop-protocol — used implicitly by both packages (decode test)
import { decodeWireMessage, isLoopEvent } from '../src/loop-protocol.js'

// debug — production server-side terminator
import {
  startLoopServer,
  endpointPath,
  eventsPath,
} from '../src/loop-server.js'
import { loopBus, renderStateResource, renderTimelineResource } from '../src/loop-bus.js'

let cwd: string
let server: { port: number; stop: () => void } | null = null
let handle: TelemetryHandle | null = null

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'spdg-e2e-'))
  loopBus.clear()
  storeRegistry.clear()
})

afterEach(async () => {
  handle?.detach()
  handle = null
  server?.stop()
  server = null
  await new Promise(r => setTimeout(r, 30))
  rmSync(cwd, { recursive: true, force: true })
})

describe('cross-package e2e — state ⇄ loop-protocol ⇄ debug loop-server', () => {
  it('a state mutation reaches debug://state and debug://timeline through the production wire', async () => {
    // 1. Start the production loop server (writes endpoint file, owns the bus).
    server = await startLoopServer(cwd)
    expect(existsSync(endpointPath(cwd))).toBe(true)

    // 2. Attach state telemetry as an integrator would, pointing at the server.
    handle = attachTelemetry({
      transport: createWebSocketTransport({
        url: `ws://127.0.0.1:${server.port}/__stackpack_debug/loop`,
        sessionId: 'e2e-1',
      }),
    })

    // 3. Define a store — state schemas use zod imported by the test, not the package.
    const { store } = defineStore({
      name: 'todos',
      schema: z.object({ items: z.array(z.string()) }),
      initial: { items: [] },
      when: { isEmpty: (s: { items: string[] }) => s.items.length === 0 },
    })

    // 4. Wait for WS handshake.
    await new Promise(r => setTimeout(r, 150))

    // 5. Mutate.
    store.update((d: any) => { d.items.push('first') })

    // 6. Allow the round-trip through the WebSocket.
    await new Promise(r => setTimeout(r, 200))

    // 7. The server-side bus should have ingested the mutation event.
    const events = loopBus.timeline()
    const muts = events.filter(e => e.kind === 'mutation' && e.storeName === 'todos')
    expect(muts.length).toBeGreaterThanOrEqual(1)

    // when.flip should have fired too (isEmpty: true → false).
    const flips = events.filter(e => e.kind === 'when.flip' && e.storeName === 'todos')
    expect(flips.length).toBeGreaterThanOrEqual(1)

    // 8. MCP-shaped resources should render the data.
    const stateMd = renderStateResource()
    expect(stateMd).toContain('todos')
    expect(stateMd).toContain('items')

    const tlMd = renderTimelineResource({})
    expect(tlMd).toContain('mutation')
    expect(tlMd).toContain('todos')

    // 9. Persistence to disk should have occurred — proving the rehydrate path
    //    will work on MCP restart.
    expect(existsSync(eventsPath(cwd))).toBe(true)
    const persistedLines = readFileSync(eventsPath(cwd), 'utf-8').trim().split('\n')
    const persistedEvents = persistedLines.map(l => JSON.parse(l))
    expect(persistedEvents.every(isLoopEvent)).toBe(true)
    expect(persistedEvents.some(e => e.kind === 'mutation' && e.storeName === 'todos')).toBe(true)
  }, 8000)

  it('wire messages from state are decodable via loop-protocol on the debug side', async () => {
    server = await startLoopServer(cwd)

    // Manually open a raw WS to the server, send a hand-crafted wire message,
    // and verify both: (a) the server accepts it (no decode error), (b) it lands
    // in the bus as the same shape state would have produced.
    const { WebSocket } = await import('ws')
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/__stackpack_debug/loop`)
    await new Promise(r => ws.on('open', r))

    // Use loop-protocol's encoders directly — this is the shape state's
    // transport-ws sends, so if the encode/decode contract drifts, this fails.
    const { encodeWireMessage, createLoopEvent, LOOP_PROTOCOL_VERSION } = await import('../src/loop-protocol.js')

    ws.send(encodeWireMessage({
      type: 'loop:hello',
      version: LOOP_PROTOCOL_VERSION,
      producer: 'state',
      sessionId: 'e2e-2',
    }))

    const ev = createLoopEvent({
      source: 'state',
      kind: 'mutation',
      storeName: 'cart',
      payload: { prev: { items: [] }, next: { items: ['a'] } },
    })
    ws.send(encodeWireMessage({ type: 'loop:event', event: ev }))

    await new Promise(r => setTimeout(r, 100))

    expect(loopBus.byEventId(ev.id)).toBeDefined()
    expect(loopBus.byEventId(ev.id)?.storeName).toBe('cart')

    ws.close()
  }, 5000)

  it('garbled or non-wire messages are dropped silently and do not crash the server', async () => {
    server = await startLoopServer(cwd)
    const { WebSocket } = await import('ws')
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/__stackpack_debug/loop`)
    await new Promise(r => ws.on('open', r))

    ws.send('not json')
    ws.send(JSON.stringify({ unknown: 'shape' }))
    ws.send(Buffer.from([0xff, 0xfe, 0xfd])) // raw bytes
    await new Promise(r => setTimeout(r, 50))

    // Bus is still empty — server didn't crash, didn't ingest garbage.
    expect(loopBus.timeline().length).toBe(0)

    // And it can still accept a valid message after the garbage.
    const { encodeWireMessage, createLoopEvent } = await import('../src/loop-protocol.js')
    const ev = createLoopEvent({ source: 'state', kind: 'mutation', storeName: 'x', payload: {} })
    ws.send(encodeWireMessage({ type: 'loop:event', event: ev }))
    await new Promise(r => setTimeout(r, 50))
    expect(loopBus.byEventId(ev.id)).toBeDefined()

    ws.close()
  }, 5000)

  it('decodeWireMessage rejects shapes that violate the protocol (contract pin)', () => {
    // This guards against accidental loosening of the protocol on either side.
    expect(decodeWireMessage('not json')).toBeNull()
    expect(decodeWireMessage(JSON.stringify({ type: 'console', data: {} }))).toBeNull()
    expect(decodeWireMessage(JSON.stringify({ type: 'loop:event' }))).toBeNull()
    expect(decodeWireMessage(JSON.stringify({
      type: 'loop:event',
      event: { id: 'x' }, // missing required fields
    }))).toBeNull()
  })
})
