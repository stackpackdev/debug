# Debug Efficiency Improvements Plan

**Source**: Debug session insight report (2026-04-13) — curriculum generation 500 error
**Goal**: Reduce time-to-root-cause for server-side errors from ~15 minutes to <1 minute

---

## P0 — Must Fix

### 1. Server-side console output reliability

**Problem**: `console.error` in Next.js API routes never appeared in terminal captures. The piping at `capture.ts:354-379` works correctly for stdout/stderr from the child process, but Next.js Turbopack may buffer or delay stderr output for API route handlers differently than framework-level route logs.

**Root cause**: The `pipeProcess` function captures data events correctly, but:
- Next.js Turbopack dev server may not flush `console.error` from API routes immediately
- The 500-line ring buffer (`capture.ts:156`) plus dedup can silently drop entries if framework logs are noisy
- `drain()` at `capture.ts:458` **empties** the buffer — if `debug_capture` (drain mode) runs before `debug_investigate`, the investigation's `peekRecentOutput()` at `mcp.ts:729` sees nothing

**Changes**:

#### a. Add a timestamped immutable log alongside the ring buffer (`capture.ts`)

```
File: src/capture.ts
After line 158 (buffer declarations)
```

Add a `recentWindow` — a separate append-only buffer that retains the last 60 seconds of ALL terminal output regardless of drain state. This is immune to the drain/peek ordering problem.

```typescript
// Immutable recent window — last 60s of output, never drained
const RECENT_WINDOW_MS = 60_000;
const recentWindow: Array<{ ts: number; capture: Capture }> = [];

function pushRecentWindow(capture: Capture): void {
  const now = Date.now();
  recentWindow.push({ ts: now, capture });
  // Evict entries older than 60s
  while (recentWindow.length > 0 && now - recentWindow[0].ts > RECENT_WINDOW_MS) {
    recentWindow.shift();
  }
}

export function peekRecentWindow(lastMs?: number): Capture[] {
  const cutoff = Date.now() - (lastMs ?? RECENT_WINDOW_MS);
  return recentWindow.filter(e => e.ts >= cutoff).map(e => e.capture);
}
```

Call `pushRecentWindow(capture)` inside `pushTerminalDeduped` at line 367, BEFORE the dedup check.

#### b. Use `peekRecentWindow()` in `debug_investigate` as fallback (`mcp.ts:729`)

After the existing `peekRecentOutput()` call, if terminal results are empty, fall back to `peekRecentWindow(10_000)` (last 10s). This catches cases where `drain()` emptied the ring buffer.

#### c. Stop using `drain()` in `debug_capture` default mode (`capture.ts:457-458`)

Change `drainCaptures` to use `peek()` instead of `drain()`. The drain semantic is destructive and causes data loss across tools. If the buffer needs cleanup, add an explicit `debug_cleanup` parameter or let the ring buffer's natural rotation handle it.

---

### 2. Request-response correlation in `debug_capture` command mode

**Problem**: When `debug_capture` runs `curl localhost:3000/api/foo`, it captures curl's stdout/stderr via `runAndCapture` (`capture.ts:384-423`), but the server-side logs triggered by that request go into the `terminalBuffer` via `pipeProcess` — completely separate, no correlation.

**Changes**:

```
File: src/mcp.ts, inside debug_capture command handler (~line 1293-1299)
File: src/capture.ts, new function
```

When the command contains `localhost` or `127.0.0.1`:
1. Snapshot the current `terminalBuffer` length before running the command
2. Run the command via `runAndCapture()`
3. After the command completes, peek terminal buffer entries that arrived since the snapshot
4. Include them in the response under a `serverLogs` key

```typescript
// In debug_capture command handler (mcp.ts ~1293):
const isLocalRequest = command && /localhost|127\.0\.0\.1/i.test(command);
const preSnapshot = isLocalRequest ? terminalBuffer.length : 0;

const captures = await runAndCapture(command, /* timeout */);

let serverLogs: Capture[] | undefined;
if (isLocalRequest) {
  // Small delay for server to flush logs
  await new Promise(r => setTimeout(r, 200));
  const currentLen = terminalBuffer.length;
  if (currentLen > preSnapshot) {
    serverLogs = terminalBuffer.peek(currentLen - preSnapshot);
  }
}

// Include in response:
// serverLogs: serverLogs?.map(c => ({ ... }))
```

This requires exposing `terminalBuffer.length` (already a getter at `capture.ts:151`).

---

## P1 — Should Fix

### 3. Error unwrapping in `debug_investigate`

**Problem**: `classifyError` at `context.ts:338-428` only looks at the string representation of the error. When errors are caught and re-thrown (e.g., `RetryError("Last error: Error")`), the actual diagnostic information (`statusCode: 429`, `url`, `responseBody`) is in the original error's properties, not in the message string.

**Changes**:

```
File: src/context.ts, new function after classifyError (~line 428)
```

Add error-chain pattern detection that extracts nested error info from common wrapper formats:

```typescript
export function unwrapErrorChain(raw: string): UnwrappedError {
  const result: UnwrappedError = {
    outerMessage: raw.split("\n")[0] ?? "",
    innerErrors: [],
    httpStatus: null,
    url: null,
    provider: null,
  };

  // AI SDK RetryError pattern
  const retryMatch = raw.match(/Failed after (\d+) attempts?\. Last error: (.+)/);
  if (retryMatch) {
    result.innerErrors.push({ wrapper: "RetryError", attempts: parseInt(retryMatch[1]), message: retryMatch[2] });
  }

  // HTTP status codes anywhere in the error
  const statusMatch = raw.match(/statusCode:\s*(\d{3})|status[:\s]+(\d{3})|HTTP\/\d\.\d\s+(\d{3})/);
  if (statusMatch) {
    result.httpStatus = parseInt(statusMatch[1] ?? statusMatch[2] ?? statusMatch[3]);
  }

  // URL extraction (API endpoint that was called)
  const urlMatch = raw.match(/url:\s*['"]?(https?:\/\/[^\s'"]+)/);
  if (urlMatch) {
    result.url = urlMatch[1];
    // Infer provider from URL
    if (/anthropic\.com/i.test(result.url)) result.provider = "anthropic";
    else if (/openai\.com/i.test(result.url)) result.provider = "openai";
    else if (/localhost|127\.0\.0\.1/i.test(result.url)) result.provider = "local";
  }

  // Rate limit detection
  if (result.httpStatus === 429 || /rate.?limit/i.test(raw)) {
    result.innerErrors.push({ wrapper: "RateLimit", message: "API rate limit exceeded" });
  }

  return result;
}
```

Then in `debug_investigate` response assembly (`mcp.ts:811-829`), include the unwrapped chain:

```typescript
const unwrapped = unwrapErrorChain(errorText);
// Add to response object:
errorChain: unwrapped.innerErrors.length > 0 ? unwrapped : undefined,
```

Also add specific patterns to `classifyError` rules at `context.ts:372`:

```typescript
// Add these rules before the generic \b5\d{2}\b match:
[/\b429\b|rate.?limit/i, "rate-limit", "error", "API rate limit — check which provider is being called and consider switching to a fallback or adding backoff"],
[/\b408\b|ETIMEDOUT|request.*timeout/i, "timeout", "error", "Request timed out — service may be slow or unreachable"],
[/AI_APICallError|APICallError/i, "ai-sdk-error", "error", "AI SDK API call failed — check provider URL, API key, and rate limits. Look for statusCode and responseBody in the full error."],
```

### 4. Recent output guarantee (last 60s mode)

**Problem**: Multiple `debug_capture` calls with `source: "terminal"` returned `total: 0` because the buffer was either drained or entries were evicted.

**Changes**: Already addressed by the `recentWindow` in item 1a above. Add a new capture mode:

```
File: src/mcp.ts, debug_capture input schema (~line 1210)
```

Add a `recent` parameter to the input schema:

```typescript
recent: z.number().optional().describe("Return output from the last N milliseconds (max 60000). Immune to buffer drain."),
```

When `recent` is set, call `peekRecentWindow(recent)` instead of draining the ring buffer. This gives agents a guaranteed way to see recent output regardless of prior tool calls.

---

## P2 — Nice to Have

### 5. Smarter triage suggestions for wrapped errors

**Problem**: When triage is "complex" with 0 user frames and a generic error message, the current system doesn't suggest actionable next steps.

**Changes**:

```
File: src/mcp.ts, after triage assessment (~line 699-720)
```

Add a post-triage hint when the error looks wrapped:

```typescript
// After triage classification, before the response:
if (triage.level === "complex" && result.sourceCode.length === 0) {
  const unwrapped = unwrapErrorChain(errorText);
  if (unwrapped.innerErrors.length > 0 || /Last error:|Caused by:/i.test(errorText)) {
    response.wrappedErrorHint = {
      message: "This error appears to be wrapped by middleware or SDK error handling. The original cause is hidden.",
      suggestions: [
        "Add temporary error logging that surfaces the full error object: `console.error('FULL:', JSON.stringify(error, Object.getOwnPropertyNames(error)))`",
        "Use `debug_instrument` to add tagged logging before the catch block",
        "Use `debug_capture` with a curl command and check the `serverLogs` section for correlated output",
        unwrapped.httpStatus ? `Detected HTTP ${unwrapped.httpStatus} — ${unwrapped.httpStatus === 429 ? 'rate limit' : 'server error'}` : null,
        unwrapped.url ? `Request went to: ${unwrapped.url}${unwrapped.provider ? ` (${unwrapped.provider})` : ''}` : null,
      ].filter(Boolean),
    };
  }
}
```

### 6. Error fingerprinting annotations

**Problem**: Common HTTP status codes and network errors had generic messages. The agent couldn't identify "429 = rate limit" from the wrapped error string.

**Changes**: Already addressed by the new `classifyError` rules in item 3. Additionally, add annotations to the status resource:

```
File: src/mcp.ts, status resource assembly (~line 248-252)
```

When terminal errors are found, run them through `classifyError` and surface the classification in the status output:

```typescript
// In status assembly, after splitting terminal errors:
const annotatedErrors = terminalErrors.map(e => {
  const d = e.data as Record<string, string>;
  const classification = classifyError(d.text ?? "");
  return {
    ...e,
    annotation: classification.category !== "runtime" ? classification.suggestion : undefined,
  };
});
```

---

## Implementation Order

1. **Item 1a** (recent window buffer) — foundational, unblocks items 1b, 4
2. **Item 1c** (stop draining) — simple, high-impact fix
3. **Item 3** (error unwrapping + new classify rules) — addresses the core diagnostic gap
4. **Item 2** (request-response correlation) — significant new capability
5. **Item 1b** (fallback in investigate) — quick integration
6. **Item 4** (`recent` parameter) — expose the new buffer to agents
7. **Items 5-6** (smart hints, annotations) — polish

## Agent Behavior Improvements (CLAUDE.md / rules update)

Beyond code changes, update `stackpack-debug.md` rules to guide agents better:

### Add to the decision tree:

```markdown
## Debugging wrapped/generic errors ("Error", "Failed to X")

When you encounter a generic error message with no useful stack trace:
1. Do NOT spend more than 2 attempts trying to extract logs from the toolkit
2. On the second failure to find server logs, immediately add error detail surfacing to the HTTP response:
   ```typescript
   catch (error) {
     return Response.json({ 
       error: error.message, 
       details: error instanceof Error ? JSON.stringify(error, Object.getOwnPropertyNames(error)) : String(error)
     }, { status: 500 });
   }
   ```
3. Reproduce with `curl` via Bash (not debug_capture) to see the full response
4. Fix the root cause, then revert the verbose error response

## When debug_capture returns empty terminal output

If `debug_capture` with `source: "terminal"` returns 0 results:
- Use `recent: 10000` parameter to check the immutable recent window
- If still empty, the server may not be flushing stderr — surface errors in the HTTP response instead
- Do NOT retry more than once with the same parameters
```

---

## Success Metrics

- **Time to root cause for server-side errors**: <1 min (from 15 min)
- **Agent pivots to response-body debugging**: By attempt 2, not attempt 5
- **Terminal capture reliability**: >95% of `console.error` calls visible within 10s
- **Wrapped error detection rate**: 100% for known SDK wrappers (AI SDK, Axios, fetch)
