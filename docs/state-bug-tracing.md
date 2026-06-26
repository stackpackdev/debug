# State-bug tracing — design

## The bug that motivated this

An agent looped for ~4 commits on a "redirects to `/sign-in`" bug. Every attempt
edited the auth components (the redirect's *destination*). The actual cause was a
component that auto-fired a server action on mount (`EmbeddedPaywall` →
`startDraftCheckout` → `requireUserId()` → `redirect('/sign-in')`) **only for
anonymous users**. The redirect fired before any auth UI was involved.

What finally cracked it was a *differential* observation — "works locally (signed
in), breaks in prod (anonymous)" — which proved the bug was **state-dependent**,
not a code-logic bug, and pointed at the one path that differs by auth state.

## Why the toolkit didn't help (the real insights)

Not "it lacks production log ingestion." Deeper:

1. **The symptom named the wrong suspect.** `/sign-in` is the redirect's
   *destination*. The toolkit (and the agent) reasoned about the destination.
   Nothing pointed at *what emits* that redirect, especially the non-obvious
   **auto-fired-on-mount** call site.
2. **`debug_investigate` confirmed the wrong mental model.** It returned source
   the agent had already read and even misclassified the error from the agent's
   own prompt strings. It echoed the hypothesis instead of challenging it.
3. **Loop detection was passive.** It tracked the *error fingerprint* orbiting,
   not the fact that the agent kept **editing the same files** while the cause
   lived elsewhere. It said "you're looping" but not *why*.

## What we build (in-repo, self-contained, no prod infra)

Three additions, each attacking one insight. All operate on signals the toolkit
already has: the user's source tree (read-only static scan) and the existing
debug session's error trajectory.

### 1. Redirect/throw-origin tracer — `traceSymptomOrigin()`

Given a destination path (e.g. `/sign-in`), statically scan the project source
for every site that can *send* a request there: `redirect('/sign-in')`,
`requireUserId()` / `requireAuth()`-style guards, `auth.protect()`,
`<RedirectToSignIn>`, Next.js middleware matchers. Then walk *up* one level: which
functions/components call those guards, and **how are they triggered** —
classifying each trigger as:

- `on-click` / event handler (expected, low-signal), vs
- **`on-mount` / module-eval / `useEffect(…, [])`** — auto-fired, **high-signal**,
  the kind of call site that "doesn't look like an auth flow."

Output ranks **auto-fired** origins first. This is exactly the fact that was
buried for 4 turns.

### 2. Auto-fire inventory — folded into the tracer output

For a given route/file, list the side effects that run **without user
interaction**: top-level `redirect()`/guard calls, `useEffect(…, [])` bodies, and
components rendered with auto-opening props (`open`/`defaultOpen` true) that call
data-fetching or server actions. This is *the* class of "mystery navigation on
load" bug.

### 3. File-orbiting detector — extends the existing trajectory analysis

The session already detects *error* orbiting. Add **file orbiting**: if the agent
has passed the same source file(s) as `files`/hints across N consecutive
`debug_investigate` calls **without the symptom resolving**, emit a prescriptive
nudge that names the structural mistake and hands the next tool:

> You've focused on `AuthDrawer.tsx` for 3 attempts without resolving the
> symptom. The symptom is a redirect to `/sign-in`; you have not yet traced what
> *emits* it. Run `traceSymptomOrigin` on the destination path.

## Exposure

- New tool `debug_trace_origin({ symptom, sessionId? })` — runs the tracer.
- `debug_investigate` automatically: (a) detects a redirect-shaped symptom in the
  error text and includes a `symptomOrigin` summary, and (b) runs the
  file-orbiting check and surfaces a `fileOrbiting` nudge in `nextStep`.

## Scope discipline

- Pure static analysis over the user's source (regex/line scan, the toolkit's
  existing idiom — no new deps, no AST/parser, no glob lib).
- Read-only. No code execution, no DB access, no production calls.
- Best-effort heuristics that *redirect attention*; not a sound analyzer.
