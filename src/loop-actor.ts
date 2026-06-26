import { loopBus } from "./loop-bus.js";
import type { LoopActor } from "./loop-protocol.js";

/**
 * Returns the actor of the most recent state mutation whose wallTs is <=
 * the given timestamp. Useful for tagging an error with the most likely
 * actor that caused it.
 *
 * Returns null if no qualifying mutation is found.
 */
export function attributeError(wallTs: number): LoopActor | null {
  const mutation = loopBus.lastBefore(wallTs, e => e.kind === "mutation" && !!e.actor);
  return mutation?.actor ?? null;
}
