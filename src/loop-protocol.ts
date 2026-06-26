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

// ── version ───────────────────────────────────────────────────────────────

export const LOOP_PROTOCOL_VERSION = "1" as const;

// ── event ─────────────────────────────────────────────────────────────────

export type LoopSource =
  | "state"
  | "debug"
  | "browser"
  | "terminal"
  | "network"
  | "fs"
  | "agent";

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

const sessionStart = Date.now();
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastUlidTime = 0;
let lastUlidRand: number[] = [];

function encodeTime(t: number, len: number): string {
  let out = "";
  for (let i = len - 1; i >= 0; i--) {
    out = ULID_ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(rand: number[], len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) out += ULID_ALPHABET[rand[i] % 32];
  return out;
}

function generateUlid(): string {
  const now = Date.now();
  let rand: number[];
  if (now === lastUlidTime) {
    // bump previous random for monotonicity within the same ms
    rand = lastUlidRand.slice();
    for (let i = rand.length - 1; i >= 0; i--) {
      if (rand[i] < 31) { rand[i]++; break; }
      rand[i] = 0;
    }
  } else {
    rand = Array.from({ length: 16 }, () => Math.floor(Math.random() * 32));
  }
  lastUlidTime = now;
  lastUlidRand = rand;
  return encodeTime(now, 10) + encodeRandom(rand, 16);
}

export interface CreateLoopEventInput {
  source: LoopSource;
  kind: string;
  payload: unknown;
  storeName?: string;
  actor?: LoopActor;
  causedBy?: string;
}

export function createLoopEvent(input: CreateLoopEventInput): LoopEvent {
  const wall = Date.now();
  return {
    id: generateUlid(),
    ts: wall - sessionStart,
    wallTs: wall,
    source: input.source,
    kind: input.kind,
    storeName: input.storeName,
    actor: input.actor,
    payload: input.payload,
    causedBy: input.causedBy,
  };
}

export function isLoopEvent(x: unknown): x is LoopEvent {
  if (!x || typeof x !== "object") return false;
  const o = x as any;
  return (
    typeof o.id === "string" &&
    typeof o.ts === "number" &&
    typeof o.wallTs === "number" &&
    typeof o.source === "string" &&
    typeof o.kind === "string" &&
    "payload" in o
  );
}

// ── wire ──────────────────────────────────────────────────────────────────

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

export function encodeWireMessage(msg: WireMessage): string {
  return JSON.stringify(msg);
}

export function decodeWireMessage(raw: string): WireMessage | null {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  switch (parsed.type) {
    case "loop:hello":
      if (
        typeof parsed.version === "string" &&
        (parsed.producer === "state" || parsed.producer === "debug") &&
        typeof parsed.sessionId === "string"
      ) return parsed as HelloMsg;
      return null;
    case "loop:event":
      if (isLoopEvent(parsed.event)) return parsed as EventMsg;
      return null;
    case "loop:schema":
      if (typeof parsed.storeName === "string" && "schema" in parsed) return parsed as RegisterSchemaMsg;
      return null;
    default:
      return null;
  }
}
