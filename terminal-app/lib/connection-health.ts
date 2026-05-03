// Lightweight probe for a saved connection. Opens a short-lived TCP socket,
// authenticates with the saved credential (auth alone validates liveness —
// a separate ping is unnecessary), then closes.

import { connectionHostCandidates, type SavedConnection } from "./connections";
import { applyAuth } from "./session";
import { TcpTransport } from "./tcp-transport";
import { createTermLoopClient } from "./termloop-client";

export type HealthStatus = "unknown" | "online" | "offline" | "needs_reauth";

export interface PingResult {
  ok: boolean;
  err?: unknown;
}

export async function pingConnection(
  conn: SavedConnection,
  timeoutMs = 2500
): Promise<PingResult> {
  const hosts = connectionHostCandidates(conn);
  if (hosts.length === 0) return { ok: false, err: new Error("No host") };
  let lastErr: unknown = null;
  let remaining = hosts.length;

  return new Promise<PingResult>((resolve) => {
    let resolved = false;
    const finish = (result: PingResult) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    const probe = async (host: string) => {
      const transport = new TcpTransport({
        host,
        port: conn.port,
        connectTimeoutMs: timeoutMs,
        requestTimeoutMs: timeoutMs,
      });
      const client = createTermLoopClient({ transport });
      try {
        const { authenticated } = await applyAuth(client, conn);
        if (!authenticated) await client.ping();
        finish({ ok: true });
      } catch (err) {
        lastErr = err;
      } finally {
        await client.close().catch(() => {});
        remaining -= 1;
        if (remaining === 0) finish({ ok: false, err: lastErr });
      }
    };

    for (const host of hosts) void probe(host);
  });
}
