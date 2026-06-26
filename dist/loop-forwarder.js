/**
 * loop-forwarder.ts — proxy-side upstream relay for The Loop.
 *
 * The dev-server proxy terminates the page-side WebSocket (browser injected.js
 * and state telemetry both target ws://<page-host>:<page-port>/__stackpack_debug/ws).
 * This module forwards wire messages it receives there to the MCP-hosted loop
 * server, whose port is advertised in .debug/mcp.endpoint.json.
 *
 * Buffers up to BUFFER_LIMIT messages while disconnected, drops oldest on
 * overflow. Reconnects with bounded exponential backoff. Re-reads the endpoint
 * file on every reconnect so a restarted MCP picks back up cleanly.
 */
import { WebSocket } from "ws";
import { readEndpoint } from "./loop-server.js";
const BUFFER_LIMIT = 500;
const RECONNECT_MAX_MS = 8_000;
export function startLoopForwarder(cwd) {
    let socket = null;
    let closed = false;
    let reconnectAttempts = 0;
    let reconnectTimer = null;
    const queue = [];
    function flush() {
        while (queue.length && socket && socket.readyState === WebSocket.OPEN) {
            const msg = queue.shift();
            try {
                socket.send(msg);
            }
            catch {
                // Re-queue at the front and let close handler reconnect.
                queue.unshift(msg);
                return;
            }
        }
    }
    function schedule() {
        if (closed || reconnectTimer != null)
            return;
        const delay = Math.min(500 * Math.pow(2, reconnectAttempts++), RECONNECT_MAX_MS);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, delay);
    }
    function connect() {
        if (closed)
            return;
        const endpoint = readEndpoint(cwd);
        if (!endpoint) {
            // No live MCP yet — back off and try again later.
            schedule();
            return;
        }
        const url = `ws://127.0.0.1:${endpoint.port}/__stackpack_debug/loop`;
        let ws;
        try {
            ws = new WebSocket(url);
        }
        catch {
            schedule();
            return;
        }
        socket = ws;
        ws.on("open", () => {
            reconnectAttempts = 0;
            flush();
        });
        ws.on("close", () => {
            if (socket === ws)
                socket = null;
            schedule();
        });
        ws.on("error", () => {
            // close handler runs next; nothing to do.
        });
    }
    connect();
    return {
        send(raw) {
            if (socket && socket.readyState === WebSocket.OPEN) {
                try {
                    socket.send(raw);
                    return;
                }
                catch { /* fall through to queue */ }
            }
            queue.push(raw);
            while (queue.length > BUFFER_LIMIT)
                queue.shift();
        },
        close() {
            closed = true;
            if (reconnectTimer != null) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            try {
                socket?.close();
            }
            catch { /* ignore */ }
            socket = null;
        },
    };
}
//# sourceMappingURL=loop-forwarder.js.map