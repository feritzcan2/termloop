import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";

describe("persistent mobile access gateway", () => {
  it("preserves the full capped log generation before continuing in place", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "termloop-mobile-log-"));
    const runtimeFile = path.join(directory, "runtime.json");
    const gatewayConfig = path.join(directory, "gateway.json");
    const logFile = path.join(directory, "gateway.log");
    const evidence = `${"x".repeat((4 * 1024 * 1024) + 1)}incident-at-cap\n`;
    writeFileSync(runtimeFile, runtime(49999, "r", "t"));
    writeFileSync(logFile, evidence);
    const gatewayPort = await freePort();
    writeFileSync(gatewayConfig, JSON.stringify({
      version: 1,
      runtimeFile,
      port: gatewayPort,
      controlToken: "c".repeat(64),
      terminalToken: "m".repeat(64),
      logFile,
    }));
    const gateway = spawn(process.execPath, [path.resolve("scripts/mobile-access-gateway.mjs"), gatewayConfig], {
      cwd: path.resolve("."), stdio: "ignore",
    });
    try {
      await waitForHealth(gatewayPort);
      expect(readFileSync(`${logFile}.overflow`, "utf8")).toBe(evidence);
      expect(readFileSync(logFile, "utf8")).toBe("");
      if (process.platform !== "win32") expect(statSync(`${logFile}.overflow`).mode & 0o777).toBe(0o600);
    } finally {
      gateway.kill("SIGTERM");
    }
  });

  it("stages an owner-selected image in the running agent's ignored runtime directory", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "termloop-mobile-image-"));
    const cwd = path.join(directory, "project");
    mkdirSync(cwd);
    const runtimeFile = path.join(directory, "runtime.json");
    const gatewayConfig = path.join(directory, "gateway.json");
    const upstreamServer = http.createServer();
    const upstreamSockets = new WebSocketServer({ server: upstreamServer });
    upstreamSockets.on("connection", (socket) => {
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString());
        const result = request.method === "session.list"
          ? [{
            id: "11111111-2222-4333-8444-555555555555",
            kind: "Agent",
            lifecycle_state: "running",
            process: { cwd },
          }]
          : { product: "TermLoop", version: "0.1.0", protocolVersion: request.protocolVersion };
        socket.send(JSON.stringify({ id: request.id, ok: true, result }));
      });
    });
    const upstreamPort = await listen(upstreamServer);
    writeFileSync(runtimeFile, runtime(upstreamPort, "r", "t"));
    const gatewayPort = await freePort();
    writeFileSync(gatewayConfig, JSON.stringify({
      version: 1,
      runtimeFile,
      port: gatewayPort,
      controlToken: "c".repeat(64),
      terminalToken: "m".repeat(64),
    }));
    const gateway = spawn(process.execPath, [path.resolve("scripts/mobile-access-gateway.mjs"), gatewayConfig], {
      cwd: path.resolve("."), stdio: "ignore",
    });
    try {
      await waitForHealth(gatewayPort);
      const response = await fetch(
        `http://127.0.0.1:${gatewayPort}/session/image?sessionId=11111111-2222-4333-8444-555555555555`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${"c".repeat(64)}`, "content-type": "image/png" },
          body: Buffer.from([137, 80, 78, 71]),
        },
      );
      expect(response.status).toBe(201);
      const result = await response.json();
      expect(result.attachmentPath).toMatch(/^\.termloop-runtime\/mobile-attachments\/[0-9a-f-]+\.png$/);
      const written = path.join(cwd, result.attachmentPath);
      expect(readFileSync(written)).toEqual(Buffer.from([137, 80, 78, 71]));
      if (process.platform !== "win32") expect(statSync(written).mode & 0o777).toBe(0o600);

      const refused = await fetch(`http://127.0.0.1:${gatewayPort}/session/image?sessionId=11111111-2222-4333-8444-555555555555`, {
        method: "POST",
        headers: { authorization: `Bearer ${"x".repeat(64)}`, "content-type": "image/png" },
        body: Buffer.from([1]),
      });
      expect(refused.status).toBe(401);
    } finally {
      gateway.kill("SIGTERM");
      upstreamSockets.close();
      upstreamServer.close();
    }
  });

  it("replaces stable device credentials with freshly rotated daemon credentials", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "termloop-mobile-gateway-"));
    const runtimeFile = path.join(directory, "runtime.json");
    const gatewayConfig = path.join(directory, "gateway.json");
    const upstreamServer = http.createServer();
    const upstreamSockets = new WebSocketServer({ server: upstreamServer });
    const upstreamPort = await listen(upstreamServer);
    const received = [];
    upstreamSockets.on("connection", (socket, request) => {
      socket.on("message", (data, isBinary) => {
        received.push({ path: request.url, data: Buffer.from(data), isBinary });
        if (request.url === "/control") {
          const message = JSON.parse(data.toString());
          socket.send(JSON.stringify({ id: message.id, ok: true, result: {
            product: "TermLoop", version: "0.1.0", protocolVersion: `sha256:${"a".repeat(64)}`,
          } }));
        } else if (received.filter((item) => item.path === "/terminal").length === 1) {
          socket.send(Buffer.from("TLOK"));
        }
      });
    });
    writeFileSync(runtimeFile, runtime(upstreamPort, "r", "t"));
    const gatewayPort = await freePort();
    writeFileSync(gatewayConfig, JSON.stringify({
      version: 1,
      runtimeFile,
      port: gatewayPort,
      controlToken: "c".repeat(64),
      terminalToken: "m".repeat(64),
    }));
    const gateway = spawn(process.execPath, [path.resolve("scripts/mobile-access-gateway.mjs"), gatewayConfig], {
      cwd: path.resolve("."), stdio: "ignore",
    });
    try {
      await waitForHealth(gatewayPort);
      const control = new WebSocket(`ws://127.0.0.1:${gatewayPort}/control`);
      await opened(control);
      control.send(JSON.stringify({ id: "1", token: "c".repeat(64), method: "system.version", params: {} }));
      await message(control);

      const terminal = new WebSocket(`ws://127.0.0.1:${gatewayPort}/terminal`);
      await opened(terminal);
      terminal.send(Buffer.concat([Buffer.from("TL01"), Buffer.from("m".repeat(64))]));
      expect((await message(terminal)).toString()).toBe("TLOK");

      expect(JSON.parse(received[0].data.toString()).token).toBe("r".repeat(64));
      expect(JSON.parse(received[0].data.toString()).protocolVersion).toBe(`sha256:${"a".repeat(64)}`);
      expect(received[1].data.toString()).toBe(`TL01${"t".repeat(64)}`);
      expect(received.some((item) => item.data.includes(Buffer.from("c".repeat(64))))).toBe(false);
      expect(received.some((item) => item.data.includes(Buffer.from("m".repeat(64))))).toBe(false);
    } finally {
      gateway.kill("SIGTERM");
      upstreamSockets.close();
      upstreamServer.close();
    }
  });

  it("keeps mobile API v1 working across daemon contract and token rotation", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "termloop-mobile-api-"));
    const runtimeFile = path.join(directory, "runtime.json");
    const gatewayConfig = path.join(directory, "gateway.json");
    const upstreamServer = http.createServer();
    const upstreamSockets = new WebSocketServer({ server: upstreamServer });
    const received = [];
    upstreamSockets.on("connection", (socket) => {
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString());
        received.push(request);
        const result = request.method === "project.list"
          ? [{ id: "project-1", name: "TermLoop", folder_path: "/tmp/termloop", future: true }]
          : { product: "TermLoop", version: "0.1.0", protocolVersion: request.protocolVersion };
        socket.send(JSON.stringify({ id: request.id, ok: true, result }));
      });
    });
    const upstreamPort = await listen(upstreamServer);
    writeFileSync(runtimeFile, runtime(upstreamPort, "r", "t", "a"));
    const gatewayPort = await freePort();
    writeFileSync(gatewayConfig, JSON.stringify({
      version: 1,
      runtimeFile,
      port: gatewayPort,
      controlToken: "c".repeat(64),
      terminalToken: "m".repeat(64),
    }));
    const gateway = spawn(process.execPath, [path.resolve("scripts/mobile-access-gateway.mjs"), gatewayConfig], {
      cwd: path.resolve("."), stdio: "ignore",
    });
    try {
      await waitForHealth(gatewayPort);
      const first = await mobileCall(gatewayPort, "system.version");
      expect(first.ok).toBe(true);
      expect(first.result.protocolVersion).toBe(`sha256:${"a".repeat(64)}`);

      writeFileSync(runtimeFile, runtime(upstreamPort, "s", "u", "b"));
      const second = await mobileCall(gatewayPort, "project.list");
      expect(second.ok).toBe(true);
      expect(second.result[0]).toMatchObject({ id: "project-1", future: true });
      expect(received.map((request) => request.protocolVersion)).toEqual([
        `sha256:${"a".repeat(64)}`,
        `sha256:${"b".repeat(64)}`,
      ]);
      expect(received.map((request) => request.token)).toEqual([
        "r".repeat(64),
        "s".repeat(64),
      ]);

      const refused = await mobileCall(gatewayPort, "task.close");
      expect(refused).toMatchObject({ ok: false, error: { code: "methodNotFound" } });
      expect(received).toHaveLength(2);

      const legacyIdentity = `sha256:${"c".repeat(64)}`;
      const legacy = await legacyCall(gatewayPort, legacyIdentity);
      expect(legacy.result.protocolVersion).toBe(legacyIdentity);
      expect(received.at(-1).protocolVersion).toBe(`sha256:${"b".repeat(64)}`);
    } finally {
      gateway.kill("SIGTERM");
      upstreamSockets.close();
      upstreamServer.close();
    }
  });

  it("correlates mobile and upstream control lifecycle without logging credentials", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "termloop-mobile-diagnostics-"));
    const runtimeFile = path.join(directory, "runtime.json");
    const gatewayConfig = path.join(directory, "gateway.json");
    const upstreamServer = http.createServer();
    const upstreamSockets = new WebSocketServer({ server: upstreamServer });
    upstreamSockets.on("connection", (socket) => {
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString());
        socket.send(JSON.stringify({
          id: request.id,
          ok: true,
          result: { product: "TermLoop", version: "0.1.0", protocolVersion: request.protocolVersion },
        }));
      });
    });
    const upstreamPort = await listen(upstreamServer);
    writeFileSync(runtimeFile, runtime(upstreamPort, "r", "t"));
    const gatewayPort = await freePort();
    writeFileSync(gatewayConfig, JSON.stringify({
      version: 1,
      runtimeFile,
      port: gatewayPort,
      controlToken: "c".repeat(64),
      terminalToken: "m".repeat(64),
    }));
    const gateway = spawn(process.execPath, [path.resolve("scripts/mobile-access-gateway.mjs"), gatewayConfig], {
      cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    gateway.stdout.on("data", (data) => { output += data.toString("utf8"); });
    gateway.stderr.on("data", (data) => { output += data.toString("utf8"); });
    try {
      await waitForHealth(gatewayPort);
      const response = await mobileCall(gatewayPort, "system.version", {
        mobileRunId: "mobile-correlation-1",
        controlGeneration: 4,
        mobileAppState: "active",
        foregroundRevision: 9,
        backgroundDurationMs: 8_000,
      });
      expect(response.ok).toBe(true);
      await waitFor(() => output.includes('"event":"request_completed"'));

      const records = output.trim().split("\n").map((line) => JSON.parse(line));
      expect(records).toContainEqual(expect.objectContaining({
        area: "control",
        event: "request_completed",
        method: "system.version",
        mobileRunId: "mobile-correlation-1",
        controlGeneration: 4,
        mobileAppState: "active",
        foregroundRevision: 9,
        backgroundDurationMs: 8_000,
      }));
      expect(records).toContainEqual(expect.objectContaining({
        area: "upstreamControl",
        event: "request_completed",
        downstreamRequestId: "mobile-system.version",
        mobileRunId: "mobile-correlation-1",
      }));
      expect(output).not.toContain("c".repeat(64));
      expect(output).not.toContain("r".repeat(64));
    } finally {
      gateway.kill("SIGTERM");
      upstreamSockets.close();
      upstreamServer.close();
    }
  });

  it("registers a bounded APNs device behind the stable owner credential", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "termloop-mobile-push-"));
    const runtimeFile = path.join(directory, "runtime.json");
    const gatewayConfig = path.join(directory, "gateway.json");
    const devicesFile = path.join(directory, "push-devices.json");
    const upstreamServer = http.createServer();
    const upstreamSockets = new WebSocketServer({ server: upstreamServer });
    const activeUpstreams = new Set();
    let upstreamConnectionCount = 0;
    upstreamSockets.on("connection", (socket) => {
      upstreamConnectionCount += 1;
      activeUpstreams.add(socket);
      socket.once("close", () => activeUpstreams.delete(socket));
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString());
        const result = request.method === "session.list" || request.method === "agent.statusList"
          ? []
          : { product: "TermLoop", version: "0.1.0", protocolVersion: `sha256:${"a".repeat(64)}` };
        socket.send(JSON.stringify({ id: request.id, ok: true, result }));
      });
    });
    const upstreamPort = await listen(upstreamServer);
    writeFileSync(runtimeFile, runtime(upstreamPort, "r", "t"));
    const gatewayPort = await freePort();
    writeFileSync(gatewayConfig, JSON.stringify({
      version: 2,
      connectionId: "mac_fixture",
      macName: "Fixture Mac",
      runtimeFile,
      port: gatewayPort,
      controlToken: "c".repeat(64),
      terminalToken: "m".repeat(64),
      pushDevicesFile: devicesFile,
      apnsConfigFile: path.join(directory, "missing-apns.json"),
    }));
    const gateway = spawn(process.execPath, [path.resolve("scripts/mobile-access-gateway.mjs"), gatewayConfig], {
      cwd: path.resolve("."), stdio: "ignore",
    });
    try {
      await waitForHealth(gatewayPort);
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/push/register`, {
        method: "POST",
        headers: { authorization: `Bearer ${"c".repeat(64)}`, "content-type": "application/json" },
        body: JSON.stringify({
          deviceToken: "a".repeat(64),
          environment: "production",
          bundleId: "ai.termloop.next.mobile.dev",
        }),
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(readFileSync(devicesFile, "utf8")).devices[0]).toMatchObject({
        deviceToken: "a".repeat(64), bundleId: "ai.termloop.next.mobile.dev",
      });
      if (process.platform !== "win32") {
        expect(statSync(devicesFile).mode & 0o777).toBe(0o600);
      }
      const refused = await fetch(`http://127.0.0.1:${gatewayPort}/push/register`, {
        method: "POST",
        headers: { authorization: `Bearer ${"x".repeat(64)}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(refused.status).toBe(401);
      await waitFor(() => upstreamConnectionCount >= 1);
      await waitFor(() => activeUpstreams.size === 1);
      expect(upstreamConnectionCount).toBe(1);
    } finally {
      gateway.kill("SIGTERM");
      upstreamSockets.close();
      upstreamServer.close();
    }
  });
});

function runtime(port, read, terminal, protocol = "a") {
  return JSON.stringify({
    protocolVersion: `sha256:${protocol.repeat(64)}`,
    controlUrl: `ws://127.0.0.1:${port}/control`,
    terminalUrl: `ws://127.0.0.1:${port}/terminal`,
    readOnlyToken: read.repeat(64),
    terminalToken: terminal.repeat(64),
  });
}

async function mobileCall(port, method, diagnostics = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/control`);
  await opened(socket);
  socket.send(JSON.stringify({
    id: `mobile-${method}`,
    mobileApiVersion: 1,
    ...diagnostics,
    token: "c".repeat(64),
    method,
    params: {},
  }));
  const response = JSON.parse((await message(socket)).toString("utf8"));
  socket.close();
  return response;
}

async function legacyCall(port, protocolVersion) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/control`);
  await opened(socket);
  socket.send(JSON.stringify({
    id: "legacy-version",
    protocolVersion,
    token: "c".repeat(64),
    method: "system.version",
    params: {},
  }));
  const response = JSON.parse((await message(socket)).toString("utf8"));
  socket.close();
  return response;
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not reached");
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("gateway did not start");
}

function opened(socket) {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function message(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(Buffer.from(data)));
    socket.once("error", reject);
  });
}
