import type { ReactNativeClient } from "@sentry/react-native";

type SentryEnvelope = Parameters<ReactNativeClient["sendEnvelope"]>[0];

// RN 0.86's performance clock can backdate SDK logs by the device's uptime.
// Correct our logs from their recorded wall-clock time at the envelope boundary;
// beforeSendLog runs before the SDK assigns the affected timestamp.
export function correctMobileLogTimestamps(envelope: SentryEnvelope): void {
  for (const [header, payload] of envelope[1]) {
    if (header.type !== "log" || typeof payload !== "object" || payload === null || !("items" in payload)) continue;
    for (const log of payload.items) {
      const atEpochMs = log.attributes?.atEpochMs?.value;
      if ("timestamp" in log && typeof atEpochMs === "number" && Number.isFinite(atEpochMs) && atEpochMs > 0) {
        log.timestamp = atEpochMs / 1_000;
      }
    }
  }
}
