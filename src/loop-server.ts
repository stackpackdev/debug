/**
 * loop-server.ts — MCP-hosted WebSocket terminator for The Loop.
 *
 * Owns the singleton LoopBus. Accepts wire messages from upstream producers
 * (state telemetry directly, or the dev-server proxy forwarding browser/state
 * events). Persists events to .debug/loop-events.jsonl as a write-through
 * ring buffer; rehydrates on startup so an MCP restart doesn't lose history.
 *
 * Endpoint advertisement: writes .debug/mcp.endpoint.json with
 * { port, pid, version } so that the proxy and the vite-plugin can find us.
 */

import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  statSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
  decodeWireMessage,
  isLoopEvent,
  LOOP_PROTOCOL_VERSION,
  type LoopEvent,
} from "@stackpack/loop-protocol";
import { loopBus } from "./loop-bus.js";

const ENDPOINT_FILENAME = "mcp.endpoint.json";
const EVENTS_FILENAME = "loop-events.jsonl";
const RING_LIMIT = 5000;
const ROTATE_AT = RING_LIMIT * 2; // when file exceeds 2x cap, compact to last RING_LIMIT lines

export interface LoopServerHandle {
  port: number;
  stop: () => void;
}

interface EndpointFile {
  port: number;
  pid: number;
  version: string;
  startedAt: string;
}

function debugDir(cwd: string): string {
  const dir = join(cwd, ".debug");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function endpointPath(cwd: string): string {
  return join(debugDir(cwd), ENDPOINT_FILENAME);
}

export function eventsPath(cwd: string): string {
  return join(debugDir(cwd), EVENTS_FILENAME);
}

/** Replay persisted events into the bus. Returns the count rehydrated. */
export function rehydrateFromDisk(cwd: string): number {
  const path = eventsPath(cwd);
  if (!existsSync(path)) return 0;

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return 0;
  }
  // Take only the tail; older lines are out of the ring.
  const lines = raw.split("\n").filter(l => l.length > 0).slice(-RING_LIMIT);
  let n = 0;
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (isLoopEvent(ev)) {
        loopBus.ingest(ev);
        n++;
      }
    } catch { /* skip torn lines */ }
  }
  return n;
}

/**
 * Compact the JSONL ring file when it exceeds ROTATE_AT lines, by rewriting
 * just the last RING_LIMIT lines atomically. Cheap because it's amortised.
 */
function maybeCompact(path: string): void {
  let size = 0;
  try { size = statSync(path).size; } catch { return; }
  // Heuristic: only attempt compaction when file is large enough to bother.
  // A typical event line is ~200 bytes; ROTATE_AT * 200 ≈ 2 MB.
  if (size < ROTATE_AT * 200) return;

  let raw: string;
  try { raw = readFileSync(path, "utf-8"); } catch { return; }
  const lines = raw.split("\n").filter(l => l.length > 0);
  if (lines.length <= ROTATE_AT) return;

  const tail = lines.slice(-RING_LIMIT).join("\n") + "\n";
  const tmp = path + ".tmp";
  try {
    writeFileSync(tmp, tail);
    renameSync(tmp, path);
  } catch {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** Append a single event to the persistence ring (best-effort, never throws). */
function persistEvent(cwd: string, ev: LoopEvent): void {
  const path = eventsPath(cwd);
  try {
    appendFileSync(path, JSON.stringify(ev) + "\n");
  } catch { /* persistence is best-effort */ }
  // Compact occasionally — checking statSync every event is cheap enough.
  if (Math.random() < 0.01) maybeCompact(path);
}

function wirePersistence(cwd: string): () => void {
  return loopBus.on(ev => persistEvent(cwd, ev));
}

/**
 * Start the MCP-hosted WebSocket server. Binds to 127.0.0.1 on an
 * OS-assigned port, writes the endpoint file, and rehydrates the bus.
 */
export function startLoopServer(cwd: string): Promise<LoopServerHandle> {
  return new Promise((resolve, reject) => {
    const httpServer: Server = createServer((_req, res) => {
      // Health check — useful for proxy connect retries.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: LOOP_PROTOCOL_VERSION }));
    });

    const wss = new WebSocketServer({ server: httpServer, path: "/__stackpack_debug/loop" });

    wss.on("connection", (ws: WebSocket) => {
      ws.on("message", (data: Buffer | string) => {
        const raw = typeof data === "string" ? data : data.toString("utf-8");
        const msg = decodeWireMessage(raw);
        if (!msg) return; // silently drop garbage
        if (msg.type === "loop:event") {
          loopBus.ingest(msg.event);
        }
        // hello and schema messages are accepted but not yet acted upon —
        // schema registry is a v2 feature.
      });
      ws.on("error", () => { /* client errors don't kill the server */ });
    });

    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("loop-server failed to bind"));
        return;
      }
      const port = addr.port;

      // Write the endpoint advert before completing so consumers don't race.
      const endpoint: EndpointFile = {
        port,
        pid: process.pid,
        version: LOOP_PROTOCOL_VERSION,
        startedAt: new Date().toISOString(),
      };
      try {
        writeFileSync(endpointPath(cwd), JSON.stringify(endpoint, null, 2));
      } catch (e) {
        reject(e);
        return;
      }

      // Hook persistence — returns an unsubscribe so we can detach on stop.
      const unwirePersistence = wirePersistence(cwd);

      resolve({
        port,
        stop: () => {
          unwirePersistence();
          try { wss.close(); } catch { /* ignore */ }
          try { httpServer.close(); } catch { /* ignore */ }
          // Best-effort: remove the endpoint file so stale entries don't mislead.
          try { unlinkSync(endpointPath(cwd)); } catch { /* ignore */ }
        },
      });
    });
  });
}

/**
 * Read the endpoint file written by a running MCP loop server.
 * Returns null when the file is missing, malformed, or the recorded pid
 * is no longer alive.
 */
export function readEndpoint(cwd: string): EndpointFile | null {
  const path = endpointPath(cwd);
  if (!existsSync(path)) return null;
  let parsed: EndpointFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as EndpointFile;
  } catch {
    return null;
  }
  if (typeof parsed.port !== "number" || typeof parsed.pid !== "number") return null;
  // pid liveness check — process.kill(pid, 0) throws if not alive.
  try { process.kill(parsed.pid, 0); } catch { return null; }
  return parsed;
}
