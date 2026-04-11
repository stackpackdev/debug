# Closed Agent Integration Guide

How to use stackpack-debug with AI coding platforms you don't control — Lovable, Bolt, Replit, Base44, and others.

## The Problem

AI coding agents in closed platforms loop. They hit an error, try a fix, introduce a new error, try another fix, reintroduce the original error. Each iteration burns tokens and time. The user watches helplessly because they can't inject debugging tools into the platform's sandbox.

stackpack-debug sits outside the sandbox. It watches the app's output — the errors, the console, the network failures — and detects loops the agent can't see. When a known fix exists (from your past sessions or your team's shared memory), it surfaces it immediately.

## How It Works

```
                  Closed Agent Platform
                  ┌─────────────────────────────┐
  User's          │  Agent edits code            │
  Browser    ───► │  Preview renders in iframe   │
                  │  Errors appear in console    │
                  └──────────┬──────────────────┘
                             │ errors flow to browser
                             ▼
                  ┌─────────────────────────────┐
                  │  stackpack-debug observer    │
                  │  (browser extension or       │
                  │   console script)            │
                  │                              │
                  │  Captures: errors, network   │
                  │  failures, console output    │
                  └──────────┬──────────────────┘
                             │ sends to local server
                             ▼
                  ┌─────────────────────────────┐
                  │  spdg watch (local)          │
                  │                              │
                  │  Loop detection              │
                  │  Memory recall               │  ──► Desktop notification
                  │  Health trend                │  ──► Terminal dashboard
                  │  Team knowledge              │  ──► Browser dashboard
                  └─────────────────────────────┘
```

The user doesn't need to install anything inside Lovable/Bolt/Replit. The observation happens from the user's own browser and local machine.

## Quick Start (2 minutes)

### Step 1: Install stackpack-debug

```bash
npm install -g stackpack-debug
```

### Step 2: Run the setup wizard

```bash
spdg setup --agent
```

The wizard:
1. Asks which agent platform you use (Lovable / Bolt / Replit / Base44 / Other)
2. Generates the correct browser script for that platform
3. Starts the local capture server
4. Opens the dashboard in your browser
5. Shows you where to paste the script

### Step 3: Paste one script in your browser console

When you're on the agent's page with your project open, open the browser DevTools console (Cmd+Option+J on Mac) and paste the script the wizard gave you. The script:

- Captures all JavaScript errors from the preview
- Captures unhandled promise rejections
- Captures failed network requests
- Sends everything to the local stackpack-debug server (localhost only — nothing leaves your machine)

### Step 4: Work normally

Use Lovable/Bolt/Replit as you normally would. stackpack-debug watches in the background. When it detects a loop, you get:

- A desktop notification (macOS/Windows)
- A terminal alert with the specific error and a suggested fix
- If a team member solved this before: their exact fix, surfaced automatically

## Platform-Specific Setup

### Lovable

Lovable renders the preview in an iframe. The capture script targets the iframe's content window.

**How it works:**
- Lovable's preview iframe is accessible because it runs on a subdomain the page controls
- The script finds the preview iframe, injects error listeners, and forwards events to localhost
- It also monitors the Lovable UI for agent status changes (thinking, editing, error)

**Script location:** Paste in the browser console while on your Lovable project page.

**What's captured:**
- Preview app errors (TypeError, ReferenceError, etc.)
- Preview app network failures (failed API calls, CORS errors)
- Build/compilation errors (shown in Lovable's error panel)
- Agent action indicators (which files the agent is editing)

**Limitations:**
- Cannot capture the agent's internal reasoning or tool calls
- Cannot capture server-side errors (only client-side)
- Script needs to be re-pasted after a full page reload

### Bolt.new

Bolt runs WebContainers — a full Node.js environment in the browser. This gives the richest observability.

**How it works:**
- Bolt's terminal output is visible in the page DOM
- The preview runs in an iframe but is accessible
- Build errors appear in the terminal and can be scraped
- The script observes both the terminal output and the preview iframe

**What's captured:**
- Terminal output (npm install, build errors, server logs)
- Preview app errors
- Network failures
- File system changes (visible in the file tree)

**Limitations:**
- WebContainer performance overhead may affect capture timing
- Terminal scraping depends on DOM structure (may break on Bolt UI updates)

### Replit

Replit runs code in a Linux container with a built-in DevTools implementation.

**How it works:**
- Replit's preview is a webview with same-origin access
- The DevTools use chobitsu (JS implementation of Chrome DevTools protocol)
- The script hooks into the existing DevTools infrastructure

**What's captured:**
- Console output (all levels)
- Runtime errors
- Network requests (via DevTools protocol)
- Performance metrics

**Limitations:**
- Replit's DevTools may conflict with the capture script
- Container restarts reset the capture state

### Base44

Base44 generates full-stack apps with a remote backend.

**How it works:**
- Frontend preview is observable from the browser
- Backend errors are NOT directly observable (they run on Base44's servers)
- The script captures frontend errors and failed API calls

**What's captured:**
- Frontend JavaScript errors
- Failed API calls to the Base44 backend (with status codes)
- Client-side rendering issues

**Limitations:**
- No visibility into server-side errors
- Backend logic bugs are invisible to the capture script

### Other / Custom

For any platform with a browser-based preview:

```bash
spdg setup --agent --platform custom
```

The wizard generates a generic capture script that:
- Hooks `window.onerror` and `unhandledrejection`
- Wraps `fetch` and `XMLHttpRequest`
- Sends events to `localhost:3100` (configurable)
- Works on any page where you can open the browser console

## What the Watcher Detects

### Loop Detection

**Same error persisting:** The same error signature appears in 4+ consecutive checks (20+ seconds). The agent is stuck — its fixes aren't reaching the error.

**Error orbiting:** Error A appears → agent fixes it → Error B appears → agent fixes it → Error A returns. The agent is cycling between two states without resolving the underlying issue.

**Degrading health:** Error count is rising over time. The agent's changes are making things worse, not better.

### Automatic Recall

When a loop is detected, the watcher checks your local memory AND the team pool for known fixes:

- **Local memory:** Past sessions where you (or this project) solved the same error signature
- **Team memory:** Fixes from teammates in your organization who solved the same error

If a fix exists, it appears in the notification:

```
🔴 LOOP: Same error persisting across 5 checks: TypeError: Cannot read properties of undefined (reading 'map')
   This error isn't being fixed by the current approach. Try a different strategy.

💾 Known fix: Add null check before .map() — the API returns null when unauthenticated
   (from @alice, 95% success rate across 12 applications)
```

The user copies this fix and pastes it into the agent's chat. One more iteration instead of ten.

## Running in the Background

### Option A: Persistent Terminal (recommended)

Keep `spdg watch` running in a terminal tab. It uses <1% CPU and ~20MB RAM. Terminal stays open as long as you're working.

### Option B: Background Process

```bash
spdg watch --daemon
```

Runs in the background. Logs to `~/.stackpack-debug/watcher.log`. Desktop notifications still work. Stop with `spdg watch --stop`.

### Option C: Login Item (macOS)

```bash
spdg watch --autostart
```

Adds stackpack-debug to your macOS Login Items. Starts automatically on boot. Watches any project where `.debug/` exists.

## Community Database vs Personal Memory

### Free Plan: Personal Memory

- Your own debugging history (200 entries, local storage)
- Loop detection works fully
- Error signature matching across your own sessions
- No team sharing, no community database

### Pro Plan: Team + Community Memory

- Everything in Free, plus:
- **Team pool:** Share fixes across your organization. When any team member solves a bug, everyone benefits.
- **Community database:** Anonymized error signatures and fix patterns from all stackpack-debug users. When 500 React developers solve the same hydration mismatch, the 501st gets the fix instantly.
- **Success rate tracking:** Fixes are ranked by how often they actually work (not just keyword matching)
- **Signature deduplication:** The same bug reported by 100 users produces one canonical fix, not 100 duplicate entries

**Why pay?** Building your own personal database of 200 fixes takes months of debugging. The community database has thousands of verified fixes on day one. The difference between "I've seen this before" and "500 developers have seen this and here's what works" is the difference between a 50% chance of a useful recall and a 95% chance.

## Privacy

- **Capture scripts run locally.** Error data goes to `localhost` only. Nothing is sent to any server without the team memory feature enabled.
- **Team memory is opt-in.** Only enabled when `STACKPACK_API_KEY` is set.
- **Community database uses anonymized signatures.** Error type + file pattern are hashed. Your code, file names, and error messages are never shared. Only the 16-character signature hash and the fix description are contributed.
- **You control what's pushed.** Only fixes you verify (via `debug_verify`) are ever synced. Failed attempts, captured console output, and raw error messages stay local.

## Troubleshooting

### Script doesn't capture errors

1. Check that the preview iframe is loaded before pasting the script
2. Some platforms use CSP headers that block inline scripts — try the browser extension instead
3. Verify the local server is running: `curl http://localhost:3100/health`

### Desktop notifications not appearing

- macOS: System Settings → Notifications → Terminal (or your terminal app) → Allow
- The watcher only sends desktop notifications for critical alerts (orbiting, 5+ loop iterations)

### Memory recall returns nothing

- First session? Memory is empty. Fixes accumulate as you debug.
- Team memory not configured? Run `spdg setup --team` to connect to your organization.
- Community database requires Pro plan.

### Agent-specific issues

- **Lovable:** If the preview reloads completely, re-paste the script
- **Bolt:** Terminal scraping may lag behind — errors in the terminal appear 1-2 seconds after they happen
- **Replit:** If DevTools are open, close them before pasting (conflicts with chobitsu)
