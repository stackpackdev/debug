/**
 * ghost-bridge.ts — MCP client bridge to Ghost OS.
 *
 * Connects to Ghost OS as a child process via MCP stdio transport.
 * Provides typed wrappers for screenshot, DOM read, element inspection.
 * Gracefully degrades when Ghost OS is not installed.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import { getPackageVersion } from "./utils.js";

let ghostClient: Client | null = null;
let ghostTransport: StdioClientTransport | null = null;
let connectionAttempted = false;

// Diagnostic state for surfacing connection issues
let lastError: string | null = null;
let lastSuccessTs: number | null = null;
let resolvedBinaryPath: string | null = null;
let permissionDenied = false; // Tracks Screen Recording permission state

export interface VisualDiagnostic {
  connected: boolean;
  binaryFound: boolean;
  binaryPath: string | null;
  lastError: string | null;
  lastSuccessTs: number | null;
  lastSuccessAgo: string | null;
  permissionDenied: boolean;
}

export function getVisualDiagnostic(): VisualDiagnostic {
  const ago = lastSuccessTs
    ? `${Math.round((Date.now() - lastSuccessTs) / 1000)}s ago`
    : null;
  return {
    connected: ghostClient !== null,
    binaryFound: resolvedBinaryPath !== null,
    binaryPath: resolvedBinaryPath,
    lastError,
    lastSuccessTs,
    lastSuccessAgo: ago,
    permissionDenied,
  };
}

/** macOS deep-link to System Settings > Privacy & Security > Screen Recording */
export const SCREEN_RECORDING_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/** Check if an error message indicates a Screen Recording permission issue */
export function isPermissionError(errorMsg: string): boolean {
  return /screen.?recording.?permission|screen.?capture.?permission|not.?granted.*screen/i.test(errorMsg);
}

function findGhostBinary(): string | null {
  try {
    const path = execSync("which ghost 2>/dev/null || which ghost-os 2>/dev/null", {
      stdio: "pipe",
      timeout: 3000,
    }).toString().trim();
    return path || null;
  } catch {
    return null;
  }
}

export async function connectToGhostOs(): Promise<boolean> {
  if (ghostClient) return true;
  if (connectionAttempted) return false; // Don't retry failed connections repeatedly
  connectionAttempted = true;

  const binary = findGhostBinary();
  resolvedBinaryPath = binary;
  if (!binary) {
    lastError = "Ghost OS binary not found (checked 'ghost' and 'ghost-os' in PATH)";
    return false;
  }

  try {
    ghostTransport = new StdioClientTransport({
      command: binary,
      args: ["mcp"],  // Ghost OS MCP mode
    });

    ghostClient = new Client({
      name: "stackpack-debug",
      version: getPackageVersion(),
    });

    await ghostClient.connect(ghostTransport);

    // Verify connection by listing tools
    const tools = await ghostClient.listTools();
    if (!tools.tools.some((t) => t.name === "ghost_screenshot")) {
      lastError = "Ghost OS connected but ghost_screenshot tool not found — may be an incompatible version";
      await disconnectGhostOs();
      return false;
    }

    lastError = null;
    return true;
  } catch (e) {
    lastError = `Connection failed: ${e instanceof Error ? e.message : String(e)}`;
    ghostClient = null;
    ghostTransport = null;
    return false;
  }
}

export async function disconnectGhostOs(): Promise<void> {
  try {
    if (ghostClient) await ghostClient.close();
  } catch { /* ignore */ }
  ghostClient = null;
  ghostTransport = null;
}

export function isGhostConnected(): boolean {
  return ghostClient !== null;
}

export function resetConnectionState(): void {
  connectionAttempted = false;
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!ghostClient) return null;
  try {
    const result = await ghostClient.callTool({ name, arguments: args });
    // MCP tool results have a content array
    if (result.content && Array.isArray(result.content) && result.content.length > 0) {
      const first = result.content[0] as Record<string, unknown>;
      if (first.type === "text") {
        let parsed: unknown;
        try { parsed = JSON.parse(first.text as string); } catch { parsed = first.text; }
        // Check for permission error in structured response
        if (typeof parsed === "object" && parsed !== null) {
          const obj = parsed as Record<string, unknown>;
          const errorMsg = String(obj.error ?? obj.message ?? "");
          if (isPermissionError(errorMsg) || obj.success === false && isPermissionError(JSON.stringify(obj))) {
            permissionDenied = true;
            lastError = `Screen Recording permission not granted. Fix: open "${SCREEN_RECORDING_SETTINGS_URL}" — grant permission to Ghost OS, then restart it.`;
            return null;
          }
        }
        lastSuccessTs = Date.now();
        lastError = null;
        permissionDenied = false;
        return parsed;
      }
      if (first.type === "image") {
        lastSuccessTs = Date.now();
        lastError = null;
        permissionDenied = false;
        return { image: first.data, mimeType: first.mimeType };
      }
      return first;
    }
    lastSuccessTs = Date.now();
    lastError = null;
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isPermissionError(msg)) {
      permissionDenied = true;
      lastError = `Screen Recording permission not granted. Fix: open "${SCREEN_RECORDING_SETTINGS_URL}" — grant permission to Ghost OS, then restart it.`;
    } else {
      lastError = `${name} failed: ${msg}`;
    }
    return null;
  }
}

// ━━━ Typed Wrappers ━━━

export interface ScreenshotResult {
  image: string; // base64 PNG
  windowFrame?: { x: number; y: number; width: number; height: number };
}

export async function takeScreenshot(app?: string): Promise<ScreenshotResult | null> {
  const result = await callTool("ghost_screenshot", app ? { app } : {}) as Record<string, unknown> | null;
  if (!result) return null;
  // ghost_screenshot returns an image content block
  if (result.image) return { image: result.image as string };
  return null;
}

export interface ScreenElement {
  role: string;
  name: string;
  position?: { x: number; y: number };
  actionable?: boolean;
}

export async function readScreen(app?: string, query?: string): Promise<{
  text: string;
  elements: ScreenElement[];
} | null> {
  const args: Record<string, unknown> = {};
  if (app) args.app = app;
  if (query) args.query = query;
  const result = await callTool("ghost_read", args) as Record<string, unknown> | string | null;
  if (!result) return null;
  if (typeof result === "string") return { text: result, elements: [] };
  return { text: (result as Record<string, unknown>).text as string ?? String(result), elements: ((result as Record<string, unknown>).elements as ScreenElement[]) ?? [] };
}

export async function inspectElement(query: string, app?: string): Promise<{
  role: string;
  title: string;
  position: { x: number; y: number; width: number; height: number };
  visible: boolean;
} | null> {
  const args: Record<string, unknown> = { query };
  if (app) args.app = app;
  const result = await callTool("ghost_inspect", args) as Record<string, unknown> | null;
  if (!result || typeof result !== "object") return null;
  return {
    role: (result.role as string) ?? "unknown",
    title: (result.title as string) ?? "",
    position: (result.position as { x: number; y: number; width: number; height: number }) ?? { x: 0, y: 0, width: 0, height: 0 },
    visible: (result.visible as boolean) ?? true,
  };
}

export async function findElements(query: string, role?: string, app?: string): Promise<ScreenElement[]> {
  const args: Record<string, unknown> = { query };
  if (role) args.role = role;
  if (app) args.app = app;
  const result = await callTool("ghost_find", args);
  if (!result) return [];
  if (Array.isArray(result)) return result as ScreenElement[];
  if (typeof result === "object" && result !== null && "elements" in result) return (result as Record<string, unknown>).elements as ScreenElement[];
  return [];
}

export async function annotateScreen(app?: string): Promise<{
  image: string;
  labels: Array<{ id: number; role: string; name: string; x: number; y: number }>;
} | null> {
  const result = await callTool("ghost_annotate", app ? { app } : {}) as Record<string, unknown> | null;
  if (!result) return null;
  return {
    image: (result.image as string) ?? "",
    labels: (result.labels as Array<{ id: number; role: string; name: string; x: number; y: number }>) ?? (result.index as Array<{ id: number; role: string; name: string; x: number; y: number }>) ?? [],
  };
}
