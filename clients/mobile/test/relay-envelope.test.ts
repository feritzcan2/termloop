import { describe, expect, it } from "vitest";

import { createRelayDataSocket } from "../src/adapters/production/relay-data-socket";
import type { DataSocket } from "../src/adapters/production/data-socket";
import { createRelayEnvelopeCodec } from "../src/domain/relay-envelope";
import { createMobileDiagnosticReporter } from "../src/platform/mobile-diagnostics";

const key = Buffer.alloc(32, 7).toString("base64url");

describe("relay envelope", () => {
  it("round-trips text and binary without exposing content in the outer frame", () => {
    const mobile = createRelayEnvelopeCodec(key, "mobile");
    const mac = createRelayEnvelopeCodec(key, "mac");
    const text = mobile.seal("mobile.authenticate secret", false);
    const binary = mobile.seal(Uint8Array.from([0x54, 0x4c, 0x30, 0x31, 1, 2, 3]), true);

    expect(new TextDecoder().decode(text)).not.toContain("secret");
    expect(mac.open(text)).toEqual({ data: "mobile.authenticate secret", binary: false });
    expect(mac.open(binary)).toEqual({ data: Uint8Array.from([0x54, 0x4c, 0x30, 0x31, 1, 2, 3]), binary: true });
  });

  it("rejects tampering, reflection, and replayed envelopes", () => {
    const reflected = createRelayEnvelopeCodec(key, "mobile").seal("one", false);
    expect(() => createRelayEnvelopeCodec(key, "mobile").open(reflected)).toThrow("header");

    const mobile = createRelayEnvelopeCodec(key, "mobile");
    const mac = createRelayEnvelopeCodec(key, "mac");
    const sealed = mobile.seal("two", false);
    const tampered = sealed.slice();
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    expect(() => mac.open(tampered)).toThrow();
    expect(mac.open(sealed)).toEqual({ data: "two", binary: false });
    expect(() => mac.open(sealed)).toThrow("sequence");
  });

  it("adapts relay authentication and closes the stream on a tampered payload", async () => {
    const roomId = "a".repeat(32);
    const token = "relay_token_abcdefghijklmnopqrstuvwxyz0123456789";
    const sent: Array<string | ArrayBuffer | Uint8Array> = [];
    let closeCount = 0;
    const upstream: DataSocket = {
      binaryType: "blob",
      readyState: 1,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(data) { sent.push(data); },
      close() { closeCount += 1; },
    };
    const socket = createRelayDataSocket(
      "macbook",
      {
        url: "wss://relay.example.com/v1/relay",
        roomId,
        token,
        encryptionKey: key,
      },
      (url) => {
        expect(url).toBe(`wss://relay.example.com/v1/relay/${roomId}`);
        return upstream;
      },
      createMobileDiagnosticReporter(() => {}),
    );
    const opened = new Promise<void>((resolve) => { socket.onopen = resolve; });
    upstream.onopen?.();
    expect(JSON.parse(String(sent[0]))).toMatchObject({
      type: "relay.authenticate",
      side: "mobile",
      roomId,
      token,
    });
    upstream.onmessage?.({ data: JSON.stringify({
      type: "relay.ready",
      relayProtocolVersion: 1,
    }) });
    await opened;

    const mac = createRelayEnvelopeCodec(key, "mac");
    socket.send("mobile.authenticate secret");
    const encrypted = sent[1];
    expect(encrypted).toBeInstanceOf(Uint8Array);
    expect(mac.open(encrypted as Uint8Array)).toEqual({
      data: "mobile.authenticate secret",
      binary: false,
    });

    const received = new Promise<unknown>((resolve) => { socket.onmessage = resolve; });
    upstream.onmessage?.({ data: mac.seal(Uint8Array.from([1, 2, 3]), true).buffer });
    await expect(received).resolves.toMatchObject({ data: expect.any(ArrayBuffer) });

    const failed = new Promise<void>((resolve) => { socket.onerror = () => resolve(); });
    const tampered = mac.seal("broken", false);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    upstream.onmessage?.({ data: tampered.buffer });
    await failed;
    expect(closeCount).toBe(1);
  });
});
