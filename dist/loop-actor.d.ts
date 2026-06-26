import type { LoopActor } from "@stackpack/loop-protocol";
/**
 * Returns the actor of the most recent state mutation whose wallTs is <=
 * the given timestamp. Useful for tagging an error with the most likely
 * actor that caused it.
 *
 * Returns null if no qualifying mutation is found.
 */
export declare function attributeError(wallTs: number): LoopActor | null;
