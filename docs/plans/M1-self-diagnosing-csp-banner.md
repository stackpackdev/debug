# M1 — Self-diagnosing CSP violation banner

**Status:** awaiting signoff
**Spec:** `stackpack-debug — improvement spec`, milestone M1
**Target:** half a day of work, one PR

## Goal

When the toolkit's injected client is blocked by the page's Content Security
Policy, the user currently sees nothing. Make it fail loudly with an
actionable in-page banner that names the blocked origin, shows the exact
CSP snippet to add, and offers a one-click copy.

Out of scope (explicitly): editing the host app's CSP from JS, catching
CSP violations unrelated to the toolkit, production builds.

## What changes

All changes are in `src/vite-plugin.ts` — specifically the string returned by
`buildInlineScript(wsPort)`. No new files. No public API changes. No new
dependencies.

### 1. Declare the toolkit's own origins up front

At the top of the injected IIFE, compute the full WS URL (already done) and
derive the origin-without-path form (`ws://127.0.0.1:<port>`). Also compute
the `http://127.0.0.1:<port>` equivalent — even though the current client
only uses the WS, any `securitypolicyviolation` event for either of those
hosts is "us" and worth surfacing. Store both in a small array
`toolkitOrigins`.

### 2. Register the violation listener before any network call

Before `connect()` runs, attach a single `document.addEventListener(
"securitypolicyviolation", handler, { once: false })`. The handler:

- Reads `event.blockedURI` (string, possibly empty for inline violations —
  inline isn't our concern, skip).
- Compares its origin+port against `toolkitOrigins`. If no match, return.
- Extracts `event.effectiveDirective` (falls back to `event.violatedDirective`
  on older browsers) — this is the directive name like `connect-src`.
- Deduplicates: if we've already rendered a banner for this
  `(directive, origin)` pair in this session, return. Track via a Set kept
  on the closure, plus a `sessionStorage` flag so the banner doesn't reappear
  on hot-reload after the user dismissed it.
- Renders the banner (see §3).

Why listen at `document` level rather than `window`: the DOM spec dispatches
the event at Document, and `document.addEventListener` works in every
browser that implements CSP reporting. `window.addEventListener` works too
but we don't need both.

### 3. The banner

A single `<div>` appended to `document.body`, styled via inline `style`
attribute (no stylesheet — stylesheets themselves can be CSP-restricted).
Contents:

- **Heading:** "stackpack-debug was blocked by your Content Security Policy."
- **Body line 1:** "Blocked: `<blockedURI>` (directive: `<directive>`)"
- **Body line 2:** "Add this to your `connect-src` directive:"
- **Code box:** `ws://127.0.0.1:<port>` — monospace, selectable, with a
  "Copy" button next to it that calls `navigator.clipboard.writeText()` and
  flips to "Copied ✓" for 2s.
- **Learn more link:** a single anchor. For M1 this can point to the repo
  README with a stable anchor (`#csp`) — the proper docs page lands in M5.
  The hrefs must be stable so later milestones don't break existing banners
  in the wild.
- **Dismiss button (×):** removes the node and sets
  `sessionStorage.setItem("__stackpack_csp_banner_dismissed", "1")`.

Positioning: `position: fixed; bottom: 0; left: 0; right: 0;` with a
`z-index: 2147483647` (the top of the z-index stack). Muted yellow/amber
background so it's obviously a dev-time warning and not mistaken for app
chrome.

### 4. Production safety

The `buildInlineScript` function is only invoked from `transformIndexHtml`,
which in turn is only active when `apply: "serve"` matches — which is the
Vite dev server. The plugin already guards production builds via
`apply: devOnly ? "serve" : undefined`. No additional gating needed — if the
plugin is running, we're in dev, and the banner code is fine to include. I
verified this by re-reading `src/vite-plugin.ts:30`.

If the user sets `devOnly: false` (advanced — keeps the plugin active in
production), the banner still only fires on violations, which are dev-only
bugs anyway. Acceptable; not a regression.

### 5. Dedupe + early-return guard

If the host page already has a previous version of our script injected
(unlikely but possible with multiple Vite configs), the existing
`if (window.__stackpack_debug_injected) return;` guard already short-
circuits. The violation listener is only registered inside that same IIFE,
so we inherit the single-registration guarantee for free.

## Files touched

| File | Change |
|---|---|
| `src/vite-plugin.ts` | Extend `buildInlineScript` to append ~40 LoC for violation listener + banner renderer |
| `tests/vite-plugin-csp.test.ts` | New file — unit tests for the banner snippet (see below) |

Nothing else. README updates wait for M5.

## Tests

Two kinds of verification — automated unit test that doesn't need a browser,
and a manual Tauri repro for the "done" criterion.

### Automated (`tests/vite-plugin-csp.test.ts`)

The injected script is a string. We test it as a string, which is cheap:

1. Import `debugToolkitPlugin` from `src/vite-plugin.ts`, instantiate it,
   call `plugin.transformIndexHtml()` with no args. Extract the child
   `script` tag's `children`.
2. Assert the script contains `securitypolicyviolation` — proves the
   listener is wired.
3. Assert the script contains the WS URL we configured (e.g. `ws://127.0.0.1:3420`)
   and that it derives a matching origin (`ws://127.0.0.1:3420`) — proves
   the origin-matching is driven by real config, not a hardcoded fallback.
4. Assert the banner HTML fragment contains the key strings: the word
   "Content Security Policy", the copy-button, and the dismiss-button (×).
5. Negative test: the script does NOT contain `'unsafe-inline'` or any
   stylesheet link — catches anyone later refactoring in a way that would
   itself trigger a CSP violation and make the banner invisible.

We're not testing the runtime behavior of the listener in vitest — jsdom's
CSP implementation is incomplete and would be a false signal. The manual
Tauri check below covers that.

### Manual — definition of "done"

In a scratch directory, outside this repo:

```bash
npm create tauri-app@latest --template vanilla-ts
cd <project>
npm install <path-to-this-repo>
# add debugToolkitPlugin to vite.config.ts
npm run tauri dev
```

Expected: within 2 seconds of the Tauri window opening, the banner appears
at the bottom of the webview. It names `ws://127.0.0.1:<port>`, shows the
exact `connect-src` addition, and the Copy button works. Paste the snippet
into `src-tauri/tauri.conf.json`'s `security.csp`, restart, and the toolkit
connects (banner does not re-appear).

We capture this as a single screenshot + short recording, attached to the
PR description. No CI fixture for M1 — that's deliberately M5's job, and
adding it now would couple M1 to a docs-testing infrastructure that doesn't
exist yet.

## Risks and open questions

- **Origin derivation from a WS URL.** `new URL("ws://127.0.0.1:3420").origin`
  returns `"ws://127.0.0.1:3420"` in modern browsers, but Safari historically
  returned `"null"` for non-http(s) schemes. Plan: derive the origin
  manually via string split (`"ws://" + host + ":" + port`) rather than
  relying on `URL.prototype.origin`. This is three lines of code and
  portable everywhere.
- **`event.blockedURI` format.** Can be a full URL, just a scheme, or
  `"inline"` / `"eval"`. Match loosely: if `blockedURI.includes(hostPort)`
  for any of our `toolkitOrigins`' `host:port` string, it's ours. Tighten
  if this proves too loose in testing.
- **Multiple violations in a row.** The client reconnects up to 5 times
  (`maxReconnects`). Each failed connect fires a new violation event. The
  dedupe Set prevents banner-stacking.
- **Banner inside an iframe.** If the Vite app is itself iframed, the
  banner renders inside the iframe, which may be invisible or clipped.
  Acceptable trade-off for M1 — iframed-dev is rare and the console will
  still show the native CSP error.

## Spec deviations

None so far. If any surface during implementation I'll update this doc
before merging, per the spec's guidance.

## Signoff checklist (for the maintainer)

- [ ] Banner copy wording is right
- [ ] Learn-more link target (README `#csp` anchor for M1, swaps to docs
      page in M5) is acceptable as a bridge
- [ ] Test strategy — unit test the string, manual Tauri for E2E — is
      enough for this milestone
- [ ] Ready to implement
