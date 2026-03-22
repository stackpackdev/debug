---
name: debug-toolkit
description: "Closed-loop debugging for AI agents. Use for runtime errors, stack traces, test failures, AND logic/behavior bugs (wrong output, visual mismatch, unexpected values). Provides error classification, source context, git history, cross-session memory with past solutions, and pattern detection. Start every debugging task with debug_investigate."
tools: ["debug_investigate", "debug_recall", "debug_patterns", "debug_instrument", "debug_capture", "debug_verify", "debug_cleanup", "debug_session"]
---

# debug-toolkit

You have access to a debugging toolkit via MCP. These tools let you SEE code running — not just read and write it. They also learn from every debug session and get smarter over time.

## When to Use

Use these tools whenever you encounter:
- A runtime error or stack trace
- A test failure
- Code that runs but produces wrong output
- A visual/rendering bug ("looks wrong", "doesn't match")
- A logic bug ("wrong value", "should be X but is Y")
- A bug report from the user

**Do NOT debug manually** (exploring code with Read/Grep/Agent) when debug-toolkit is available. Start with `debug_investigate` — it gives you everything in one call.

## The Workflow

**ALWAYS start with `debug_investigate`.** It auto-recalls past solutions.

```
1. debug_investigate  → understand the error + auto-recall past fixes
2. debug_instrument   → add logging if investigation wasn't enough
3. debug_capture      → collect runtime output
4. (apply fix)        → edit the code
5. debug_verify       → confirm the fix works
6. debug_cleanup      → remove markers, save diagnosis + causal chain
```

## Tool Reference

### debug_investigate
**Start here.** Works for BOTH runtime errors AND logic bugs.

For runtime errors (stack traces):
```
Input: { error: "<stack trace>" }
```

For logic/behavior bugs (no stack trace):
```
Input: { error: "description of what's wrong", files: ["src/Component.tsx", "src/utils.ts"] }
```

Output: `{ error, sourceCode, git, environment, pastSolutions?, nextStep }`

### debug_recall
Explicitly search past debug sessions. Returns diagnoses with staleness and causal chains.
```
Input: { query: "TypeError Cannot read properties email" }
```

### debug_patterns
Detect patterns across ALL past sessions. Use periodically.
```
Input: {}
```
Pattern types: `recurring_error`, `hot_file`, `regression`, `error_cluster`.

### debug_instrument
Add tagged logging. Each marker links to a hypothesis.
```
Input: { sessionId, filePath, lineNumber, expression: "req.body", hypothesis?: "body is undefined" }
```

### debug_capture
Run a command and capture output, or drain buffered events.
```
Input: { sessionId, command?: "npm test", limit?: 30 }
```

### debug_verify
After applying a fix, run the test command and check pass/fail.
```
Input: { sessionId, command: "npm test" }
```

### debug_cleanup
Remove ALL instrumentation, save diagnosis + causal chain to memory.
```
Input: {
  sessionId,
  diagnosis?: "root cause was...",
  rootCause?: {
    trigger: "missing null check",
    errorFile: "src/api.ts",
    causeFile: "src/db.ts",
    fixDescription: "added null check before .map()"
  }
}
```
**Always provide rootCause** — it's the most valuable data for future sessions.

### debug_session
Lightweight view of current session state.
```
Input: { sessionId }
```

## Rules
1. NEVER skip debug_investigate. It's the highest-leverage step.
2. Read `nextStep` in every response — it tells you what to do.
3. If past solutions are found, check `stale` — fresh solutions can be trusted.
4. For logic bugs, pass suspect file paths in the `files` parameter.
5. ALWAYS run debug_verify before claiming a fix works.
6. ALWAYS provide `rootCause` in debug_cleanup — it teaches the system.
7. Run debug_patterns periodically to spot systemic issues.
