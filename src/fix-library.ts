/**
 * fix-library.ts — Curated fix prompt library.
 *
 * The v1 manual workflow for building the community database:
 *
 * 1. `spdg fix generate` — generates a Claude prompt with error context.
 *    You paste this into Claude manually. Claude returns a fix prompt
 *    designed to be pasted into a closed agent's chat.
 *
 * 2. `spdg fix submit` — submits the fix prompt to the library,
 *    keyed by error signature. Stored locally and pushed to team/community.
 *
 * 3. When another user hits the same error, the watcher finds the fix
 *    prompt by signature and shows it in the notification.
 *
 * This is the bridge between your Claude expertise and the closed agent user.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { signatureFromError } from "./signature.js";
import { recall } from "./memory.js";

// --- Types ---

export interface FixPromptEntry {
  id: string;
  errorSignature: string;
  errorType: string;
  errorExample: string;            // example error message this fixes
  platform: string | "any";        // which platform this is for
  fixPrompt: string;               // THE PROMPT to paste into the closed agent
  explanation: string;             // why this fix works (for the user, not the agent)
  failedApproaches: string[];      // what NOT to try
  successCount: number;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
  contributedBy?: string;
}

interface FixLibrary {
  version: number;
  entries: FixPromptEntry[];
}

// --- Storage ---

function libraryPath(cwd: string): string {
  return join(cwd, ".debug", "fix-library.json");
}

function loadLibrary(cwd: string): FixLibrary {
  const p = libraryPath(cwd);
  if (!existsSync(p)) return { version: 1, entries: [] };
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return { version: 1, entries: [] };
  }
}

function saveLibrary(cwd: string, lib: FixLibrary): void {
  const dir = join(cwd, ".debug");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(libraryPath(cwd), JSON.stringify(lib, null, 2));
}

// --- Generate Claude Prompt ---

/**
 * Generate a prompt you can paste into Claude to create a fix prompt.
 *
 * The generated prompt includes:
 * - The error text and context
 * - What was already tried and failed
 * - Past solutions from memory (if any)
 * - Instructions for Claude to generate a closed-agent-ready fix prompt
 */
export function generateFixGenerationPrompt(opts: {
  errorText: string;
  sourceFile?: string;
  platform: string;
  failedApproaches?: string[];
  cwd: string;
}): { claudePrompt: string; errorSignature: string } {
  const { errorText, sourceFile, platform, failedApproaches, cwd } = opts;
  const sig = signatureFromError(errorText, sourceFile ?? null);

  // Check memory for past context
  let memoryContext = "";
  try {
    const matches = recall(cwd, errorText, 3);
    if (matches.length > 0) {
      memoryContext = matches.map((m) =>
        `- Past diagnosis: "${m.diagnosis}" (${Math.round(m.confidence * 100)}% confidence, ${m.staleness.stale ? "code changed since" : "still valid"})`
        + (m.rootCause ? `\n  Root cause: ${m.rootCause.trigger} → fix: ${m.rootCause.fixDescription}` : "")
      ).join("\n");
    }
  } catch { /* recall failure is non-fatal */ }

  const claudePrompt = `You are generating a FIX PROMPT for a closed AI coding agent (${platform}).

The user is building an app with ${platform}. The agent hit this error and is looping — trying to fix it but failing repeatedly. The user needs a prompt they can paste into the ${platform} chat that will lead the agent to fix the error in ONE attempt.

## THE ERROR

\`\`\`
${errorText.slice(0, 2000)}
\`\`\`

${sourceFile ? `**Source file:** ${sourceFile}` : ""}

## WHAT HAS ALREADY BEEN TRIED AND FAILED

${failedApproaches?.length
    ? failedApproaches.map((a) => `- ${a}`).join("\n")
    : "No previous attempts recorded."
  }

${memoryContext ? `## PAST SOLUTIONS FROM MEMORY\n\n${memoryContext}` : ""}

## YOUR TASK

Generate a prompt the user will paste into the ${platform} agent's chat. The prompt must:

1. **Be specific.** Name the exact file, line, and change needed. Don't say "fix the error" — say "in auth.ts, line 42, add a null check before the .map() call: \`const users = data?.users ?? [];\`"

2. **Explain WHY.** The agent needs to understand the root cause, not just the symptom. "The API returns null when the session expires, but the component assumes it always returns an array."

3. **Prevent regression.** If the fix could break something else, say so. "Make sure to keep the existing error handling for the 401 case."

4. **Avoid what failed.** ${failedApproaches?.length ? "These approaches were already tried and didn't work — do NOT suggest them." : "No failed approaches to avoid."}

5. **Be copy-pasteable.** The user will literally select your entire output and paste it into the agent's chat. Don't include meta-commentary, just the prompt.

## OUTPUT FORMAT

Write the fix prompt now. Start directly with the instruction to the agent. No preamble.`;

  return { claudePrompt, errorSignature: sig };
}

// --- Submit Fix Prompt ---

/**
 * Submit a fix prompt to the library.
 * Keyed by error signature — when the same error is seen by another user,
 * this prompt is served to them.
 */
export function submitFixPrompt(
  cwd: string,
  entry: Omit<FixPromptEntry, "id" | "successCount" | "failureCount" | "createdAt" | "updatedAt">,
): FixPromptEntry {
  const lib = loadLibrary(cwd);
  const now = new Date().toISOString();

  const full: FixPromptEntry = {
    ...entry,
    id: `fix_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    successCount: 0,
    failureCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  // Replace existing entry for same signature+platform, or append
  const existingIdx = lib.entries.findIndex(
    (e) => e.errorSignature === full.errorSignature && e.platform === full.platform,
  );
  if (existingIdx >= 0) {
    // Keep the success/failure counts from the old entry
    full.successCount = lib.entries[existingIdx].successCount;
    full.failureCount = lib.entries[existingIdx].failureCount;
    full.updatedAt = now;
    lib.entries[existingIdx] = full;
  } else {
    lib.entries.push(full);
  }

  saveLibrary(cwd, lib);
  return full;
}

// --- Lookup Fix Prompt ---

/**
 * Find a fix prompt for an error.
 * Matches by signature first, then platform, then falls back to "any" platform.
 */
export function lookupFixPrompt(
  cwd: string,
  errorText: string,
  sourceFile: string | null,
  platform?: string,
): FixPromptEntry | null {
  const lib = loadLibrary(cwd);
  if (lib.entries.length === 0) return null;

  const sig = signatureFromError(errorText, sourceFile);

  // Exact signature + platform match
  const exact = lib.entries.find(
    (e) => e.errorSignature === sig && (e.platform === platform || e.platform === "any"),
  );
  if (exact) return exact;

  // Signature match, any platform
  const sigMatch = lib.entries.find((e) => e.errorSignature === sig);
  if (sigMatch) return sigMatch;

  return null;
}

/**
 * Record outcome: did the fix prompt work?
 */
export function recordFixOutcome(
  cwd: string,
  fixId: string,
  success: boolean,
): void {
  const lib = loadLibrary(cwd);
  const entry = lib.entries.find((e) => e.id === fixId);
  if (!entry) return;

  if (success) entry.successCount++;
  else entry.failureCount++;
  entry.updatedAt = new Date().toISOString();

  saveLibrary(cwd, lib);
}

/**
 * List all fix prompts in the library.
 */
export function listFixPrompts(cwd: string): FixPromptEntry[] {
  return loadLibrary(cwd).entries;
}
