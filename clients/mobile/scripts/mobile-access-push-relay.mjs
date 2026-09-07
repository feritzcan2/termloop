const RELAY_RESPONSE_LIMIT_BYTES = 32 * 1024;
const INVALID_DEVICE_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);

export function pushRelayOf(value) {
  const present = [value?.pushRelayUrl, value?.pushRelayInstallationId, value?.pushRelayToken]
    .filter((entry) => entry !== undefined).length;
  if (present === 0) return undefined;
  if (present !== 3) throw new Error("mobile push relay config is incomplete");
  const url = new URL(value.pushRelayUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("mobile push relay URL is invalid");
  }
  if (!/^[a-f0-9]{32}$/u.test(value.pushRelayInstallationId)
    || !/^[a-f0-9]{64}$/u.test(value.pushRelayToken)) {
    throw new Error("mobile push relay credential is invalid");
  }
  return {
    url: url.origin,
    installationId: value.pushRelayInstallationId,
    token: value.pushRelayToken,
  };
}

export async function sendPushRelay(relay, devices, fetchImpl = globalThis.fetch) {
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(new URL("/v1/push", `${relay.url}/`), {
      method: "POST",
      headers: {
        authorization: `Bearer ${relay.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        installationId: relay.installationId,
        devices,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const source = await response.text();
    if (Buffer.byteLength(source) > RELAY_RESPONSE_LIMIT_BYTES) {
      return failed("invalidResponse", startedAt);
    }
    let body;
    try { body = JSON.parse(source); } catch { return failed(`http${response.status}`, startedAt); }
    if (!response.ok) {
      return failed(typeof body?.error === "string" && /^[A-Za-z]{1,64}$/u.test(body.error)
        ? body.error
        : `http${response.status}`, startedAt);
    }
    const results = deliveryResultsOf(body, devices.length);
    return results === undefined
      ? failed("invalidResponse", startedAt)
      : { ok: true, results, durationMs: Date.now() - startedAt };
  } catch {
    return failed("transport", startedAt);
  }
}

export function invalidPushDeviceReason(reason) {
  return INVALID_DEVICE_REASONS.has(reason);
}

function deliveryResultsOf(value, targetCount) {
  if (value?.version !== 1 || !Array.isArray(value.results) || value.results.length !== targetCount) {
    return undefined;
  }
  const indexes = new Set();
  const results = [];
  for (const result of value.results) {
    if (!Number.isInteger(result?.index) || result.index < 0 || result.index >= targetCount
      || indexes.has(result.index) || typeof result.ok !== "boolean"
      || (result.status !== undefined && (!Number.isInteger(result.status)
        || result.status < 100 || result.status > 599))
      || (result.reason !== undefined && (typeof result.reason !== "string"
        || !/^[A-Za-z0-9]{1,64}$/u.test(result.reason)))) return undefined;
    indexes.add(result.index);
    results.push({
      index: result.index,
      ok: result.ok,
      ...(result.status === undefined ? {} : { status: result.status }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    });
  }
  return results.sort((left, right) => left.index - right.index);
}

function failed(reason, startedAt) {
  return { ok: false, reason, durationMs: Date.now() - startedAt };
}
