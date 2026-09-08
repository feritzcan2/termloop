import { describe, expect, it } from "vitest";

import { correctMobileLogTimestamps } from "../src/platform/sentry-log-clock";

type Envelope = Parameters<typeof correctMobileLogTimestamps>[0];

describe("mobile Sentry log clock", () => {
  it("uses each diagnostic's recorded time even when the SDK clock or flush is delayed", () => {
    const first = {
      timestamp: 1_788_771_228,
      level: "info" as const,
      body: "mobile.lifecycle.initialized",
      attributes: { atEpochMs: { type: "integer" as const, value: 1_788_836_650_123 } },
    };
    const second = { ...first, attributes: { atEpochMs: { type: "double" as const, value: 1_788_836_651_456 } } };
    const envelope: Envelope = [{}, [[{ type: "log", item_count: 2, content_type: "application/vnd.sentry.items.log+json" }, { items: [first, second] }]]];
    correctMobileLogTimestamps(envelope);
    expect(first.timestamp).toBe(1_788_836_650.123);
    expect(second.timestamp).toBe(1_788_836_651.456);
    expect(first.attributes.atEpochMs.value).toBe(1_788_836_650_123);
  });

  it("preserves logs without a valid diagnostic time", () => {
    const logs = [undefined, "1788836650123", NaN, Infinity, 0, -1].map((value) => ({
      timestamp: 123, level: "info" as const, body: "sdk log",
      ...(value === undefined ? {} : { attributes: {
        atEpochMs: typeof value === "string"
          ? { type: "string" as const, value }
          : { type: "double" as const, value },
      } }),
    }));
    correctMobileLogTimestamps([{}, [[{ type: "log", item_count: logs.length, content_type: "application/vnd.sentry.items.log+json" }, { items: logs }]]]);
    expect(logs.map((log) => log.timestamp)).toEqual(logs.map(() => 123));
  });

  it("leaves error events and attachments unchanged", () => {
    const envelope: Envelope = [{ event_id: "test-event", sent_at: "2026-09-08T03:04:10Z" }, [
      [{ type: "event" }, { timestamp: 123, message: "render failed" }],
      [{ type: "attachment", length: 3, filename: "sample.bin" }, new Uint8Array([1, 2, 3])],
    ]];
    const original = structuredClone(envelope);
    correctMobileLogTimestamps(envelope);
    expect(envelope).toEqual(original);
  });
});
