import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { ControlSubscription } from "../src/main/control-subscription.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("ControlSubscription", () => {
  it("retains Project demand set before the subscription socket starts", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected socket address");
    let receivedProjectIds: string[] | undefined;
    server.on("connection", (socket) => {
      socket.once("message", (raw) => {
        const request = JSON.parse(String(raw)) as { id: string; params: { projectIds?: string[] } };
        receivedProjectIds = request.params.projectIds;
        socket.send(JSON.stringify({
          id: request.id,
          ok: true,
          result: { stateRevision: 1, observationSequence: 0 },
        }));
      });
    });

    const subscription = new ControlSubscription(
      () => {},
      undefined,
      async () => localConnectionConfig(address.port),
    );
    subscription.setProjectIds(["project-selected"]);
    subscription.start();
    await waitUntil(() => receivedProjectIds !== undefined);

    expect(receivedProjectIds).toEqual(["project-selected"]);
    subscription.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("reconnects with the selected Project after an initial unscoped subscription", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected socket address");
    const receivedProjectIds: Array<string[] | undefined> = [];
    server.on("connection", (socket) => {
      socket.once("message", (raw) => {
        const request = JSON.parse(String(raw)) as { id: string; params: { projectIds?: string[] } };
        receivedProjectIds.push(request.params.projectIds);
        socket.send(JSON.stringify({
          id: request.id,
          ok: true,
          result: { stateRevision: 1, observationSequence: 0 },
        }));
      });
    });

    const states: string[] = [];
    const subscription = new ControlSubscription(
      () => {},
      undefined,
      async () => localConnectionConfig(address.port),
      (state) => states.push(state),
    );
    subscription.start();
    await waitUntil(() => receivedProjectIds.length === 1);
    await waitUntil(() => states.at(-1) === "connected");
    states.length = 0;
    subscription.setProjectIds(["project-selected"]);
    await waitUntil(() => receivedProjectIds.length === 2);
    await waitUntil(() => states.at(-1) === "connected");

    expect(receivedProjectIds).toEqual([undefined, ["project-selected"]]);
    expect(states).not.toContain("offline");
    subscription.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("retries a launch hook failure through its existing reconnect loop", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected socket address");
    const subscribedTopics: string[][] = [];
    server.on("connection", (socket) => {
      socket.once("message", (raw) => {
        const request = JSON.parse(String(raw)) as { id: string; params: { topics: string[] } };
        subscribedTopics.push(request.params.topics);
        socket.send(JSON.stringify({
          id: request.id,
          ok: true,
          result: { stateRevision: 1, observationSequence: 0 },
        }));
      });
    });

    let attempts = 0;
    let invalidations = 0;
    let connectedTopics: string[] = [];
    const subscription = new ControlSubscription(
      (payload) => { invalidations += 1; connectedTopics = payload.topics; },
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("daemon command was not accepted");
      },
      async () => localConnectionConfig(address.port),
    );
    subscription.start();
    await waitUntil(() => invalidations === 1);

    expect(attempts).toBe(3);
    expect(subscribedTopics.at(-1)).toEqual(expect.arrayContaining(["steward", "routine"]));
    expect(subscribedTopics.at(-1)).not.toContain("worker");
    expect(connectedTopics).toEqual(expect.arrayContaining(["steward", "routine"]));
    expect(connectedTopics).not.toContain("worker");
    subscription.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("retries when an SSH connection config is temporarily unavailable", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected socket address");
    let subscriptions = 0;
    server.on("connection", (socket) => {
      socket.once("message", (raw) => {
        subscriptions += 1;
        const request = JSON.parse(String(raw)) as { id: string };
        socket.send(JSON.stringify({
          id: request.id,
          ok: true,
          result: { stateRevision: 1, observationSequence: 0 },
        }));
      });
    });
    let resolutions = 0;
    const subscription = new ControlSubscription(
      () => {},
      undefined,
      async () => {
        resolutions += 1;
        if (resolutions === 1) throw new Error("SSH tunnel is reconnecting");
        return {
          kind: "local" as const,
          controlUrl: `ws://127.0.0.1:${address.port}`,
          token: "control-token",
          terminalUrl: "ws://127.0.0.1:1",
          terminalToken: "terminal-token",
        };
      },
    );

    subscription.start();
    await waitUntil(() => subscriptions === 1);

    expect(resolutions).toBeGreaterThanOrEqual(2);
    subscription.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("reports the remote handshake failure while reconnecting", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected socket address");
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({ kind: "invalid-challenge" }));
    });
    const states: Array<{ state: string; message?: string }> = [];
    const subscription = new ControlSubscription(
      () => {},
      undefined,
      async () => ({
        kind: "remote" as const,
        profileId: "remote-profile",
        controlUrl: `ws://127.0.0.1:${address.port}`,
        terminalUrl: "ws://127.0.0.1:1",
        token: "control-token",
        terminalToken: "terminal-token",
        credential: {
          deviceId: "device-id",
          privateKey: {},
          serverFingerprint: `sha256:${"a".repeat(64)}`,
        },
      }),
      (state, message) => states.push({ state, ...(message ? { message } : {}) }),
    );

    subscription.start();
    await waitUntil(() => states.some(({ state }) => state === "offline"));

    expect(states).toContainEqual({
      state: "offline",
      message: "remote access challenge is invalid",
    });
    subscription.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("does not let a stopped generation schedule a duplicate socket after restart", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected socket address");
    let subscriptions = 0;
    server.on("connection", (socket) => {
      socket.once("message", (raw) => {
        subscriptions += 1;
        const request = JSON.parse(String(raw)) as { id: string };
        socket.send(JSON.stringify({
          id: request.id,
          ok: true,
          result: { stateRevision: 1, observationSequence: 0 },
        }));
      });
    });

    const subscription = new ControlSubscription(
      () => {},
      undefined,
      async () => localConnectionConfig(address.port),
    );
    subscription.start();
    await waitUntil(() => subscriptions === 1);
    subscription.stop();
    subscription.start();
    await waitUntil(() => subscriptions === 2);
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(subscriptions).toBe(2);
    subscription.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("reconnects immediately when the user refreshes an offline source", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected socket address");
    let subscriptions = 0;
    server.on("connection", (socket) => {
      socket.once("message", (raw) => {
        subscriptions += 1;
        const request = JSON.parse(String(raw)) as { id: string };
        socket.send(JSON.stringify({
          id: request.id,
          ok: true,
          result: { stateRevision: 1, observationSequence: 0 },
        }));
      });
    });
    const states: string[] = [];
    const subscription = new ControlSubscription(
      () => {},
      undefined,
      async () => localConnectionConfig(address.port),
      (state) => states.push(state),
    );
    subscription.start();
    await waitUntil(() => states.at(-1) === "connected");
    states.length = 0;

    subscription.reconnect();
    expect(states).toEqual(["connecting"]);
    await waitUntil(() => subscriptions === 2 && states.at(-1) === "connected");

    expect(states).not.toContain("offline");
    subscription.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

async function waitUntil(probe: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!probe()) {
    if (Date.now() >= deadline) throw new Error("control subscription did not reconnect");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function localConnectionConfig(port: number) {
  return {
    kind: "local" as const,
    controlUrl: `ws://127.0.0.1:${port}`,
    token: "control-token",
    terminalUrl: "ws://127.0.0.1:1",
    terminalToken: "terminal-token",
  };
}
