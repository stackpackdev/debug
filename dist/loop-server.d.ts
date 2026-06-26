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
export declare function endpointPath(cwd: string): string;
export declare function eventsPath(cwd: string): string;
/** Replay persisted events into the bus. Returns the count rehydrated. */
export declare function rehydrateFromDisk(cwd: string): number;
/**
 * Start the MCP-hosted WebSocket server. Binds to 127.0.0.1 on an
 * OS-assigned port, writes the endpoint file, and rehydrates the bus.
 */
export declare function startLoopServer(cwd: string): Promise<LoopServerHandle>;
/**
 * Read the endpoint file written by a running MCP loop server.
 * Returns null when the file is missing, malformed, or the recorded pid
 * is no longer alive.
 */
export declare function readEndpoint(cwd: string): EndpointFile | null;
export {};
