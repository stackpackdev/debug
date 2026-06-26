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
export interface LoopForwarder {
    /** Forward a raw wire-message string upstream (or buffer it). */
    send(raw: string): void;
    /** Stop reconnecting and tear down the upstream socket. */
    close(): void;
}
export declare function startLoopForwarder(cwd: string): LoopForwarder;
