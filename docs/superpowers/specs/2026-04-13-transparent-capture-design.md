# Transparent Capture — MCP/CLI Parity for Runtime Visibility

**Date:** 2026-04-13
**Version:** 0.23.0
**Status:** Approved

## Problem

The MCP server (what Claude Code connects to) and `spdg serve` are separate processes. Without `spdg serve`, the agent gets static analysis only — zero terminal output, browser console, or network visibility. This caused a 30-minute debug session where 6 minutes would have sufficed: the agent couldn't see that the dev server had no outbound connection to Ollama, which immediately pointed to middleware blocking.

The user should never need to remember `spdg serve`. Running `spdg` and picking an option from the menu should give the agent full or near-full visibility. And even when the user doesn't run `spdg` at all, the MCP server should actively collect what it can instead of showing "Dev server not running."

## Design

Three tiers of capture, each adding value independently:

| Tier | How activated | Terminal | Browser | Network | Config/TSC |
|------|--------------|----------|---------|---------|------------|
| **Full capture** | `spdg` → "Start dev server" | Yes | Yes (proxy injection) | Yes | Yes |
| **Active collection** | `spdg` → "Monitor running app" | No | Script paste only | Yes | Yes |
| **MCP inline** | Automatic (nothing running) | No | No | Yes (cached) | Yes |

All tiers write to `.debug/live-context.json`. The MCP server reads from it regardless of which tier produced it.

## Section 1: Network Topology Engine

New module: `src/network.ts`

Wraps `lsof` (macOS) / `ss` (Linux) to provide structured network state.

### Types

```typescript
interface DevServerInfo {
  port: number;
  pid: number;
  process: string;  // "node", "next-server", "cargo"
}

interface Connection {
  remoteAddr: string;
  remotePort: number;
  state: string;      // ESTABLISHED, LISTEN, TIME_WAIT
  service?: string;   // inferred from port
}

interface NetworkTopology {
  devServer: DevServerInfo | null;
  inbound: Connection[];   // who's talking to the dev server
  outbound: Connection[];  // who the dev server is talking to
  missing?: string[];      // expected but absent (cross-ref with config)
}
```

### Service inference

Map well-known ports to service names:

| Port | Service |
|------|---------|
| 11434 | ollama |
| 5432 | postgres |
| 3306 | mysql |
| 6379 | redis |
| 27017 | mongodb |
| 443/80 | external API |

Cross-reference with config state: if `.env` has `OLLAMA_BASE_URL=http://localhost:11434` but no outbound connection to :11434 exists, include in `missing[]`.

### Port detection heuristic

When no serve-mode port is known:
1. Check `.debug/serve-command.txt` for previously used port
2. Scan common dev ports: 3000, 3001, 4000, 5173, 5174, 8080, 8081, 1420
3. Match process name against known dev servers: node, next-server, vite, cargo

### Platform commands

- macOS: `lsof -iTCP -sTCP:LISTEN -P -n` (listeners), `lsof -i :PORT -P -n` (connections)
- Linux: `ss -tlnp` (listeners), `ss -tnp` (connections)

Both parsed into the same `NetworkTopology` structure.

### Performance

- Port scan: ~50ms
- Connection topology: ~50ms
- Acceptable for 5s polling in monitor mode and 10s-cached inline in MCP

## Section 2: Unified CLI Menu

`spdg` is the only command users need. The guided menu becomes:

```
  stackpack-debug v0.23.0

  ✓ Already set up in this project. Ready to use in Claude Code.

  What would you like to do? (↑↓ to move, enter to select)

  ❯ Start dev server with full capture
    Wraps your dev server with terminal, browser, and network monitoring.

    Monitor running app (no restart)
    Attaches to your already-running dev server. Network, config, and build watching.

    Check setup health
    Verify Node, Git, Lighthouse, Chrome, Ghost OS, and Claude Preview.

    Re-run setup
    Regenerate MCP config, hooks, and activation rules.
```

### "Start dev server with full capture"

Current serve behavior plus network topology layer. Detects dev command from `package.json`, asks to confirm, starts wrapped. `writeLiveContext()` includes network topology alongside terminal/browser data.

### "Monitor running app"

New mode. Runs in foreground with activity feed.

1. Scans for running dev server via lsof
2. If found: shows port, PID, process name. Starts:
   - Network topology polling (every 5s)
   - tsc polling (every 30s, if tsconfig.json exists)
   - Config state reading (every 30s)
   - Capture-server WebSocket on :3100 (for browser events)
   - Live context writer (every 5s)
   - Loop watcher (every 10s)
3. If not found: "Waiting for dev server... Start one in another terminal." Polls every 5s and auto-attaches when a dev server appears.
4. Shows live activity feed in terminal (same as serve mode)
5. `captureMode: "active-collection"` in live-context.json

### CLI form preserved

`spdg serve -- cmd` still works for scripts/CI. But the typical human workflow is `spdg` → pick an option.

## Section 3: CLI Background Writer

After the `spdg` menu exits (user presses Esc or completes an action), optionally spawn a lightweight background collector:

- Detached process, PID written to `.debug/collector.pid`
- Runs port detection every 10s, tsc every 30s, config every 30s
- Starts capture-server on :3100
- Writes live-context.json every 5s with `captureMode: "active-collection"`
- Auto-exits when: dev server stops (port disappears), idle 10 minutes, or another collector starts
- MCP checks `.debug/collector.pid` before starting its own inline collection

This ensures the MCP server has data even if the user closed the `spdg` terminal but their dev server is still running.

## Section 4: MCP Fallback Intelligence

When `debug://status` is read and live-context.json is stale/missing, the MCP process does inline collection:

### Collection steps (every status read, results cached)

1. Port scan via lsof — cached 10s
2. Connection topology for detected port — refreshed every read
3. tsc — cached 30s (existing)
4. Config state — cached 30s (existing)
5. Git activity — existing

### Status output

```
## Capture Mode: PARTIAL
✓ Dev server detected on :3000 (PID 52524, node)
✓ Network: 1 inbound, 2 outbound (ollama:11434, postgres:5432)
✓ TypeScript errors: 0
✓ Config state: provider=ollama
✗ Terminal output — run spdg → "Start dev server" or "Monitor running app"
✗ Browser console — run spdg → "Start dev server" for auto-capture

> Tip: Run spdg in a terminal for full visibility.
```

### When nothing is detected

```
## Capture Mode: STATIC
✓ TypeScript errors: 2
✓ Config state: provider=ollama
✓ Git activity: 3 uncommitted files
✗ No dev server detected on common ports
✗ Terminal output — not available
✗ Browser console — not available

> Start your dev server and run spdg for runtime visibility.
```

## Section 5: Live Context Schema Update

Extend `LiveContext` to include network topology and capture mode:

```typescript
interface LiveContext {
  updatedAt: string;
  captureMode: "full" | "active-collection" | "static";

  // Existing (serve mode populates all)
  terminal: TerminalLine[];
  browser: BrowserEvent[];
  buildErrors: BuildError[];
  runtimeErrors: RuntimeError[];
  configState: ConfigEntry[];
  counts: { terminal: number; browser: number; buildErrors: number; runtimeErrors: number };

  // New (all tiers populate)
  network: NetworkTopology | null;
}
```

`writeLiveContext()` in serve mode includes network data. Monitor mode writes everything except terminal/browser. MCP inline writes network + config + tsc only.

## Section 6: Error Correlation

Existing tools enriched with network signals. No new tool surface.

### debug_investigate

When the error looks like a timeout, hanging request, or "no response":
1. Check network topology
2. If dev server exists but no outbound connection to expected backend → include in response: "Server received request but is not connecting to [service]. Check middleware/auth layer."
3. If config expects a service (from env vars) but no connection exists → flag as `missing` with actionable message

### debug://status

Network section cross-references with runtime errors:
- ECONNREFUSED + no outbound connection → "Connection refused: [service] not running on :[port]"
- Timeout + outbound exists but stalled → "Request to [service] may be blocked by middleware"
- Config says provider=X but no connection to expected port → "Config expects [service] but no connection established"

### debug_hypothesis

When the agent logs a hypothesis about a networking/connection issue, automatically attach current network topology as evidence.

## Implementation Scope

### New files
- `src/network.ts` — Network topology engine (lsof/ss wrapper, port detection, service inference, config cross-reference)

### Modified files
- `src/capture.ts` — Extend `LiveContext` type with `network` and `captureMode`. Update `writeLiveContext()` to include network data.
- `src/mcp.ts` — Update `buildLiveStatus()` with inline collection, capture status indicator, network section. Update `debug_investigate` handler with network correlation. Update `debug_hypothesis` handler to attach topology.
- `src/index.ts` — Add "Monitor running app" menu option. Add background collector spawn on menu exit. Wire up network polling in serve mode.
- `src/cli.ts` — Update menu option labels/descriptions.
- `src/watcher.ts` — Include network anomalies in loop detection (optional, low priority).

### Not changed
- `src/proxy.ts` — HTTP proxy unchanged
- `src/capture-server.ts` — Already standalone, works as-is for monitor mode
- `src/context.ts` — Investigation engine gains network data from mcp.ts, no direct changes

## Success Criteria

1. Running `spdg` → "Start dev server" gives the agent terminal + browser + network + config + tsc (full tier)
2. Running `spdg` → "Monitor running app" with a dev server already running gives the agent network + config + tsc (active tier)
3. Not running `spdg` at all but having a dev server running gives the agent network + config + tsc on every `debug://status` read (partial tier)
4. The middleware bug from the debug report (server connected to Chrome but not Ollama) is surfaced automatically in all three tiers
5. Every `debug://status` response shows a clear capture mode indicator with what's available and what's missing
6. `spdg serve -- cmd` still works for CI/scripts
