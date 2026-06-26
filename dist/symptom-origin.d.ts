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
export declare function extractRedirectTarget(symptom: string): string | null;
/**
 * Trace what emits a redirect/navigation to `target`, ranking auto-fired
 * origins first.
 */
export declare function traceSymptomOrigin(root: string, target: string): SymptomOriginResult;
