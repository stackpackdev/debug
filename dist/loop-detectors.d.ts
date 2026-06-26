import type { LoopBus } from "./loop-bus.js";
import { type LoopEvent } from "./loop-protocol.js";
/**
 * Subscribe to a LoopBus and emit warning events when pathological
 * patterns are detected. The caller provides an emit callback so the
 * detector does NOT call bus.ingest() recursively from inside the bus
 * listener (avoiding unbounded recursion).
 *
 * Returns an unsubscribe function.
 */
export declare function startDetectors(bus: LoopBus, emit: (warning: LoopEvent) => void): () => void;
