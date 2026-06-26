/**
 * symptom-origin.ts — static tracer for "the symptom named the wrong suspect" bugs.
 *
 * Given a redirect/navigation destination (e.g. "/sign-in"), find the code that
 * *emits* that redirect — not the page it points at — and surface the
 * non-obvious, auto-fired-on-mount call sites that don't look like an auth flow.
 *
 * Pure, read-only, regex-based scan over the project source. No deps, no AST, no
 * execution. Best-effort heuristics whose job is to redirect the agent's
 * attention, not to be a sound analyzer.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SCAN_DIRS = ["app", "src", "components", "lib", "pages", "server", "actions"];
const SCAN_EXT = /\.(t|j)sx?$/;
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", ".debug"]);
const MAX_FILES = 4000;

export interface OriginHit {
  /** project-relative file that emits the redirect or calls a guard reaching it */
  file: string;
  /** the line of source that matched (redirect call or guard call) */
  line: string;
  lineNumber: number;
  /** the named guard/function this site exposes (e.g. requireUserId), if any */
  exportedAs: string | null;
  /** files that call into this origin, with auto-fire context */
  callers: string[];
  /** true when a transitive caller fires without user interaction (mount/effect/module-eval/auto-open) */
  autoFired: boolean;
}

export interface SymptomOriginResult {
  target: string;
  origins: OriginHit[];
  summary: string;
}

/** Pull a redirect destination path out of a free-text symptom string. */
export function extractRedirectTarget(symptom: string): string | null {
  // Prefer an explicit path that follows a redirect/navigate verb.
  const verb = symptom.match(/(?:redirect|redirected|navigat\w*|sent|goes?|routed?)\s+(?:to\s+)?["'`]?(\/[A-Za-z0-9_\-/[\]]+)/i);
  if (verb) return normalizePath(verb[1]);
  // Otherwise any bare path token.
  const bare = symptom.match(/["'`]?(\/(?:sign-in|sign-up|login|signin|account|auth|onboarding)[A-Za-z0-9_\-/[\]]*)/i);
  if (bare) return normalizePath(bare[1]);
  const anyPath = symptom.match(/(^|\s)(\/[A-Za-z0-9_\-/[\]]{2,})/);
  return anyPath ? normalizePath(anyPath[2]) : null;
}

function normalizePath(p: string): string {
  return p.replace(/[)"'`.,;]+$/, "");
}

interface SourceFile {
  rel: string;
  content: string;
}

function collectSourceFiles(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  const roots = SCAN_DIRS.map(d => join(root, d)).filter(existsSync);
  // If none of the conventional dirs exist, fall back to the root itself.
  const startDirs = roots.length ? roots : [root];
  for (const start of startDirs) {
    walk(start, out, root);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

function walk(dir: string, out: SourceFile[], root: string): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (out.length >= MAX_FILES) return;
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let isDir = false;
    try { isDir = statSync(full).isDirectory(); } catch { continue; }
    if (isDir) { walk(full, out, root); continue; }
    if (!SCAN_EXT.test(name)) continue;
    try {
      out.push({ rel: relative(root, full), content: readFileSync(full, "utf-8") });
    } catch { /* skip unreadable */ }
  }
}

// Guard-ish call names that commonly end in a redirect to an auth path.
const GUARD_NAMES = /\b(requireUserId|requireUser|requireAuth|requireSession|protectRoute|ensureAuth|getRequiredUser)\b/;

/** Does this file contain a redirect (or guard) that targets `target`? */
function emittersFor(file: SourceFile, target: string): Array<{ line: string; lineNumber: number; emits: "redirect" | "guard"; exportedAs: string | null }> {
  const hits: Array<{ line: string; lineNumber: number; emits: "redirect" | "guard"; exportedAs: string | null }> = [];
  const lines = file.content.split("\n");
  const targetEsc = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // redirect('/sign-in'), router.push('/sign-in'), <RedirectToSignIn>, NextResponse.redirect('/sign-in')
  const redirectRe = new RegExp(`(redirect|push|replace|RedirectToSignIn|NextResponse\\.redirect)\\s*[(<][^)\\n]*["'\`]${targetEsc}`);
  const isSignInTarget = /sign-?in|login|auth/i.test(target);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (redirectRe.test(ln) || (isSignInTarget && /<\s*RedirectToSignIn/.test(ln))) {
      hits.push({ line: ln.trim(), lineNumber: i + 1, emits: "redirect", exportedAs: enclosingExport(lines, i) });
    }
  }
  return hits;
}

/** Find the nearest exported function/const name above line index i. */
function enclosingExport(lines: string[], i: number): string | null {
  for (let j = i; j >= 0; j--) {
    const m = lines[j].match(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/)
      ?? lines[j].match(/export\s+(?:const|let)\s+([A-Za-z0-9_]+)\s*=/)
      ?? lines[j].match(/(?:async\s+)?function\s+([A-Za-z0-9_]+)/);
    if (m) return m[1];
  }
  return null;
}

/** Is `name` invoked in `file` from an auto-firing (no user interaction) context? */
function autoFireCallers(files: SourceFile[], names: string[]): string[] {
  const callers: string[] = [];
  const nameRe = new RegExp(`\\b(${names.map(n => n.replace(/[^A-Za-z0-9_]/g, "")).filter(Boolean).join("|")})\\s*\\(`);
  for (const f of files) {
    if (!names.some(n => n && f.content.includes(n))) continue;
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!nameRe.test(lines[i])) continue;
      const ctx = autoFireContext(lines, i, f.content);
      if (ctx) callers.push(`${f.rel}: ${ctx}`);
    }
  }
  return callers;
}

/**
 * Classify the call at line i as auto-fired and describe how. Returns a label
 * like "fires on mount via useEffect(...,[])" or null if it looks event-driven.
 */
function autoFireContext(lines: string[], i: number, whole: string): string | null {
  // Look at a small window above the call for the trigger.
  const window = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
  if (/useEffect\s*\(\s*\(\)\s*=>/.test(window) && /\}\s*,\s*\[\s*\]\s*\)/.test(whole)) {
    return "fires on mount via useEffect(…, [])";
  }
  if (/useEffect\s*\(/.test(window)) return "fires via useEffect on render";
  // Component auto-opens (open={true} / defaultOpen) and the call is in its body.
  if (/\bopen\s*=\s*\{?\s*true\b/.test(whole) || /\bopen\s*=\s*true\b/.test(whole) || /defaultOpen/.test(whole)) {
    return "fires from an auto-opening component (open=true)";
  }
  // Top-level / module-eval call (not inside an event handler arrow).
  const callLine = lines[i];
  const inHandler = /on[A-Z]\w*\s*=|=>\s*\{?[^}]*$/.test(window) && /on(Click|Submit|Change|Press)/.test(window);
  if (!inHandler && /^\s*(await\s+)?[A-Za-z0-9_.]+\(/.test(callLine)) {
    return "fires unconditionally (no event handler)";
  }
  return null;
}

/**
 * Trace what emits a redirect/navigation to `target`, ranking auto-fired
 * origins first.
 */
export function traceSymptomOrigin(root: string, target: string): SymptomOriginResult {
  const files = collectSourceFiles(root);
  const origins: OriginHit[] = [];

  for (const f of files) {
    const emitters = emittersFor(f, target);
    for (const e of emitters) {
      // Names by which this emitter is reachable: its own export, plus any
      // guard-style call it sits behind.
      const reachableNames = new Set<string>();
      if (e.exportedAs) reachableNames.add(e.exportedAs);
      const guardMatch = f.content.match(GUARD_NAMES);
      if (guardMatch) reachableNames.add(guardMatch[1]);

      // First-level callers: who invokes the guard the emitter exposes?
      let names = [...reachableNames];
      const directCallers = autoFireCallers(files, names);

      // Second level: a guard is usually wrapped by a server action; trace one
      // more hop so we reach the on-mount component.
      const wrapperNames = new Set<string>();
      for (const f2 of files) {
        if (!names.some(n => n && f2.content.includes(n))) continue;
        const exp = f2.content.match(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g) ?? [];
        for (const ex of exp) {
          const m = ex.match(/function\s+([A-Za-z0-9_]+)/);
          if (m) wrapperNames.add(m[1]);
        }
      }
      const wrapperCallers = autoFireCallers(files, [...wrapperNames]);

      const callers = [...new Set([...directCallers, ...wrapperCallers])];
      origins.push({
        file: f.rel,
        line: e.line,
        lineNumber: e.lineNumber,
        exportedAs: e.exportedAs,
        callers,
        autoFired: callers.length > 0,
      });
    }
  }

  // Rank: auto-fired first, then by number of caller links (more = more central).
  origins.sort((a, b) =>
    (Number(b.autoFired) - Number(a.autoFired)) || (b.callers.length - a.callers.length));

  return { target, origins, summary: buildSummary(target, origins) };
}

function buildSummary(target: string, origins: OriginHit[]): string {
  if (origins.length === 0) {
    return `No code statically reachable to \`${target}\` was found. The redirect may be emitted by middleware, a third-party library (e.g. Clerk auth.protect), or server config rather than your own redirect() calls.`;
  }
  const top = origins[0];
  const auto = origins.filter(o => o.autoFired);
  let s = `The redirect to \`${target}\` is emitted in **${top.file}**`;
  if (top.exportedAs) s += ` (via \`${top.exportedAs}\`)`;
  s += `, not in the page \`${target}\` points at.`;
  if (auto.length) {
    const trap = auto[0].callers[0] ?? "";
    s += ` ⚠ It is reached from an auto-fired call site: ${trap}. This runs **on mount, with no user click**, so it does not look like an auth flow — that is why the symptom (\`${target}\`) named the wrong suspect. Investigate the auto-firing path before editing anything at \`${target}\`.`;
  } else {
    s += ` Trace which code paths invoke it for the affected state (e.g. anonymous user) before editing the destination.`;
  }
  return s;
}
