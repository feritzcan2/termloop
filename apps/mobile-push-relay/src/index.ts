import { DurableObject } from "cloudflare:workers";
import { invalidDeviceReason, loadApnsProvider, sendApns, type ApnsSecrets } from "./apns";
import { pushRequestOf, type PushRequest } from "./validation";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_PUSHES_PER_MINUTE = 120;
const MAX_PUSHES_PER_DAY = 2_000;
const RESPONSE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export type RelayEnv = Env & ApnsSecrets;
type DeliveryResult = { index: number; ok: boolean; status?: number; reason?: string };
type DeliveryResponse = { version: 1; results: DeliveryResult[] };
type RelayError = { version: 1; error: string };

export class Installation extends DurableObject<RelayEnv> {
  async deliver(token: string, request: PushRequest): Promise<DeliveryResponse | RelayError> {
    const tokenHash = await sha256(token);
    const access = await this.ctx.storage.transaction(async (transaction) => {
      const storedHash = await transaction.get<string>("authHash");
      if (storedHash !== undefined && !constantTimeEqual(storedHash, tokenHash)) return "unauthorized" as const;

      const now = Date.now();
      const minuteWindow = Math.floor(now / 60_000);
      const dayWindow = Math.floor(now / 86_400_000);
      const minute = await transaction.get<{ window: number; count: number }>("minute");
      const day = await transaction.get<{ window: number; count: number }>("day");
      const minuteCount = minute?.window === minuteWindow ? minute.count : 0;
      const dayCount = day?.window === dayWindow ? day.count : 0;
      if (minuteCount + request.devices.length > MAX_PUSHES_PER_MINUTE
        || dayCount + request.devices.length > MAX_PUSHES_PER_DAY) return "rateLimited" as const;

      if (storedHash === undefined) await transaction.put("authHash", tokenHash);
      await transaction.put("minute", { window: minuteWindow, count: minuteCount + request.devices.length });
      await transaction.put("day", { window: dayWindow, count: dayCount + request.devices.length });
      return "allowed" as const;
    });
    if (access !== "allowed") return { version: 1, error: access };

    let provider;
    try {
      provider = await loadApnsProvider(this.env);
    } catch {
      console.error(JSON.stringify({ event: "apns_provider_unavailable" }));
      return { version: 1, error: "providerUnavailable" };
    }
    const startedAt = Date.now();
    const results = await Promise.all(request.devices.map(async (device, index): Promise<DeliveryResult> => {
      const result = await sendApns(provider, device, device.payload);
      return { index, ...result };
    }));
    console.log(JSON.stringify({
      event: "push_batch_completed",
      targetCount: results.length,
      acceptedCount: results.filter((result) => result.ok).length,
      invalidCount: results.filter((result) => invalidDeviceReason(result.reason)).length,
      durationMs: Date.now() - startedAt,
    }));
    return { version: 1, results };
  }
}

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json(200, { ready: true, version: 1 });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/push") {
      return json(404, { version: 1, error: "notFound" });
    }
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return json(413, { version: 1, error: "requestTooLarge" });
    }
    const token = bearerToken(request.headers.get("authorization"));
    if (token === undefined) return json(401, { version: 1, error: "unauthorized" });

    let body: unknown;
    try {
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > MAX_BODY_BYTES) return json(413, { version: 1, error: "requestTooLarge" });
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return json(400, { version: 1, error: "invalidRequest" });
    }
    const push = pushRequestOf(body);
    if (push === undefined) return json(400, { version: 1, error: "invalidRequest" });

    const durableId = env.INSTALLATIONS.idFromName(push.installationId);
    const outcome = await env.INSTALLATIONS.get(durableId).deliver(token, push);
    if ("results" in outcome) return json(200, outcome);
    if (outcome.error === "unauthorized") return json(401, outcome);
    if (outcome.error === "rateLimited") return json(429, outcome, { "retry-after": "60" });
    return json(503, outcome);
  },
} satisfies ExportedHandler<RelayEnv>;

function bearerToken(value: string | null): string | undefined {
  const match = /^Bearer ([a-f0-9]{64})$/u.exec(value ?? "");
  return match?.[1];
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function json(status: number, body: object, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...RESPONSE_HEADERS, ...extraHeaders },
  });
}
