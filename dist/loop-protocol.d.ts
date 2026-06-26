/**
 * loop-protocol.ts — vendored copy of the @stackpack/loop-protocol package.
 *
 * The Loop wire protocol is shared by stackpack-state, stackpack-debug, and
 * observe. To keep stackpack-debug publishable as a single self-contained npm
 * package (no external @stackpack/* dependency), the protocol is inlined here.
 *
 * Source of truth lives in the loop-protocol package; this is a verbatim copy of
 * its event + wire definitions. Keep in sync if the protocol changes.
 */
export declare const LOOP_PROTOCOL_VERSION: "1";
export type LoopSource = "state" | "debug" | "browser" | "terminal" | "network" | "fs" | "agent";
export type LoopActor = {
    type: "human" | "agent" | "effect" | "system";
    id?: string;
    name?: string;
};
export interface LoopEvent {
    id: string;
    ts: number;
    wallTs: number;
    source: LoopSource;
    kind: string;
    storeName?: string;
    actor?: LoopActor;
    payload: unknown;
    causedBy?: string;
}
export interface CreateLoopEventInput {
    source: LoopSource;
    kind: string;
    payload: unknown;
    storeName?: string;
    actor?: LoopActor;
    causedBy?: string;
}
export declare function createLoopEvent(input: CreateLoopEventInput): LoopEvent;
export declare function isLoopEvent(x: unknown): x is LoopEvent;
export interface HelloMsg {
    type: "loop:hello";
    version: string;
    producer: "state" | "debug";
    sessionId: string;
}
export interface EventMsg {
    type: "loop:event";
    event: LoopEvent;
}
export interface RegisterSchemaMsg {
    type: "loop:schema";
    storeName: string;
    /** JSON-serialised Zod schema description. */
    schema: unknown;
}
export type WireMessage = HelloMsg | EventMsg | RegisterSchemaMsg;
export declare function encodeWireMessage(msg: WireMessage): string;
export declare function decodeWireMessage(raw: string): WireMessage | null;
