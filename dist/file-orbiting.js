/**
 * file-orbiting.ts — detect the "editing the same file repeatedly while the bug
 * lives elsewhere" loop.
 *
 * The session already detects *error-fingerprint* orbiting. That missed the
 * motivating bug because the error text shifted between attempts; what stayed
 * constant was the set of files the agent kept editing. This complements it by
 * watching the files, not the errors.
 */
const ORBIT_THRESHOLD = 3;
/**
 * Returns a warning when the same source file has been the suspect across
 * ORBIT_THRESHOLD+ consecutive *unresolved* attempts at the tail of the
 * trajectory. Null otherwise.
 */
export function detectFileOrbiting(trajectory) {
    // Only the trailing unresolved streak counts — a resolved attempt resets it.
    const streak = [];
    for (let i = trajectory.length - 1; i >= 0; i--) {
        if (trajectory[i].resolved)
            break;
        streak.unshift(trajectory[i]);
    }
    if (streak.length < ORBIT_THRESHOLD)
        return null;
    // Count how many attempts in the streak touched each file.
    const counts = new Map();
    for (const e of streak) {
        for (const f of new Set(e.sourceFiles))
            counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    let hot = null;
    let hotCount = 0;
    for (const [f, c] of counts) {
        if (c > hotCount) {
            hot = f;
            hotCount = c;
        }
    }
    if (!hot || hotCount < ORBIT_THRESHOLD)
        return null;
    return {
        file: hot,
        attempts: hotCount,
        message: `You've focused on \`${hot}\` across ${hotCount} consecutive attempts without resolving the symptom. ` +
            `Repeatedly editing the same file while the symptom persists usually means the cause is elsewhere — ` +
            `you may be editing the *destination* or *symptom site*, not what *emits* it. ` +
            `If the symptom is a redirect or navigation, run debug_trace_origin on the destination path to find the code that emits it. ` +
            `Otherwise, ask: what runs unprompted (on mount / on load) for the affected state that you haven't inspected yet?`,
    };
}
//# sourceMappingURL=file-orbiting.js.map