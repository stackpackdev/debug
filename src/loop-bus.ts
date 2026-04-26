import type { LoopEvent } from '@stackpack/loop-protocol'

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
