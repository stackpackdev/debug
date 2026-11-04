# Cloud Debugging Evolution: Design and Tickets

**Status:** proposal, for review
**Issue:** #2 "define how could this system evolve"
**Version reviewed:** stackpack-debug 0.24.0 (commit 794a9b3)

## Goal

Turn stackpack-debug from a per-developer, per-machine tool into a debugging
service on a GCP VM that several cloud agents (for example the Tessl factory's
own implement and shepherd agents) reach over MCP. Each agent should be able to
send the runtime signals of the app it is building to the service, then read
those signals back through MCP tools to fix the app.

This document has two parts:

1. A review of the current build: what already works for a hosted service and
   what assumes "one developer, one laptop, one project".
2. The tickets that get from here to a hosted service, in order, each sized to
   be one pull request.

## Part 1: Review of the current build

### How it works today

```
dev server  <-- proxy (injects injected.js) <-- browser
   |                  |
   | stdout/stderr    | /__stackpack_debug/ws
   v                  v
serve process (index.ts) --writes--> .debug/live-context.json (every 5s)
                     |
                     +-- loop-forwarder.ts --ws--> loop-server.ts (127.0.0.1, port from .debug/mcp.endpoint.json)
                                                        |
MCP process (mcp.ts, stdio transport) <-- reads .debug/*.json, owns LoopBus
```

The MCP server is started by the agent's client as a child process over stdio
(`StdioServerTransport` in `src/mcp.ts`, `startMcpServer`). Every tool and
resource takes its project from the module-level `cwd` (`setCwd`), and every
piece of state lives under `<cwd>/.debug/`.

### What already transfers to a hosted service

| Piece | Why it transfers |
|---|---|
| Loop wire protocol (`src/loop-protocol.ts`) | Versioned, JSON, transport-agnostic. `decodeWireMessage` already drops garbage. This is the right ingest format for remote producers. |
| `LoopBus` (`src/loop-bus.ts`) | A pure in-memory ring with listeners. Easy to instantiate once per project instead of as a singleton. |
| Loop server persistence (`src/loop-server.ts`) | Write-through JSONL ring with rehydrate on start. The same pattern works per project on a VM disk. |
| Forwarder (`src/loop-forwarder.ts`) | Buffered, reconnecting upstream WebSocket. Only needs a configurable URL and an auth header to point at a remote server. |
| Redaction (`src/security.ts`, `redactSensitiveData`, `redactCaptureValue`) | Already applied on all output surfaces (commit d556830). Must move to ingest time for a shared service, but the patterns are reusable. |
| Detectors (`src/loop-detectors.ts`), triage, signatures, memory recall | Pure functions over events and stored entries. No machine assumptions. |
| Team memory client (`src/storage.ts`) | Already talks to a remote StackPack platform with `STACKPACK_EVENTS_URL` and `STACKPACK_API_KEY`. Proves the "remote knowledge" path and the env var auth convention. |
| Static analysis tools (`debug_trace_origin`, file orbiting) | Work on any checkout of the source. |

### What blocks a hosted, multi-agent service

1. **Transport is stdio only.** `startMcpServer` connects a
   `StdioServerTransport`. A remote agent cannot reach it. The MCP SDK already
   in `package.json` (`@modelcontextprotocol/sdk ^1.28.0`) ships a Streamable
   HTTP server transport, so this is wiring, not new protocol work.
2. **One project per process, chosen by `process.cwd()`.** `cwd` is a module
   global in `src/mcp.ts`; `loopBus` is a module singleton; capture buffers in
   `src/capture.ts` are module state. Two agents on two apps in one process
   would read each other's errors.
3. **State is files under `<cwd>/.debug/`.** Sessions, memory, WAL, telemetry,
   fix library, activity log, screenshots, live context and loop events all use
   `join(cwd, ".debug", ...)` (see `src/session.ts`, `src/utils.ts`,
   `src/telemetry.ts`, `src/fix-library.ts`, `src/activity.ts`,
   `src/capture.ts`, `src/loop-server.ts`). There is no storage interface to
   swap, and the serve process and MCP process coordinate by polling
   `.debug/live-context.json`.
4. **Endpoint discovery is local.** `.debug/mcp.endpoint.json` holds a port and
   a pid, and `readEndpoint` / the vite plugin's `readMcpLoopUrl` check
   liveness with `process.kill(pid, 0)` and build `ws://127.0.0.1:<port>`. None
   of this works across machines.
5. **No authentication or tenancy.** The loop server binds `127.0.0.1` and
   accepts any connection; it relies on the loopback interface for safety. A
   public VM needs per-agent or per-project tokens and isolation.
6. **Several tools act on the local machine.** `debug_instrument` and
   `debug_cleanup` edit files in `cwd`; `debug_capture` with `command` and
   `debug_verify` run shell commands (`validateCommand` is a denylist, not a
   sandbox); context gathering runs `git`, `npx tsc --noEmit`; network
   topology runs `lsof` (`src/network.ts`); Ghost OS and Lighthouse expect a
   desktop or a local Chrome. On a shared VM these either have no project
   checkout to act on, or would execute agent-supplied commands on shared
   infrastructure.
7. **Capture requires the dev server to run next to the toolkit.** `spdg
   serve` wraps the dev server and its proxy. A cloud agent's app runs in the
   agent's own sandbox, not on the debug VM, so capture must happen there and
   be shipped to the service.
8. **Secrets are redacted on read, not on write.** In a shared service, raw
   secrets should never reach the VM disk.

### Target shape

Split the toolkit into two roles that share the existing modules:

- **Collector** (runs in each agent's sandbox, next to the app). This is
  today's `spdg serve` plus proxy and vite plugin. Instead of writing
  `.debug/` and forwarding to `127.0.0.1`, it redacts and ships Loop events,
  terminal output, build errors and live context snapshots to the hub over an
  authenticated WebSocket. Code-touching tools (`debug_instrument`,
  `debug_cleanup`, `debug_verify`, command capture) stay here, because the
  checkout is here.
- **Hub** (one service on a GCP VM). Hosts MCP over Streamable HTTP, accepts
  collector streams, keeps per-project buses and storage, runs detectors,
  triage and memory recall, and serves the read-side tools and resources
  (`debug://status`, `debug://timeline`, `debug://state`, `debug_investigate`
  in a remote mode, `debug_recall`, `debug_patterns`, `debug_session`).

```
agent sandbox A                       GCP VM
+------------------------+            +--------------------------------------+
| app + spdg collector   | --wss-->   | hub                                  |
| (proxy / vite plugin)  |  token A   |  /ingest  (Loop wire protocol)       |
+------------------------+            |  /mcp     (Streamable HTTP MCP)      |
agent A (MCP client) ---- https ----> |  per-project: LoopBus, detectors,    |
                                      |  sessions, memory (storage backend)  |
agent sandbox B ...  ----------->     +--------------------------------------+
```

An agent that can run local MCP servers can keep using today's stdio mode
unchanged: local mode stays the default, and every ticket below must keep it
working.

### Key decisions to confirm

These are open and need an owner's call before the tickets that depend on them
start:

1. **Project identity.** Proposal: a project id derived from the git remote
   URL plus branch, overridable with `STACKPACK_DEBUG_PROJECT`. Factory agents
   would set it to the issue branch (`tessl/issue-<n>`) so each issue gets its
   own timeline.
2. **Auth.** Proposal: static bearer tokens per agent fleet in a hub config
   file for v1 (matches `STACKPACK_API_KEY` usage in `src/storage.ts`), with
   tokens scoped to a project id prefix. OAuth for MCP later.
3. **Storage backend on GCP.** Proposal: local disk on the VM (one directory
   per project, same file layout as `.debug/`) for v1, behind an interface, so
   Firestore or Cloud SQL can follow without touching tools.
4. **Whether the hub should ever execute commands.** Proposal: no. The hub
   never runs agent-supplied commands or edits files; those tools stay on the
   collector side.

## Part 2: Tickets

Each ticket lists scope, acceptance criteria and dependencies. They are in
dependency order. "Local mode keeps working" means `npm test` passes and the
stdio MCP server behaves as before when no hub settings are present.

### T1. Introduce a `ProjectContext` and remove module-level project state

**Why:** blocker 2. Everything else needs more than one project per process.

**Scope:**
- Add a `ProjectContext` object holding `projectId`, `root` (today's `cwd`),
  its `LoopBus`, capture buffers, live context and config.
- Replace the module-level `cwd`, `envCaps`, `visualConfig`, health trend and
  status diff counters in `src/mcp.ts` with fields on the context, and replace
  the `loopBus` singleton with a per-context bus (keep a default context so
  existing imports keep working during the migration).
- `createMcpServer(ctx)` takes the context instead of reading globals.

**Acceptance:** two contexts in one process ingest events independently (new
test); local mode keeps working.

**Depends on:** none.

### T2. Storage interface for all `.debug/` state

**Why:** blocker 3. A hub must keep per-project state somewhere other than the
agent's working directory.

**Scope:**
- Define a `DebugStore` interface covering sessions, memory and WAL,
  telemetry, fix library, activity log, screenshots, live context and loop
  events.
- Implement `FsDebugStore(rootDir)` with today's exact file layout, and route
  every `join(cwd, ".debug", ...)` call through it.
- `ProjectContext` owns its store.

**Acceptance:** no direct `.debug` path joins remain outside `FsDebugStore`;
existing memory, WAL, session and purge tests pass unchanged.

**Depends on:** T1.

### T3. Streamable HTTP MCP transport (`spdg hub`)

**Why:** blocker 1. Remote agents need to reach MCP over the network.

**Scope:**
- Add a `spdg hub` command that serves MCP with the SDK's Streamable HTTP
  server transport at `/mcp`, alongside a `/healthz` endpoint.
- Each MCP session is bound to one `ProjectContext`, chosen by a
  `project` parameter on connect (header `X-Stackpack-Project`), created on
  first use with an `FsDebugStore` under `<dataDir>/projects/<projectId>/`.
- Config: `--port`, `--data-dir`, `--bind` (default `127.0.0.1`).

**Acceptance:** an MCP client over HTTP lists tools and reads
`debug://status` for two different projects without cross-talk (new e2e test,
like `tests/e2e-loop-server.test.ts`).

**Depends on:** T1, T2.

### T4. Authentication and project scoping

**Why:** blocker 5. A VM reachable by many agents must not be open.

**Scope:**
- Bearer token auth on `/mcp` and on the ingest endpoint (T5).
- Hub config file listing tokens, each with a name and allowed project id
  patterns (for example `tessl/*`).
- Reject requests for projects outside the token's scope; log the token name,
  never the token, in the activity log.

**Acceptance:** tests for missing token, wrong token, and out-of-scope project
returning 401/403; the token never appears in logs or tool output.

**Depends on:** T3.

### T5. Remote ingest endpoint for Loop and capture data

**Why:** blockers 4 and 7. Collectors in agent sandboxes must push data to
the hub.

**Scope:**
- Extend the loop server into an `/ingest` WebSocket on the hub that accepts
  the existing Loop wire messages plus new message kinds for terminal lines,
  build errors and live context snapshots (bump `LOOP_PROTOCOL_VERSION` if the
  envelope changes, and update the source package it is vendored from).
- The `hello` message carries the project id; the connection is bound to that
  project's context after the auth check from T4.
- Backpressure: per-connection rate limit and max message size.

**Acceptance:** events sent over `/ingest` show up in `debug://timeline` and
`debug://status` for the right project; oversized and malformed messages are
dropped without closing other connections.

**Depends on:** T3, T4.

### T6. Collector mode: point serve, proxy and vite plugin at a hub

**Why:** blocker 4 and 7 from the producer side.

**Scope:**
- New settings `STACKPACK_DEBUG_HUB_URL`, `STACKPACK_DEBUG_TOKEN`,
  `STACKPACK_DEBUG_PROJECT` (env vars, also accepted in `.debug/config.json`).
- When set, `loop-forwarder.ts` connects to the hub URL with the token
  instead of reading `.debug/mcp.endpoint.json`; the serve process also ships
  terminal output, build errors and live context there.
- The vite plugin's `readMcpLoopUrl` keeps local discovery; the hub URL is
  never injected into the browser page (the page keeps talking to the local
  proxy, which forwards).

**Acceptance:** with a hub running in a test, `spdg serve` against the demo
app produces the same `debug://status` content on the hub as locally; without
the settings, behavior is unchanged.

**Depends on:** T5.

### T7. Redact at ingest

**Why:** blocker 8.

**Scope:**
- Apply `redactSensitiveData` / `redactCaptureValue` in the collector before
  sending, and again on the hub before persisting (defense in depth).
- Add tests that a JWT, a connection string and a GitHub token sent through
  `/ingest` never reach the hub's store.

**Acceptance:** the new tests pass; `tests/security-redaction.test.ts` still
passes.

**Depends on:** T5, T6.

### T8. Split tools by where they run

**Why:** blocker 6.

**Scope:**
- Tag each tool as `hub` (read-side: status, timeline, state, recall,
  patterns, session, hypothesis, a remote `debug_investigate` that uses
  ingested data plus team memory) or `collector` (instrument, cleanup, verify,
  capture with `command`, perf, visual, trace_origin, file reads).
- In hub mode, register only hub tools. `debug_investigate` skips `git`,
  `tsc`, `lsof` and source reads when there is no checkout, and says so in its
  response with the collector-side tool to use instead.
- Document the split in `README.md` and `SKILL.md`.

**Acceptance:** hub mode never calls `execSync` or writes project files (test
by stubbing `child_process`); local mode registers all tools as before.

**Depends on:** T3.

### T9. Shared memory on the hub

**Why:** the payoff of a central service: one agent's fix helps the next.

**Scope:**
- The hub keeps memory per project and a fleet-wide memory index; `debug_recall`
  merges both with `mergeRecallResults` (as it already merges team results from
  `src/storage.ts`).
- Decide whether the hub replaces or feeds the existing StackPack platform team
  memory; keep `TeamMemoryClient` working either way.

**Acceptance:** a diagnosis saved by agent A on project X is returned by
`debug_recall` for agent B on project Y with a similar error signature, with
`contributedBy` set.

**Depends on:** T2, T3.

### T10. GCP VM deployment

**Why:** the issue's target environment.

**Scope:**
- A `Dockerfile` for `spdg hub` and a `deploy/gcp/` directory with: a startup
  script or Terraform for a Compute Engine VM, a persistent disk mounted at the
  data dir, TLS termination (Caddy or a Google HTTPS load balancer), firewall
  rules allowing only 443, and tokens loaded from Secret Manager.
- Structured logs to Cloud Logging; `/healthz` used by the VM health check.
- A runbook in `docs/` covering deploy, token rotation and backup of the data
  disk.

**Acceptance:** following the runbook on a fresh project brings up a hub that
a local `spdg serve` (T6) and a remote MCP client can both use over HTTPS.

**Depends on:** T3, T4, T5.

### T11. Factory integration guide and agent setup

**Why:** the first consumer named in the issue is the factory itself.

**Scope:**
- Document how a cloud agent configures its MCP client for the hub (URL,
  token, project id per issue branch) and how its sandbox starts the collector
  (`spdg serve -- <dev command>` with the T6 env vars).
- Add an `spdg init --hub <url>` path that writes an HTTP MCP entry instead of
  the stdio `npx` entry in `.mcp.json`.

**Acceptance:** a factory agent run on a sample app shows its browser and
terminal errors on the hub and resolves one with `debug_investigate` and
`debug_recall`.

**Depends on:** T6, T8, T10.

### T12. Retention, quotas and observability

**Why:** a long-lived shared VM accumulates data from many short-lived agents.

**Scope:**
- Per-project retention (default 14 days after last event, reuse
  `expireOldSessions` and `maybeArchive`), per-token quotas on events per
  minute and storage bytes.
- Hub-level metrics: connected collectors, active MCP sessions, ingest rate,
  dropped messages, per-project disk use; exposed on an authenticated
  `/metrics` endpoint.

**Acceptance:** tests for retention sweeps and quota rejection; metrics
endpoint returns the listed counters.

**Depends on:** T5, T10.

### Suggested order

```
T1 -> T2 -> T3 -> T4 -> T5 -> T6 -> T7
            T3 -> T8
      T2,T3 -> T9
   T3,T4,T5 -> T10 -> T11 (needs T6, T8), T12
```

A first usable milestone for the factory is T1 to T8 plus T10: one hub on a
VM, authenticated, with collectors pushing data and agents reading it over MCP.
T9, T11 and T12 make it shared and durable.
