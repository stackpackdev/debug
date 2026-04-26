import type { LoopEvent, LoopActor } from '@stackpack/loop-protocol'

export interface LoopBusOptions {
  /** Ring-buffer capacity. Older events are dropped when exceeded. Default 5000. */
  capacity?: number
}

type Listener = (ev: LoopEvent) => void

export class LoopBus {
  private events: LoopEvent[] = []
  private byId = new Map<string, LoopEvent>()
  private listeners = new Set<Listener>()
  private capacity: number

  constructor(opts: LoopBusOptions = {}) {
    this.capacity = opts.capacity ?? 5000
  }

  ingest(ev: LoopEvent): void {
    this.events.push(ev)
    this.byId.set(ev.id, ev)
    while (this.events.length > this.capacity) {
      const dropped = this.events.shift()!
      this.byId.delete(dropped.id)
    }
    for (const l of this.listeners) {
      try { l(ev) } catch { /* swallow listener errors */ }
    }
  }

  timeline(filter?: { sinceMs?: number; kinds?: string[]; storeName?: string }): LoopEvent[] {
    const cutoff = filter?.sinceMs != null ? Date.now() - filter.sinceMs : -Infinity
    return this.events.filter(e =>
      e.wallTs >= cutoff &&
      (!filter?.kinds || filter.kinds.includes(e.kind)) &&
      (!filter?.storeName || e.storeName === filter.storeName)
    )
  }

  byEventId(id: string): LoopEvent | undefined {
    return this.byId.get(id)
  }

  /** Walk the causal chain backward from `id`, up to `max` events. The result starts with the requested event. */
  causalChain(id: string, max: number = 50): LoopEvent[] {
    const out: LoopEvent[] = []
    let cur: LoopEvent | undefined = this.byId.get(id)
    let n = 0
    while (cur && n < max) {
      out.push(cur)
      if (!cur.causedBy) break
      cur = this.byId.get(cur.causedBy)
      n++
    }
    return out
  }

  /** Most recent event matching `predicate` whose `wallTs` is <= the given timestamp. */
  lastBefore(wallTs: number, predicate: (e: LoopEvent) => boolean): LoopEvent | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]
      if (e.wallTs <= wallTs && predicate(e)) return e
    }
    return undefined
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Empty the bus — drops all stored events. Listeners are NOT detached. */
  clear(): void {
    this.events = []
    this.byId.clear()
  }
}

// Singleton instance used by the rest of debug.
export const loopBus = new LoopBus()

/**
 * Render a markdown summary of all stores currently visible in the LoopBus,
 * derived from the event stream. Returns an "empty" message if no state
 * telemetry has been seen.
 */
export function renderStateResource(): string {
  const all = loopBus.timeline()
  const byStore = new Map<string, {
    state?: unknown
    gates: Record<string, boolean>
    when: Record<string, boolean>
    lastActor?: string
    mutations: number
  }>()

  for (const e of all) {
    if (e.source !== 'state' || !e.storeName) continue
    const cur = byStore.get(e.storeName) ?? { gates: {}, when: {}, mutations: 0 }
    if (e.kind === 'mutation') {
      cur.state = (e.payload as any).next
      cur.mutations += 1
      if (e.actor) cur.lastActor = `${e.actor.type}:${e.actor.name ?? e.actor.id ?? '?'}`
    } else if (e.kind === 'gate.flip') {
      cur.gates[(e.payload as any).gate] = (e.payload as any).to
    } else if (e.kind === 'when.flip') {
      cur.when[(e.payload as any).when] = (e.payload as any).to
    }
    byStore.set(e.storeName, cur)
  }

  if (byStore.size === 0) {
    return '# debug://state\n\nNo state telemetry received yet. Ensure stackpack-state has called `attachTelemetry` or `autoAttach`.'
  }

  const lines: string[] = ['# debug://state', '']
  for (const [name, info] of byStore) {
    lines.push(`## ${name}`)
    lines.push(`- mutations: ${info.mutations}`)
    if (info.lastActor) lines.push(`- lastActor: ${info.lastActor}`)
    lines.push(`- state: ${JSON.stringify(info.state)}`)
    if (Object.keys(info.gates).length) {
      const g = Object.entries(info.gates).map(([k, v]) => `${k}: ${v}`).join(', ')
      lines.push(`- gates: ${g}`)
    }
    if (Object.keys(info.when).length) {
      const w = Object.entries(info.when).map(([k, v]) => `${k}: ${v}`).join(', ')
      lines.push(`- when: ${w}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function truncate(s: string, max = 120): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}

function summarisePayload(kind: string, payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const p = payload as any
  if (kind === 'mutation') return `next=${truncate(JSON.stringify(p.next))}`
  if (kind === 'gate.flip') return `${p.gate}: ${p.from}→${p.to}`
  if (kind === 'when.flip') return `${p.when}: ${p.from}→${p.to}`
  if (kind === 'console.error' || kind === 'console.warn') return truncate(String(p.message ?? ''))
  if (kind === 'window.error') return truncate(String(p.message ?? ''))
  if (kind === 'unhandled.rejection') return truncate(String(p.reason ?? ''))
  return truncate(JSON.stringify(p))
}

/**
 * Render the LoopBus event stream as markdown — interleaving state, browser,
 * terminal, and other source events in chronological order with causal links.
 */
export function renderTimelineResource(opts: { sinceMs?: number; kinds?: string[]; storeName?: string }): string {
  const events = loopBus.timeline(opts)
  if (events.length === 0) return '# debug://timeline\n\n(empty — no events captured)'

  const lines: string[] = ['# debug://timeline', '']
  for (const e of events) {
    const tag = e.storeName ? `${e.source}/${e.storeName}` : e.source
    const actor = e.actor ? ` by ${e.actor.type}:${e.actor.name ?? e.actor.id ?? '?'}` : ''
    const cause = e.causedBy ? ` (caused by: ${e.causedBy})` : ''
    const summary = summarisePayload(e.kind, e.payload)
    const summaryTail = summary ? ' ' + summary : ''
    lines.push(`[${e.ts}ms] ${tag} ${e.kind}${actor}${cause}${summaryTail} <id=${e.id}>`)
  }
  return lines.join('\n')
}

export interface StateContext {
  recentMutations: LoopEvent[]
  lastActor: LoopActor | null
  affectedStores: string[]
  causalChain: LoopEvent[]
}

/**
 * Build a state-context summary for inclusion in debug_investigate responses.
 * Returns null when the LoopBus has no state events (caller should omit the
 * stateContext field entirely in that case).
 */
export function buildStateContext(opts: {
  wallTs: number
  anchorEventId?: string
  mutationLimit?: number
}): StateContext | null {
  // Short-circuit: no state telemetry means no context to return.
  const hasAnyStateEvent = loopBus.timeline().some(e => e.source === 'state')
  if (!hasAnyStateEvent) return null

  const limit = opts.mutationLimit ?? 10
  const allMutations = loopBus.timeline()
    .filter(e => e.source === 'state' && e.kind === 'mutation' && e.wallTs <= opts.wallTs)
  const recentMutations = allMutations.slice(-limit)
  const lastActor = recentMutations.length ? (recentMutations[recentMutations.length - 1].actor ?? null) : null

  const causalChain = opts.anchorEventId ? loopBus.causalChain(opts.anchorEventId) : []

  const stores = new Set<string>()
  for (const e of recentMutations) if (e.storeName) stores.add(e.storeName)
  for (const e of causalChain) if (e.storeName) stores.add(e.storeName)

  return {
    recentMutations,
    lastActor,
    affectedStores: Array.from(stores),
    causalChain,
  }
}

/**
 * Render detector warnings (gate.flicker, effect.cascade, presence.leak)
 * as a small markdown section, suitable for splicing into debug://status
 * or debug://errors. Returns an empty string when there are no warnings.
 */
export function renderDetectorWarnings(): string {
  const warnings = loopBus.timeline().filter(e =>
    e.source === 'debug' && (
      e.kind === 'gate.flicker' ||
      e.kind === 'effect.cascade' ||
      e.kind === 'presence.leak'
    )
  )
  if (warnings.length === 0) return ''

  const lines: string[] = ['## Loop detectors', '']
  for (const w of warnings) {
    if (w.kind === 'gate.flicker') {
      const p = w.payload as any
      lines.push(`- gate.flicker — ${w.storeName}/${p.gate}: ${p.count} flips in ${p.windowMs}ms`)
    } else if (w.kind === 'effect.cascade') {
      const p = w.payload as any
      lines.push(`- effect.cascade — depth ${p.depth}`)
    } else if (w.kind === 'presence.leak') {
      const p = w.payload as any
      lines.push(`- presence.leak — ${w.storeName} item ${p.id} (path: ${p.path}) stuck for ${p.stuckMs}ms`)
    }
  }
  return lines.join('\n')
}
