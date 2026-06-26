import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import {
  createLoopEvent,
  decodeWireMessage,
  encodeWireMessage,
  LOOP_PROTOCOL_VERSION,
} from '../src/loop-protocol.js'
import { startProxy } from '../src/proxy.js'

interface UpstreamServer {
  port: number
  received: any[]
  stop: () => Promise<void>
}

async function startUpstream(): Promise<UpstreamServer> {
  const received: any[] = []
  const httpServer = createServer((_req, res) => res.end('ok'))
  const wss = new WebSocketServer({ server: httpServer, path: '/__stackpack_debug/loop' })
  wss.on('connection', ws => {
    ws.on('message', raw => {
      const msg = decodeWireMessage(raw.toString())
      if (msg) received.push(msg)
    })
  })
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const addr = httpServer.address() as any
  return {
    port: addr.port,
    received,
    stop: () => new Promise(r => { wss.close(); httpServer.close(() => r()) }),
  }
}

async function startTargetDevServer(): Promise<{ port: number; stop: () => Promise<void> }> {
  // Empty HTTP server — proxy forwards to it for non-WS traffic, but we don't
  // exercise that here. We just need a port that exists.
  const httpServer: Server = createServer((_req, res) => res.end('dev'))
  await new Promise<void>(r => httpServer.listen(0, '127.0.0.1', () => r()))
  const addr = httpServer.address() as any
  return {
    port: addr.port,
    stop: () => new Promise(r => httpServer.close(() => r())),
  }
}

let cwd: string
let upstream: UpstreamServer | null = null
let target: { port: number; stop: () => Promise<void> } | null = null
let proxyHandle: { close: () => void } | null = null

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), 'spdg-proxy-'))
  mkdirSync(join(cwd, '.debug'), { recursive: true })
})

afterEach(async () => {
  proxyHandle?.close()
  proxyHandle = null
  await upstream?.stop()
  upstream = null
  await target?.stop()
  target = null
  await new Promise(r => setTimeout(r, 30))
  rmSync(cwd, { recursive: true, force: true })
})

describe('proxy → loop forwarder', () => {
  it('forwards loop:event messages from page WS to upstream MCP loop server', async () => {
    upstream = await startUpstream()
    target = await startTargetDevServer()

    // Advertise the upstream as if it were a running MCP loop server.
    writeFileSync(
      join(cwd, '.debug', 'mcp.endpoint.json'),
      JSON.stringify({ port: upstream.port, pid: process.pid, version: LOOP_PROTOCOL_VERSION, startedAt: new Date().toISOString() }),
    )

    proxyHandle = startProxy({ targetPort: target.port, listenPort: 0, cwd })
    // listenPort: 0 is supported by createServer — extract it from the listener.
    // Since startProxy doesn't return the port, find a free port up front.
    proxyHandle.close()
    proxyHandle = null

    // Pick a known free port for the proxy.
    const probe = await new Promise<number>(resolve => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as any).port
        s.close(() => resolve(p))
      })
    })
    proxyHandle = startProxy({ targetPort: target.port, listenPort: probe, cwd })

    // Give the proxy a beat to bind and connect upstream.
    await new Promise(r => setTimeout(r, 150))

    const pageWs = new WebSocket(`ws://127.0.0.1:${probe}/__stackpack_debug/ws`)
    await new Promise<void>(resolve => pageWs.on('open', () => resolve()))

    const ev = createLoopEvent({
      source: 'state',
      kind: 'mutation',
      storeName: 'todos',
      payload: { prev: { items: [] }, next: { items: ['a'] } },
    })
    pageWs.send(encodeWireMessage({ type: 'loop:event', event: ev }))

    // Wait for forwarder to relay.
    await new Promise(r => setTimeout(r, 200))

    expect(upstream.received.some(m => m.type === 'loop:event' && m.event.id === ev.id)).toBe(true)

    pageWs.close()
  }, 8000)

  it('wraps browser console errors as loop:event upstream', async () => {
    upstream = await startUpstream()
    target = await startTargetDevServer()
    writeFileSync(
      join(cwd, '.debug', 'mcp.endpoint.json'),
      JSON.stringify({ port: upstream.port, pid: process.pid, version: LOOP_PROTOCOL_VERSION, startedAt: new Date().toISOString() }),
    )

    const probe = await new Promise<number>(resolve => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as any).port
        s.close(() => resolve(p))
      })
    })
    proxyHandle = startProxy({ targetPort: target.port, listenPort: probe, cwd })
    await new Promise(r => setTimeout(r, 150))

    const pageWs = new WebSocket(`ws://127.0.0.1:${probe}/__stackpack_debug/ws`)
    await new Promise<void>(resolve => pageWs.on('open', () => resolve()))

    pageWs.send(JSON.stringify({ type: 'console', data: { level: 'error', args: ['boom'] }, ts: Date.now() }))

    await new Promise(r => setTimeout(r, 200))

    const wrapped = upstream.received.find(
      m => m.type === 'loop:event' && m.event.source === 'browser' && m.event.kind === 'console.error',
    )
    expect(wrapped).toBeTruthy()
    expect((wrapped!.event.payload as any).message).toBe('boom')

    pageWs.close()
  }, 8000)
})
