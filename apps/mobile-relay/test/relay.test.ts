import { SELF, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

const roomId = "a".repeat(32);
const token = "relay_token_abcdefghijklmnopqrstuvwxyz0123456789";

afterEach(async () => reset());

describe("mobile relay", () => {
  it("reports health without touching a Durable Object", async () => {
    const response = await SELF.fetch("https://relay.example/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ready: true });
  });

  it("forwards only opaque binary frames after both sides prove the room token", async () => {
    const mac = await connect(roomId);
    const mobile = await connect(roomId);
    const macReady = nextMessage(mac);
    const mobileReady = nextMessage(mobile);
    authenticate(mac, roomId, "mac", token);
    authenticate(mobile, roomId, "mobile", token);
    await expect(macReady).resolves.toMatchObject({ data: expect.stringContaining("relay.ready") });
    await expect(mobileReady).resolves.toMatchObject({ data: expect.stringContaining("relay.ready") });

    const forwarded = nextMessage(mac);
    mobile.send(Uint8Array.from([0x54, 0x4c, 0x52, 0x31, 7, 8, 9]).buffer);
    const event = await forwarded;
    expect(new Uint8Array(event.data as ArrayBuffer)).toEqual(
      Uint8Array.from([0x54, 0x4c, 0x52, 0x31, 7, 8, 9]),
    );

    mac.close(1000, "test complete");
    mobile.close(1000, "test complete");
  });

  it("rejects a mismatched room token and closes the authenticated peer for a clean reconnect", async () => {
    const mac = await connect("b".repeat(32));
    const attacker = await connect("b".repeat(32));
    authenticate(mac, "b".repeat(32), "mac", token);
    const refused = nextClose(attacker);
    authenticate(attacker, "b".repeat(32), "mobile", "different_token_abcdefghijklmnopqrstuvwxyz");
    await expect(refused).resolves.toMatchObject({ code: 1008 });

    const mobile = await connect("b".repeat(32));
    const macReady = nextMessage(mac);
    const mobileReady = nextMessage(mobile);
    authenticate(mobile, "b".repeat(32), "mobile", token);
    await macReady;
    await mobileReady;
    const macClosed = nextClose(mac);
    mobile.close(1000, "fault injection");
    await expect(macClosed).resolves.toMatchObject({ code: 1012 });
  });
});

async function connect(id: string): Promise<WebSocket> {
  const response = await SELF.fetch(`https://relay.example/v1/relay/${id}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) throw new Error("Relay did not return a WebSocket.");
  socket.binaryType = "arraybuffer";
  socket.accept();
  return socket;
}

function authenticate(socket: WebSocket, id: string, side: "mac" | "mobile", credential: string): void {
  socket.send(JSON.stringify({
    type: "relay.authenticate",
    relayProtocolVersion: 1,
    side,
    roomId: id,
    token: credential,
  }));
}

function nextMessage(socket: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Relay socket failed.")), { once: true });
  });
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
}
