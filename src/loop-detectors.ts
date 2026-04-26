import type { LoopBus } from "./loop-bus.js";
import { createLoopEvent, type LoopEvent } from "@stackpack/loop-protocol";

const FLICKER_WINDOW_MS = 500;
const FLICKER_THRESHOLD = 3;
const CASCADE_DEPTH_LIMIT = 5;

interface FlickerState {
  flips: number[];
}

/**
 * Subscribe to a LoopBus and emit warning events when pathological
 * patterns are detected. The caller provides an emit callback so the
 * detector does NOT call bus.ingest() recursively from inside the bus
 * listener (avoiding unbounded recursion).
 *
 * Returns an unsubscribe function.
 */
export function startDetectors(bus: LoopBus, emit: (warning: LoopEvent) => void): () => void {
  const gateFlips = new Map<string, FlickerState>(); // key: storeName/gate

  return bus.on(ev => {
    // Gate flicker — same gate flipped 3+ times within FLICKER_WINDOW_MS.
    if (ev.kind === "gate.flip") {
      const key = `${ev.storeName}/${(ev.payload as any).gate}`;
      const state = gateFlips.get(key) ?? { flips: [] };
      const now = ev.wallTs;
      state.flips = state.flips.filter(t => now - t < FLICKER_WINDOW_MS);
      state.flips.push(now);
      gateFlips.set(key, state);
      if (state.flips.length >= FLICKER_THRESHOLD) {
        emit(createLoopEvent({
          source: "debug",
          kind: "gate.flicker",
          storeName: ev.storeName,
          causedBy: ev.id,
          payload: {
            gate: (ev.payload as any).gate,
            count: state.flips.length,
            windowMs: FLICKER_WINDOW_MS,
          },
        }));
        // Reset the window so we don't fire on every subsequent flip.
        state.flips = [];
      }
    }

    // Effect cascade — chain of effect-actor mutations longer than CASCADE_DEPTH_LIMIT.
    if (ev.kind === "mutation" && ev.causedBy) {
      const chain = bus.causalChain(ev.id, CASCADE_DEPTH_LIMIT + 2);
      if (chain.length > CASCADE_DEPTH_LIMIT) {
        // chain[0] is the current event; the LAST entry is the root cause.
        // Every entry except the root should be an effect for it to qualify.
        const allButRoot = chain.slice(0, -1);
        const allEffects = allButRoot.every(c => c.actor?.type === "effect");
        if (allEffects) {
          emit(createLoopEvent({
            source: "debug",
            kind: "effect.cascade",
            payload: {
              depth: chain.length,
              chain: chain.map(c => c.id),
            },
          }));
        }
      }
    }
  });
}
