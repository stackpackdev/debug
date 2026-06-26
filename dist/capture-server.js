/**
 * capture-server.ts — Local WebSocket server for browser event capture.
 *
 * Receives events from the browser capture script (console paste)
 * and feeds them into the same ring buffers that serve mode uses.
 * This makes browser-captured errors visible to the watcher,
 * loop detection, and the MCP status resource.
 */
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileIssue } from "./fix-library.js";
import { decodeWireMessage, createLoopEvent } from "@stackpack/loop-protocol";
import { loopBus } from "./loop-bus.js";
export function ingestBrowserMessage(msg) {
    if (msg.type === "console") {
        if (msg.data?.level === "error" || msg.data?.level === "warn") {
            loopBus.ingest(createLoopEvent({
                source: "browser",
                kind: msg.data.level === "error" ? "console.error" : "console.warn",
                payload: { message: (msg.data.args ?? []).join(" ") },
            }));
        }
        return;
    }
    if (msg.type === "error") {
        loopBus.ingest(createLoopEvent({
            source: "browser",
            kind: "window.error",
            payload: {
                message: msg.data?.message,
                source: msg.data?.source,
                line: msg.data?.line,
            },
        }));
        return;
    }
    if (msg.type === "unhandledrejection" || msg.type === "rejection") {
        loopBus.ingest(createLoopEvent({
            source: "browser",
            kind: "unhandled.rejection",
            payload: { reason: msg.data?.reason ?? msg.data },
        }));
        return;
    }
}
/**
 * Start the local capture server.
 * Returns handles for the HTTP server and a stop function.
 */
export function startCaptureServer(opts) {
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
    const recentErrors = [];
    const MAX_RECENT = 50;
    // Buffer for agent chat messages (for fix-prompt extraction and training data)
    const recentAgentMessages = [];
    const MAX_AGENT_MESSAGES = 20;
    // Context tracking for auto-filed issues
    const recentNetworkErrors = [];
    let lastEditorContent = null;
    wss.on("connection", (ws) => {
        ws.on("message", (data) => {
            try {
                const loop = decodeWireMessage(String(data));
                if (loop) {
                    if (loop.type === "loop:event")
                        loopBus.ingest(loop.event);
                    // hello and schema messages are consumed silently for now;
                    // later tasks may extend behavior.
                    return;
                }
                const raw = JSON.parse(String(data));
                const event = raw;
                eventCount++;
                // Bridge browser messages into the LoopBus for unified timeline
                ingestBrowserMessage(raw);
                // Call the event handler
                if (onEvent)
                    onEvent(event);
                // Buffer for live-context. For browser console events, the resolved
                // text lives in event.data.args (an array of stringified args). The
                // older flat fields (event.message, event.text, etc.) are kept as
                // fallbacks for non-console event shapes.
                const eventData = raw.data;
                let text = "unknown";
                if (event.type === "console" && eventData && Array.isArray(eventData.args)) {
                    text = eventData.args.map((a) => String(a)).join(" ");
                }
                else if (event.type === "error" && eventData && typeof eventData === "object") {
                    text = eventData.message ?? eventData.reason ?? JSON.stringify(eventData);
                }
                else {
                    text = event.message
                        ?? (typeof event.args === "string" ? event.args : undefined)
                        ?? event.reason
                        ?? event.text
                        ?? event.error
                        ?? "unknown";
                }
                recentErrors.push({
                    timestamp: new Date(event.ts ?? Date.now()).toISOString(),
                    text: `[${event.type}] ${text}`.slice(0, 500),
                    source: event.source ?? "browser",
                });
                if (recentErrors.length > MAX_RECENT)
                    recentErrors.shift();
                // Buffer agent chat messages separately (for fix-prompt extraction)
                if (event.type === "agent_chat" || event.type === "agent_message") {
                    recentAgentMessages.push({
                        timestamp: new Date(event.ts ?? Date.now()).toISOString(),
                        text: (event.text ?? "").slice(0, 2000),
                        msgIndex: event.msgIndex ?? 0,
                        complete: event.type === "agent_message",
                    });
                    if (recentAgentMessages.length > MAX_AGENT_MESSAGES)
                        recentAgentMessages.shift();
                }
                // Auto-file issues for error events
                if (event.type === "error" || event.type === "rejection") {
                    try {
                        fileIssue(cwd, event, {
                            platform: opts.platform ?? "unknown",
                            recentAgentMessages: recentAgentMessages.map((m) => m.text),
                            editorContent: lastEditorContent,
                            recentNetworkErrors: recentNetworkErrors.slice(-5),
                        });
                    }
                    catch { /* filing failure is non-fatal */ }
                }
                // Track network errors for issue context
                if (event.type === "network") {
                    const netErr = `${event.method ?? "GET"} ${event.url ?? "?"} → ${event.status ?? event.error ?? "failed"}`;
                    recentNetworkErrors.push(netErr);
                    if (recentNetworkErrors.length > 20)
                        recentNetworkErrors.shift();
                }
                // Track editor content for issue context
                if (event.type === "editor_change" && event.preview) {
                    lastEditorContent = event.preview;
                }
                // Write to live-context.json so the watcher and MCP can see it
                writeBrowserContext(cwd, recentErrors, recentAgentMessages);
            }
            catch {
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
function writeBrowserContext(cwd, events, agentMessages) {
    const dir = join(cwd, ".debug");
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    const path = join(dir, "live-context.json");
    let existing = {};
    try {
        if (existsSync(path)) {
            existing = JSON.parse(readFileSync(path, "utf-8"));
        }
    }
    catch { /* start fresh */ }
    // Merge: keep terminal/build data from serve mode, add browser events + agent chat
    const merged = {
        ...existing,
        updatedAt: new Date().toISOString(),
        browser: events.map((e) => ({
            timestamp: e.timestamp,
            source: "browser-console",
            data: { level: "error", message: e.text },
        })),
        agentChat: agentMessages ?? (existing.agentChat ?? []),
        counts: {
            ...(existing.counts ?? {}),
            browser: events.length,
            agentMessages: agentMessages?.length ?? 0,
        },
    };
    writeFileSync(path, JSON.stringify(merged));
}
//# sourceMappingURL=capture-server.js.map