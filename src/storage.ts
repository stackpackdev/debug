/**
 * storage.ts — Team memory backend for shared debugging knowledge.
 *
 * Local memory (memory.ts) remains primary and unchanged.
 * This module adds team sync: push local entries to StackPack platform,
 * pull team knowledge on recall, merge results.
 *
 * Requires STACKPACK_EVENTS_URL + STACKPACK_API_KEY env vars.
 * Degrades gracefully: if not configured or unreachable, returns empty.
 */

import type { MemoryEntry, CausalLink } from "./memory.js";

// --- Types ---

export interface TeamRecallResult {
  entry: MemoryEntry;
  relevance: number;
  contributedBy: string;        // team member name or email
  projectSlug: string | null;   // which project this came from
  successRate: number;           // times_succeeded / (times_succeeded + times_failed)
  superseded: boolean;           // a newer fix exists for this signature
  source: "team";
}

export interface TeamPushResult {
  synced: number;
  conflicts: number;
  errors: string[];
}

export interface TeamPullResult {
  entries: Array<MemoryEntry & { contributedBy: string; successRate: number }>;
  cursor: string;                // for pagination
}

// --- Team Memory Client ---

export class TeamMemoryClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    // Normalize: ensure base URL ends without trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  /**
   * Create a client from environment variables.
   * Returns null if not configured.
   */
  static fromEnv(): TeamMemoryClient | null {
    const url = process.env.STACKPACK_EVENTS_URL;
    const key = process.env.STACKPACK_API_KEY;
    if (!url || !key) return null;

    // Derive debug memory API base URL from events URL.
    // STACKPACK_EVENTS_URL may be:
    //   https://host.fly.dev/api/events/myproject
    //   https://host.fly.dev/api/events
    //   https://host.fly.dev
    // We need the origin: https://host.fly.dev
    // Then our endpoints are at /api/debug/memories/*
    let base: string;
    try {
      const parsed = new URL(url);
      base = parsed.origin; // https://host.fly.dev
    } catch {
      // Fallback: strip everything after the host
      base = url.replace(/\/(api\/)?events\/?.*$/, "");
    }
    return new TeamMemoryClient(base, key);
  }

  /**
   * Push local memory entries to the team pool.
   * Deduplicates by error signature on the server side.
   */
  async push(entries: MemoryEntry[]): Promise<TeamPushResult> {
    try {
      const res = await fetch(`${this.baseUrl}/api/debug/memories`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ entries }),
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        return { synced: 0, conflicts: 0, errors: [`HTTP ${res.status}`] };
      }

      return await res.json() as TeamPushResult;
    } catch (err) {
      return { synced: 0, conflicts: 0, errors: [String(err)] };
    }
  }

  /**
   * Pull new team entries since a timestamp.
   */
  async pull(since: string): Promise<TeamPullResult> {
    try {
      const params = new URLSearchParams({ since });
      const res = await fetch(
        `${this.baseUrl}/api/debug/memories/pull?${params}`,
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          signal: AbortSignal.timeout(5000),
        },
      );

      if (!res.ok) {
        return { entries: [], cursor: since };
      }

      return await res.json() as TeamPullResult;
    } catch {
      return { entries: [], cursor: since };
    }
  }

  /**
   * Search team memory for past solutions.
   * Falls back to empty results on any error.
   */
  async recall(
    query: string,
    opts: {
      errorSignature?: string;
      sourceFile?: string;
      limit?: number;
      projectSlug?: string;
      scope?: "project" | "org";
    } = {},
  ): Promise<TeamRecallResult[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/debug/memories/recall`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          errorSignature: opts.errorSignature,
          sourceFile: opts.sourceFile,
          limit: opts.limit ?? 5,
          projectSlug: opts.projectSlug,
          scope: opts.scope ?? "project",
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) return [];

      const data = await res.json() as { results: TeamRecallResult[] };
      return data.results ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Report outcome for a recalled entry — closes the feedback loop.
   * Increments times_applied + times_succeeded/times_failed on the server.
   */
  async reportOutcome(
    entryId: string,
    outcome: { applied: boolean; succeeded: boolean },
  ): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/debug/memories/${entryId}/outcome`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(outcome),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // Silent — outcome reporting must never break debug
    }
  }
}

/**
 * Merge local recall results with team recall results.
 * Local results always rank first. Team results fill remaining slots.
 * Entries matching failedApproaches get annotated.
 */
export function mergeRecallResults<
  L extends { relevance: number; confidence: number },
>(
  local: L[],
  team: TeamRecallResult[],
  limit: number,
  failedApproaches?: string[],
): Array<(L & { source: "local" }) | (TeamRecallResult & { failedApproachWarning?: string })> {
  const results: Array<
    (L & { source: "local" }) | (TeamRecallResult & { failedApproachWarning?: string })
  > = [];

  // Local results first
  for (const r of local) {
    if (results.length >= limit) break;
    results.push({ ...r, source: "local" as const });
  }

  // Team results fill remaining
  if (team.length > 0 && results.length < limit) {
    // Deduplicate: skip team entries that overlap with local by problem text
    const localProblems = new Set(
      local.map((r) => (r as any).problem?.toLowerCase?.()).filter(Boolean),
    );

    for (const t of team) {
      if (results.length >= limit) break;
      if (t.superseded) continue;
      if (localProblems.has(t.entry.problem?.toLowerCase())) continue;

      // Check against failed approaches
      let warning: string | undefined;
      if (failedApproaches?.length) {
        const diagLower = t.entry.diagnosis.toLowerCase();
        const match = failedApproaches.find((fa) =>
          diagLower.includes(fa.toLowerCase()) || fa.toLowerCase().includes(diagLower),
        );
        if (match) {
          warning = `WARNING: similar approach was already tried this session and failed: "${match}"`;
        }
      }

      results.push({ ...t, failedApproachWarning: warning });
    }
  }

  return results;
}
