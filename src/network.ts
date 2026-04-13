import { execSync } from "node:child_process";
import { platform } from "node:os";

// --- Types ---

export interface DevServerInfo {
  port: number;
  pid: number;
  process: string;
}

export interface Connection {
  remoteAddr: string;
  remotePort: number;
  state: string;
  service?: string;
}

export interface NetworkTopology {
  devServer: DevServerInfo | null;
  inbound: Connection[];
  outbound: Connection[];
  missing?: string[];
}

// --- Well-known service ports ---

const SERVICE_MAP: Record<number, string> = {
  11434: "ollama",
  5432: "postgres",
  3306: "mysql",
  6379: "redis",
  27017: "mongodb",
  80: "http",
  443: "https",
};

export function inferService(port: number): string | undefined {
  return SERVICE_MAP[port];
}

// --- lsof parsing ---

export function parseLsofListeners(output: string): DevServerInfo[] {
  if (!output.trim()) return [];

  const seen = new Map<number, DevServerInfo>();

  for (const line of output.split("\n")) {
    if (!line.includes("(LISTEN)")) continue;

    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;

    const command = parts[0];
    const pid = parseInt(parts[1], 10);
    const name = parts[parts.length - 2]; // NAME column, before (LISTEN)

    // Extract port from formats like 127.0.0.1:3000 or [::1]:3000 or *:3000
    const portMatch = name.match(/:(\d+)$/);
    if (!portMatch) continue;

    const port = parseInt(portMatch[1], 10);

    // Deduplicate by port (IPv4 and IPv6 both show up)
    if (!seen.has(port)) {
      seen.set(port, { port, pid, process: command });
    }
  }

  return Array.from(seen.values());
}

export function parseLsofConnections(
  output: string,
  serverPid: number
): { inbound: Connection[]; outbound: Connection[] } {
  if (!output.trim()) return { inbound: [], outbound: [] };

  const inbound: Connection[] = [];
  const outbound: Connection[] = [];

  for (const line of output.split("\n")) {
    if (!line.includes("(ESTABLISHED)")) continue;

    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;

    const pid = parseInt(parts[1], 10);
    if (pid !== serverPid) continue;

    const name = parts[parts.length - 2]; // NAME column, before (ESTABLISHED)

    // Format: 127.0.0.1:3000->127.0.0.1:54321
    const connMatch = name.match(
      /^(.+):(\d+)->(.+):(\d+)$/
    );
    if (!connMatch) continue;

    const remoteAddr = connMatch[3];
    const remotePort = parseInt(connMatch[4], 10);
    const service = inferService(remotePort);

    const conn: Connection = {
      remoteAddr,
      remotePort,
      state: "ESTABLISHED",
      ...(service ? { service } : {}),
    };

    if (service) {
      outbound.push(conn);
    } else {
      inbound.push(conn);
    }
  }

  return { inbound, outbound };
}
