import assert from "node:assert/strict";
import test from "node:test";
import { TermLoopControlClient } from "../dist/current.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sockets = [];
  const client = new TermLoopControlClient("ws://127.0.0.1/control", "x".repeat(64), () => {
    const listeners = new Map();
    const socket = {
      sent: [], closed: 0,
      addEventListener(type, listener) { listeners.set(type, listener); },
      send(raw) { socket.sent.push(JSON.parse(raw)); },
      // Deliberately emit no close event: a stalled transport may never deliver one.
      close() { socket.closed += 1; },
      emit(type, event = {}) { listeners.get(type)?.(event); },
      reply(result = { pong: true }) {
        const request = socket.sent.at(-1);
        socket.emit("message", { data: JSON.stringify({ id: request.id, ok: true, result }) });
      },
    };
    sockets.push(socket);
    return socket;
  });
  t.after(() => client.close());
  return { client, sockets };
}

test("a stalled handshake times out, closes its socket, and permits a fresh connection", async (t) => {
  const { client, sockets } = fixture(t);
  const timedOut = assert.rejects(client.ping(), /timeout/);
  await flush();
  t.mock.timers.tick(12_000);
  await timedOut;
  assert.equal(sockets[0].closed, 1);

  const recovered = client.ping();
  await flush();
  assert.equal(sockets.length, 2);
  sockets[1].emit("open");
  await flush();
  sockets[1].reply();
  assert.deepEqual(await recovered, { pong: true });
});

test("handshake timeout also bounds commands with a long response budget", async (t) => {
  const { client, sockets } = fixture(t);
  const timedOut = assert.rejects(client.call("taskSource.refresh", { sourceId: "source", expectedGeneration: 1 }), /timeout/);
  await flush();
  t.mock.timers.tick(12_000);
  await timedOut;
  assert.equal(sockets[0].closed, 1);
});

test("close settles concurrent connection waiters without needing a socket event", async (t) => {
  const { client, sockets } = fixture(t);
  const first = assert.rejects(client.ping(), /connection closed/);
  const second = assert.rejects(client.ping(), /connection closed/);
  await flush();
  assert.equal(sockets.length, 1);
  client.close();
  await Promise.all([first, second]);
  assert.equal(sockets[0].closed, 1);

  const recovered = client.ping();
  await flush();
  sockets[1].emit("open");
  await flush();
  // Events from the abandoned socket must not replace or close the new one.
  sockets[0].emit("open");
  sockets[0].emit("error");
  sockets[0].emit("close");
  sockets[1].reply();
  assert.deepEqual(await recovered, { pong: true });
  assert.equal(sockets[1].closed, 0);
});

test("close before the connection microtask does not create a socket", async (t) => {
  const { client, sockets } = fixture(t);
  const closed = assert.rejects(client.ping(), /connection closed/);
  client.close();
  await closed;
  await flush();
  assert.equal(sockets.length, 0);
});

test("successful open clears the handshake deadline without shortening a long command", async (t) => {
  const { client, sockets } = fixture(t);
  const response = client.call("agent.authStatusList");
  await flush();
  sockets[0].emit("open");
  await flush();
  t.mock.timers.tick(12_000);
  assert.equal(sockets[0].closed, 0);
  const closed = assert.rejects(response, /connection closed/);
  client.close();
  await closed;
});

test("a connected request timeout sends cancellation and preserves the connection", async (t) => {
  const { client, sockets } = fixture(t);
  const timedOut = assert.rejects(client.ping(), /request timeout/);
  await flush();
  sockets[0].emit("open");
  await flush();
  t.mock.timers.tick(12_000);
  await timedOut;
  assert.equal(sockets[0].closed, 0);
  assert.equal(sockets[0].sent[1].method, "control.cancel");
  assert.equal(sockets[0].sent[1].params.requestId, sockets[0].sent[0].id);
  const recovered = client.ping();
  await flush();
  assert.equal(sockets.length, 1);
  sockets[0].reply();
  await recovered;
});
