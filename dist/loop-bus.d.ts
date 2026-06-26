import type { LoopEvent, LoopActor } from '@stackpack/loop-protocol';
export interface LoopBusOptions {
    /** Ring-buffer capacity. Older events are dropped when exceeded. Default 5000. */
    capacity?: number;
}
type Listener = (ev: LoopEvent) => void;
export declare class LoopBus {
    private events;
    private byId;
    private listeners;
    private capacity;
    constructor(opts?: LoopBusOptions);
    ingest(ev: LoopEvent): void;
    timeline(filter?: {
        sinceMs?: number;
        kinds?: string[];
        storeName?: string;
    }): LoopEvent[];
    byEventId(id: string): LoopEvent | undefined;
    /** Walk the causal chain backward from `id`, up to `max` events. The result starts with the requested event. */
    causalChain(id: string, max?: number): LoopEvent[];
    /** Most recent event matching `predicate` whose `wallTs` is <= the given timestamp. */
    lastBefore(wallTs: number, predicate: (e: LoopEvent) => boolean): LoopEvent | undefined;
    on(fn: Listener): () => void;
    /** Empty the bus — drops all stored events. Listeners are NOT detached. */
    clear(): void;
}
export declare const loopBus: LoopBus;
/**
 * Render a markdown summary of all stores currently visible in the LoopBus,
 * derived from the event stream. Returns an "empty" message if no state
 * telemetry has been seen.
 */
export declare function renderStateResource(): string;
/**
 * Render the LoopBus event stream as markdown — interleaving state, browser,
 * terminal, and other source events in chronological order with causal links.
 */
export declare function renderTimelineResource(opts: {
    sinceMs?: number;
    kinds?: string[];
    storeName?: string;
}): string;
export interface StateContext {
    recentMutations: LoopEvent[];
    lastActor: LoopActor | null;
    affectedStores: string[];
    causalChain: LoopEvent[];
}
/**
 * Build a state-context summary for inclusion in debug_investigate responses.
 * Returns null when the LoopBus has no state events (caller should omit the
 * stateContext field entirely in that case).
 */
export declare function buildStateContext(opts: {
    wallTs: number;
    anchorEventId?: string;
    mutationLimit?: number;
}): StateContext | null;
/**
 * Render detector warnings (gate.flicker, effect.cascade, presence.leak)
 * as a small markdown section, suitable for splicing into debug://status
 * or debug://errors. Returns an empty string when there are no warnings.
 */
export declare function renderDetectorWarnings(): string;
export {};
