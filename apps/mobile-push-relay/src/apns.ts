import type { ApnsPayload, PushDevice } from "./validation";

export type ApnsSecrets = {
  APNS_PRIVATE_KEY: string;
  APNS_TEAM_ID: string;
  APNS_KEY_ID: string;
};

export type ApnsResult = {
  ok: boolean;
  status?: number;
  reason?: string;
};

type ApnsProvider = {
  teamId: string;
  keyId: string;
  privateKey: CryptoKey;
};

export async function loadApnsProvider(secrets: ApnsSecrets): Promise<ApnsProvider> {
  if (!/^[A-Z0-9]{4,32}$/u.test(secrets.APNS_TEAM_ID)
    || !/^[A-Z0-9]{4,32}$/u.test(secrets.APNS_KEY_ID)) throw new Error("invalid APNs identifiers");
  const der = pemBytes(secrets.APNS_PRIVATE_KEY);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return { teamId: secrets.APNS_TEAM_ID, keyId: secrets.APNS_KEY_ID, privateKey };
}

export async function createApnsJwt(
  provider: ApnsProvider,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: provider.keyId })));
  const claims = base64url(new TextEncoder().encode(JSON.stringify({ iss: provider.teamId, iat: nowEpochSeconds })));
  const message = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    provider.privateKey,
    new TextEncoder().encode(message),
  );
  return `${message}.${base64url(new Uint8Array(signature))}`;
}

export async function sendApns(
  provider: ApnsProvider,
  device: Pick<PushDevice, "deviceToken" | "environment" | "bundleId">,
  payload: ApnsPayload,
): Promise<ApnsResult> {
  const hosts = device.environment === "production"
    ? ["api.push.apple.com", "api.sandbox.push.apple.com"]
    : ["api.sandbox.push.apple.com", "api.push.apple.com"];
  const jwt = await createApnsJwt(provider);
  let result: ApnsResult = { ok: false, reason: "transport" };
  for (const host of hosts) {
    result = await sendOne(jwt, device, payload, host);
    if (result.ok || !invalidDeviceReason(result.reason)) return result;
  }
  return result;
}

export function invalidDeviceReason(reason: string | undefined): boolean {
  return reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic" || reason === "Unregistered";
}

async function sendOne(
  jwt: string,
  device: Pick<PushDevice, "deviceToken" | "bundleId">,
  payload: ApnsPayload,
  host: string,
): Promise<ApnsResult> {
  try {
    const response = await fetch(`https://${host}/3/device/${device.deviceToken}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${jwt}`,
        "apns-topic": device.bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 200) return { ok: true, status: 200 };
    const reason = await response.json<{ reason?: unknown }>()
      .then((body) => safeReason(body.reason))
      .catch(() => undefined);
    return { ok: false, status: response.status, ...(reason === undefined ? {} : { reason }) };
  } catch {
    return { ok: false, reason: "transport" };
  }
}

function safeReason(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9]{1,64}$/u.test(value) ? value : undefined;
}

function pemBytes(value: string): Uint8Array {
  const base64 = value
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/gu, "");
  if (base64.length === 0) throw new Error("invalid APNs private key");
  const raw = atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function base64url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}
