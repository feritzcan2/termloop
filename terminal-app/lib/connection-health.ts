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
  let lastErr: unknown = null;
  for (const host of connectionHostCandidates(conn)) {
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
      return { ok: true };
    } catch (err) {
      lastErr = err;
    } finally {
      await client.close().catch(() => {});
    }
  }
  return { ok: false, err: lastErr };
}
