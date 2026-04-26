import { describe, it, expect } from 'vitest'
import { stackpackDebug } from '../src/vite-plugin.js'

function callTransform(plugin: any, html: string, ctx: any = {}): Promise<string> {
  const t = plugin.transformIndexHtml
  if (!t) return Promise.resolve(html)
  if (typeof t === 'function') {
    return Promise.resolve(t.call(plugin, html, ctx))
      .then((r: any) => typeof r === 'string' ? r : (r?.html ?? html))
  }
  if (typeof t.handler === 'function') {
    return Promise.resolve(t.handler.call(plugin, html, ctx))
      .then((r: any) => typeof r === 'string' ? r : (r?.html ?? html))
  }
  return Promise.resolve(html)
}

describe('vite plugin — autoAttach injection', () => {
  it('injects an autoAttach script when stateTelemetry: true', async () => {
    const plugin: any = stackpackDebug({ stateTelemetry: true })
    const html = '<html><head></head><body></body></html>'
    const out = await callTransform(plugin, html, { server: { config: { command: 'serve' } } })
    expect(out).toContain('stackpack-state/telemetry')
    expect(out).toContain('autoAttach')
  })

  it('does not inject when stateTelemetry is false', async () => {
    const plugin: any = stackpackDebug({ stateTelemetry: false })
    const html = '<html><head></head><body></body></html>'
    const out = await callTransform(plugin, html, { server: { config: { command: 'serve' } } })
    expect(out).not.toContain('stackpack-state/telemetry')
  })

  it('does not inject when stateTelemetry option is omitted', async () => {
    const plugin: any = stackpackDebug({})
    const html = '<html><head></head><body></body></html>'
    const out = await callTransform(plugin, html, { server: { config: { command: 'serve' } } })
    expect(out).not.toContain('stackpack-state/telemetry')
  })
})
