# Closed Agent Integration Guide

Stop AI coding agents from burning your credits in loops. stackpack-debug watches your app from outside the agent's sandbox, detects when the agent is stuck, and suggests fixes from a community of developers who already solved your exact error.

Works with Lovable, Bolt.new, Replit, Base44, and any browser-based AI coding tool.

## How It Works

```
  You on Lovable/Bolt/Replit          Your machine
  ┌──────────────────────────┐        ┌──────────────────────────────┐
  │  Agent edits code         │        │  stackpack-debug-helper      │
  │  Preview renders          │        │                              │
  │  Chat streams responses   │        │  Watches:                    │
  │                           │   ──►  │  • App errors (console/DOM)  │
  │  [browser capture script] │        │  • Agent chat output         │
  │  observes everything      │        │  • Error patterns over time  │
  │                           │        │                              │
  └──────────────────────────┘        │  Detects:                    │
                                       │  • Loops (same error 4x)     │
                                       │  • Orbiting (A→B→A cycles)   │
                                       │  • Degradation (more errors) │
                                       │                              │
                                       │  Suggests:                   │
                                       │  • Known fix from community  │
                                       │  • Prompt to paste into chat │
                                       └──────────────────────────────┘
```

The capture script runs in your browser alongside the agent. It watches:
- **App errors** — JavaScript errors, network failures, console output from the preview
- **Agent responses** — the text the agent streams into the chat (via DOM observation)
- **Code changes** — what the agent writes into the editor (via DOM observation)

When it detects a loop, it sends you a fix suggestion you can paste directly into the agent's chat.

## Quick Start

### One command to install

```bash
npx stackpack-debug setup --agent
```

The wizard asks:
1. **Which platform?** (Lovable / Bolt / Replit / Base44 / Other)
2. **Free or Pro?** (local memory only vs community database)
3. Generates your browser capture script
4. Starts the background helper
5. Copies the script to your clipboard

### Paste one script in your browser

Open your project in Lovable/Bolt/Replit. Open the browser console (Cmd+Option+J). Paste. Done.

The script:
- Captures all JavaScript errors from the app preview
- Watches the agent's chat output as it streams (via MutationObserver on the chat container)
- Watches the code editor for changes
- Sends everything to `localhost` — nothing leaves your machine unless you opt into team/community features

### Work normally

The `stackpack-debug-helper` process runs in the background. You don't need to think about it. When it detects a problem:

- **Desktop notification** pops up with the error and suggested fix
- **If you have the dashboard open** (localhost:3100), it shows the full loop analysis
- **The suggested fix is a ready-to-paste prompt** for the agent's chat input

## What Gets Captured

### From the app preview

| Signal | How | What you get |
|--------|-----|-------------|
| JavaScript errors | `window.addEventListener('error')` | Stack traces, error types, source files |
| Promise rejections | `unhandledrejection` event | Async failures with context |
| Console errors | Wrapped `console.error/warn` | Everything the agent's code logs |
| Network failures | Wrapped `fetch` + `XMLHttpRequest` | Failed API calls with status codes |
| Performance | `PerformanceObserver` | Long tasks, slow renders |

### From the agent's chat

The capture script uses `MutationObserver` on the chat message container. As the agent streams its response, the observer captures the text in real-time. This gives us:

| Signal | What it tells us |
|--------|-----------------|
| Error analysis text | What the agent thinks the error is |
| Code blocks in responses | What fix the agent is attempting |
| "Fixed!" claims | Whether the agent thinks it succeeded |
| Repeated phrases | "Let me try a different approach" appearing 3+ times = loop |

The agent's chat output is the richest signal. When the agent says "I see a TypeError in auth.ts" and then two messages later says "I see a TypeError in auth.ts" with different fix code, we know it's looping before the third attempt even starts.

### From the code editor

The capture script watches for changes in the editor DOM (Monaco, CodeMirror, or contenteditable). This gives us:

| Signal | What it tells us |
|--------|-----------------|
| Which file is being edited | Tracks file churn |
| Code diffs | Whether the same lines are being changed back and forth |
| Edit frequency | Rapid edits = agent trying variations |

## Platform Details

### Lovable

**Preview:** Iframe-based. The capture script injects into the preview iframe via `contentWindow` access.

**Chat:** React-rendered message container. MutationObserver watches for new message nodes with `childList: true, subtree: true, characterData: true`. Text is captured via `.textContent` as it streams.

**Editor:** Lovable uses a custom code viewer. File contents are readable from the DOM when the code tab is active.

**Script persistence:** The script stays active until you close the browser tab or do a full page reload. For Lovable's SPA navigation (switching between design/code/preview tabs), the script survives. The MutationObserver re-attaches to new iframes automatically.

### Bolt.new

**Preview:** WebContainer-based iframe. Full access because everything runs in-browser.

**Chat:** Uses React components with identifiable class names (`bg-bolt-elements-*`). Open source — class names are stable and documented.

**Terminal:** Bolt exposes a terminal panel with xterm.js. The capture script scrapes terminal output for errors. This catches build errors, npm install failures, and server-side logs that don't appear in the browser console.

**Editor:** CodeMirror 6. The editor instance is accessible from the DOM. File changes can be observed via CodeMirror's update listener.

### Replit

**Preview:** Native webview with built-in DevTools (chobitsu). The capture script hooks into the same mechanism.

**Chat:** Standard chat interface with agent message containers.

**Terminal:** xterm.js panel. Same scraping approach as Bolt.

**Editor:** Monaco Editor. Accessible via `window.monaco` or by traversing the DOM.

### Base44

**Preview:** Standard iframe.

**Chat:** Standard message container.

**Limitation:** Backend runs on Base44's servers — server-side errors are not observable. Only client-side errors and failed API calls are captured.

## Loop Detection

### Same error persisting

The error signature (normalized hash of error type + file) appears in 4+ consecutive checks over 20+ seconds. The agent's fixes aren't reaching the error.

**Notification:**
```
🔴 LOOP: TypeError in auth.ts persisting across 5 checks
   The current approach isn't working.
   
   💾 Community fix (94% success rate, 312 developers):
   "Add null check before .map() — API returns null when session expires"
   
   📋 Paste this into the agent's chat:
   "Stop. The error is caused by the API returning null when the session
   expires. Add a null check before the .map() call in auth.ts:
   const users = data?.users ?? []; then use users.map(...)"
```

### Error orbiting

Error A appears → agent fixes it → Error B appears → agent fixes it → Error A returns. The agent is cycling.

**Notification:**
```
🔴 ORBITING: Cycling between TypeError in auth.ts and ImportError in user.ts
   These errors are connected. The fix for one introduces the other.
   
   📋 Paste this into the agent's chat:
   "You're cycling between two errors. Both are caused by the same issue:
   the auth module export changed from default to named. Fix the import
   in user.ts AND the null check in auth.ts in the same edit."
```

### Agent repeating itself

The chat observer detects the agent saying similar things across messages — "Let me try a different approach," "I see the issue now," "Let me fix that."

**Notification:**
```
⚠️ AGENT REPEATING: 3 similar "fixing" messages without resolution
   The agent may be stuck. Consider providing more specific context.
   
   📋 Paste this into the agent's chat:
   "The error is [specific error from capture]. It's been appearing for
   the last 3 attempts. The root cause is [diagnosis from community DB].
   Apply this specific fix: [code from community DB]"
```

## The Community Database

### Why it matters

AI-generated code has predictable bug patterns. Research shows:

- **Misinterpretations** (21%) — code deviates from intended behavior
- **Missing corner cases** (15%) — works for happy path, fails on edge cases  
- **Hallucinated functions** — calling APIs that don't exist
- **Missing null checks** — the #1 runtime error in AI-generated React apps
- **Incomplete generation** — code cuts off, missing closing tags/brackets

When 500 Lovable users hit the same hydration mismatch error, the first user who solves it contributes the fix. Users 2-500 get it instantly.

### How it works

**Your errors are fingerprinted, not shared raw.** The error signature is a 16-character hash of `(error_type + source_file_pattern + top_stack_frame)`. Your actual code, file paths, and error messages never leave your machine.

What IS shared (on Pro plan):
- The error signature hash
- The fix description (one-liner you wrote or the agent wrote)
- Whether the fix actually worked (success/failure tracking)
- The causal chain (what caused it, where it manifested, where the real bug was)

What is NOT shared:
- Your source code
- Your file contents
- Your error messages
- Your project name or structure
- Anything from the agent's chat

### Free vs Pro

| Feature | Free | Pro |
|---------|------|-----|
| Loop detection | Yes | Yes |
| Agent chat observation | Yes | Yes |
| Desktop notifications | Yes | Yes |
| Local memory (your fixes) | 200 entries | Unlimited |
| Team sharing (your org) | No | Yes |
| Community database | No | Yes — thousands of verified fixes |
| Fix success rates | No | Yes — "94% of developers fixed this with..." |
| Ready-to-paste prompts | Basic | AI-generated, context-aware |
| Background daemon | Yes | Yes |

**Why Pro is worth it:** Each loop prevented saves $0.50-2.00 in tokens. The community database prevents 5-10 loops per day for an active developer. The subscription pays for itself in the first week.

## Architecture: The Fix Suggestion Agent

When you're on Pro, fix suggestions aren't just recalled from a database — they're generated by a specialized agent running on StackPack's infrastructure.

```
Your browser                    StackPack Cloud (Fly.io)
┌─────────────────┐             ┌──────────────────────────────┐
│ Capture script   │   error    │  Fix Suggestion Agent         │
│ detects loop     │ ────────►  │                              │
│                  │            │  1. Match error signature     │
│                  │   prompt   │  2. Find community fixes      │
│ Paste into chat  │ ◄────────  │  3. Check success rates       │
│                  │            │  4. Generate context-aware     │
└─────────────────┘             │     prompt for THIS agent     │
                                │  5. Adapt to platform          │
                                │     (Lovable vs Bolt vs ...)  │
                                └──────────────────────────────┘
```

The agent knows:
- **Common AI-generated code bugs** — trained on the 10 categories from academic research
- **Platform-specific patterns** — Lovable generates different code than Bolt
- **What works** — ranked by actual success rates from the community
- **How to prompt each platform's agent** — the fix suggestion is formatted as a prompt optimized for the specific platform's agent

This is NOT a generic LLM call. It's a specialized agent that only does one thing: generate the most effective prompt to unstick the agent that's looping. It runs on Fly.io, costs fractions of a cent per call, and its knowledge grows with every error captured by every stackpack-debug user.

## Setup Reference

### Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `STACKPACK_API_KEY` | For Pro | API key from stackpack.io |
| `STACKPACK_EVENTS_URL` | For Pro | Platform URL (auto-detected) |

### CLI Commands

```bash
spdg setup --agent          # Interactive wizard for closed agent setup
spdg watch                  # Start standalone watcher + capture server
spdg watch --daemon         # Run as background process
spdg watch --stop           # Stop the background process
spdg setup --agent --reset  # Regenerate capture script
spdg doctor                 # Check all integrations and connectivity
```

### Process Names

The background process appears as `stackpack-debug-helper` in Activity Monitor / Task Manager. This is intentional — it should be obvious what it is when you see it running.

### Files

```
~/.stackpack-debug/              # Global config (not per-project)
  config.json                    # Platform choice, API key reference
  watcher.log                    # Background process log
  captures/                      # Recent capture events (rolling buffer)

<project>/.debug/                # Per-project (gitignored)
  memory.json                    # Local fix memory
  live-context.json              # Live error state
  capture-lovable.js             # Generated browser script
```

## Troubleshooting

### "Script doesn't capture anything"

1. Make sure the preview iframe is loaded before pasting
2. Check the console for `[stackpack-debug] Capture active` message
3. Verify the local server: `curl http://localhost:3100/health`
4. Some platforms use strict CSP — try the browser extension if console injection fails

### "No community fixes appearing"

1. Verify Pro plan: `spdg doctor` should show "Community: connected"
2. The community database grows over time — not every error has a known fix yet
3. Check if the error is too project-specific (custom API errors won't match community patterns)

### "Desktop notifications not showing"

- macOS: System Settings → Notifications → stackpack-debug-helper → Allow
- Windows: Settings → Notifications → stackpack-debug-helper → On
- Linux: Ensure `notify-send` is installed

### "The agent ignored my pasted fix"

- Try being more specific: include the exact file name and line number
- Prefix with "IMPORTANT:" or "Stop and read this carefully:"
- Some agents respond better to "The error is X, the fix is Y" than long explanations
- If the agent keeps ignoring the fix, the underlying architecture may be different from what the community fix assumes — investigate manually
