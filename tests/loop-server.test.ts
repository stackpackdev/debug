import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import {
  createLoopEvent,
  encodeWireMessage,
  LOOP_PROTOCOL_VERSION,
} from '../src/loop-protocol.js'
import { startLoopServer, endpointPath, eventsPath, readEndpoint } from '../src/loop-server.js'
import { loopBus } from '../src/loop-bus.js'

let cwd: string
let handle: { port: number; stop: () => void } | null = null

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'spdg-loop-'))
  loopBus.clear()
})

afterEach(async () => {
  handle?.stop()
  handle = null
  // Wait for the close event to flush before cleaning the dir.
  await new Promise(r => setTimeout(r, 30))
  rmSync(cwd, { recursive: true, force: true })
})

describe('loop-server', () => {
  it('writes endpoint file with port + pid + version', async () => {
    handle = await startLoopServer(cwd)
    expect(existsSync(endpointPath(cwd))).toBe(true)
    const ep = readEndpoint(cwd)
    expect(ep).not.toBeNull()
    expect(ep!.port).toBe(handle.port)
    expect(ep!.pid).toBe(process.pid)
    expect(ep!.version).toBe(LOOP_PROTOCOL_VERSION)
  })

  it('ingests loop:event messages into the bus and persists to JSONL', async () => {
    handle = await startLoopServer(cwd)
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/__stackpack_debug/loop`)
    await new Promise(r => ws.on('open', r))

    const ev = createLoopEvent({
      source: 'state',
      kind: 'mutation',
      storeName: 'todos',
      payload: { prev: { items: [] }, next: { items: ['a'] } },
    })
    ws.send(encodeWireMessage({ type: 'loop:event', event: ev }))

    // Allow the message round-trip and the persistence callback.
    await new Promise(r => setTimeout(r, 50))

    const tl = loopBus.timeline()
    expect(tl.some(e => e.id === ev.id && e.kind === 'mutation')).toBe(true)

    expect(existsSync(eventsPath(cwd))).toBe(true)
    const persisted = readFileSync(eventsPath(cwd), 'utf-8').trim().split('\n')
    expect(persisted.some(l => JSON.parse(l).id === ev.id)).toBe(true)

    ws.close()
  })

  it('drops malformed messages without crashing', async () => {
    handle = await startLoopServer(cwd)
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/__stackpack_debug/loop`)
    await new Promise(r => ws.on('open', r))
    ws.send('not json at all')
    ws.send(JSON.stringify({ type: 'console', data: {} })) // valid JSON, wrong shape
    await new Promise(r => setTimeout(r, 30))
    expect(loopBus.timeline().length).toBe(0)
    ws.close()
  })

  it('removes endpoint file on stop', async () => {
    handle = await startLoopServer(cwd)
    expect(existsSync(endpointPath(cwd))).toBe(true)
    handle.stop()
    handle = null
    expect(existsSync(endpointPath(cwd))).toBe(false)
  })
})
