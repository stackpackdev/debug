/**
 * capture-server.ts — Local WebSocket server for browser event capture.
 *
 * Receives events from the browser capture script (console paste)
 * and feeds them into the same ring buffers that serve mode uses.
 * This makes browser-captured errors visible to the watcher,
 * loop detection, and the MCP status resource.
 */

import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface CaptureEvent {
  type: "error" | "rejection" | "console" | "network" | "terminal";
  ts: number;
  source: string;
  message?: string;
  args?: string;
  stack?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  reason?: string;
  method?: string;
  url?: string;
  status?: number;
  error?: string;
  level?: string;
  text?: string;
}

interface CaptureServerOptions {
  port: number;
  cwd: string;
  onEvent?: (event: CaptureEvent) => void;
}

/**
 * Start the local capture server.
 * Returns handles for the HTTP server and a stop function.
 */
export function startCaptureServer(
  opts: CaptureServerOptions,
): { server: Server; stop: () => void; port: number } {
  const { port, cwd, onEvent } = opts;

  const httpServer = createServer((req, res) => {
    // Health check
    if (req.url === "/health" || req.url === "/__spdg/health") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({ status: "ok", captures: eventCount }));
      return;
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/__spdg/ws" });
  let eventCount = 0;

  // Buffer for writing to live-context.json
  const recentErrors: Array<{ timestamp: string; text: string; source: string }> = [];
  const MAX_RECENT = 50;

  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (data: Buffer | string) => {
      try {
        const event = JSON.parse(String(data)) as CaptureEvent;
        eventCount++;

        // Call the event handler
        if (onEvent) onEvent(event);

        // Buffer for live-context
        const text = event.message ?? event.args ?? event.reason ?? event.text ?? event.error ?? "unknown";
        recentErrors.push({
          timestamp: new Date(event.ts ?? Date.now()).toISOString(),
          text: `[${event.type}] ${text}`.slice(0, 500),
          source: event.source ?? "browser",
        });
        if (recentErrors.length > MAX_RECENT) recentErrors.shift();

        // Write to live-context.json so the watcher and MCP can see it
        writeBrowserContext(cwd, recentErrors);
      } catch {
        // Ignore malformed events
      }
    });
  });

  httpServer.listen(port, "127.0.0.1");

  return {
    server: httpServer,
    port,
    stop: () => {
      wss.close();
      httpServer.close();
    },
  };
}

/**
 * Write browser-captured events to live-context.json.
 * Merges with existing terminal/build data if present.
 */
function writeBrowserContext(
  cwd: string,
  events: Array<{ timestamp: string; text: string; source: string }>,
): void {
  const dir = join(cwd, ".debug");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const path = join(dir, "live-context.json");
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(path)) {
      existing = JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch { /* start fresh */ }

  // Merge: keep terminal/build data from serve mode, add browser events
  const merged = {
    ...existing,
    updatedAt: new Date().toISOString(),
    browser: events.map((e) => ({
      timestamp: e.timestamp,
      source: "browser-console" as const,
      data: { level: "error", message: e.text },
    })),
    counts: {
      ...(existing.counts as Record<string, number> ?? {}),
      browser: events.length,
    },
  };

  writeFileSync(path, JSON.stringify(merged));
}
