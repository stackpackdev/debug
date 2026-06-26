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
export const LOOP_PROTOCOL_VERSION = "1";
const sessionStart = Date.now();
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastUlidTime = 0;
let lastUlidRand = [];
function encodeTime(t, len) {
    let out = "";
    for (let i = len - 1; i >= 0; i--) {
        out = ULID_ALPHABET[t % 32] + out;
        t = Math.floor(t / 32);
    }
    return out;
}
function encodeRandom(rand, len) {
    let out = "";
    for (let i = 0; i < len; i++)
        out += ULID_ALPHABET[rand[i] % 32];
    return out;
}
function generateUlid() {
    const now = Date.now();
    let rand;
    if (now === lastUlidTime) {
        // bump previous random for monotonicity within the same ms
        rand = lastUlidRand.slice();
        for (let i = rand.length - 1; i >= 0; i--) {
            if (rand[i] < 31) {
                rand[i]++;
                break;
            }
            rand[i] = 0;
        }
    }
    else {
        rand = Array.from({ length: 16 }, () => Math.floor(Math.random() * 32));
    }
    lastUlidTime = now;
    lastUlidRand = rand;
    return encodeTime(now, 10) + encodeRandom(rand, 16);
}
export function createLoopEvent(input) {
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
export function isLoopEvent(x) {
    if (!x || typeof x !== "object")
        return false;
    const o = x;
    return (typeof o.id === "string" &&
        typeof o.ts === "number" &&
        typeof o.wallTs === "number" &&
        typeof o.source === "string" &&
        typeof o.kind === "string" &&
        "payload" in o);
}
export function encodeWireMessage(msg) {
    return JSON.stringify(msg);
}
export function decodeWireMessage(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object")
        return null;
    switch (parsed.type) {
        case "loop:hello":
            if (typeof parsed.version === "string" &&
                (parsed.producer === "state" || parsed.producer === "debug") &&
                typeof parsed.sessionId === "string")
                return parsed;
            return null;
        case "loop:event":
            if (isLoopEvent(parsed.event))
                return parsed;
            return null;
        case "loop:schema":
            if (typeof parsed.storeName === "string" && "schema" in parsed)
                return parsed;
            return null;
        default:
            return null;
    }
}
//# sourceMappingURL=loop-protocol.js.map