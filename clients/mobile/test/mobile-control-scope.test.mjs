import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";

/// What a paired phone may reach, and on which credential.
///
/// The gateway's allowlist is the whole boundary: a method outside both sets is
/// refused before any upstream connection exists, and the credential a method
/// travels on is fixed by which set names it — never by what the client asked
/// for. These tests pin both, because widening either one silently is exactly
/// the failure that turns a read-only pager into an unaudited writer.
describe("mobile control scope", () => {
  it("routes pipeline, changes, both Agent launch scopes, and Steward methods on the full credential and reads on the read-only one", async () => {
    const seen = [];
    const harness = await gateway((request) => {
      seen.push({ method: request.method, token: request.token });
      if (request.method === "playbook.get") return { playbook: null, stateRevision: 7 };
      if (request.method === "agent.capabilityList") {
        return [{
          agent_id: "claude", label: "Claude", available: true, version: "5.0.1",
          integration_level: "full", degraded_reason: null, models: ["default"],
          permissions: ["default"], reasoning: ["default"], observation_supported: true,
          quick_action_supported: true, tracked_helpers_supported: true,
          resume_supported: true, native_fork_supported: true,
        }];
      }
      if (request.method === "companion.transcriptAppend") {
        return {
          message: {
            id: "companion-1",
            projectId: "project-1",
            sequence: 1,
            author: "user",
            kind: "reply",
            content: "hello",
            createdAtEpochMs: 1,
          },
          usage: {},
          stateRevision: 8,
        };
      }
      return {};
    });
    try {
      const playbook = await call(harness.port, "playbook.get", { projectId: "project-1" });
      expect(playbook.ok).toBe(true);
      expect(playbook.result).toEqual({ playbook: null, stateRevision: 7 });

      const capabilities = await call(harness.port, "agent.capabilityList");
      expect(capabilities.ok).toBe(true);

      const changes = await call(harness.port, "task.worktreeChangeList", { taskId: "task-1" });
      expect(changes.ok).toBe(true);
      const diff = await call(harness.port, "task.worktreeDiff", {
        taskId: "task-1", observationId: "observation-1", entryId: "entry-1",
      });
      expect(diff.ok).toBe(true);
      const preImage = await call(harness.port, "task.worktreePreImage", {
        taskId: "task-1", observationId: "observation-1", entryId: "entry-1",
      });
      expect(preImage.ok).toBe(true);

      const append = await call(harness.port, "companion.transcriptAppend", {
        projectId: "project-1",
        content: "hello",
      });
      expect(append.ok).toBe(true);

      const projectPreview = await call(harness.port, "session.previewAgent", {
        projectId: "project-1", cwd: "/repo", agentId: "codex",
      });
      expect(projectPreview.ok).toBe(true);
      const projectLaunch = await call(harness.port, "session.launchAgent", {
        projectId: "project-1", cwd: "/repo", agentId: "codex", launchTicket: "a".repeat(64),
      });
      expect(projectLaunch.ok).toBe(true);
      const rename = await call(harness.port, "session.rename", {
        sessionId: "session-1", name: "Investigate mobile launch",
      });
      expect(rename.ok).toBe(true);

      // The daemon's own scopes decide what each token may do, so the gateway's
      // job is only to send the right one. A pipeline read is not in the
      // daemon's read-only scope and must not be attempted on that token.
      expect(seen.find((entry) => entry.method === "playbook.get").token).toBe("f".repeat(64));
      expect(seen.find((entry) => entry.method === "task.worktreeChangeList").token).toBe("f".repeat(64));
      expect(seen.find((entry) => entry.method === "task.worktreeDiff").token).toBe("f".repeat(64));
      expect(seen.find((entry) => entry.method === "task.worktreePreImage").token).toBe("f".repeat(64));
      expect(seen.find((entry) => entry.method === "companion.transcriptAppend").token).toBe("f".repeat(64));
      expect(seen.find((entry) => entry.method === "session.previewAgent").token).toBe("f".repeat(64));
      expect(seen.find((entry) => entry.method === "session.launchAgent").token).toBe("f".repeat(64));
      expect(seen.find((entry) => entry.method === "session.rename").token).toBe("f".repeat(64));
      expect(seen.find((entry) => entry.method === "agent.capabilityList").token).toBe("r".repeat(64));
    } finally {
      await harness.close();
    }
  });

  it("refuses a method outside both allowlists without reaching the daemon", async () => {
    const seen = [];
    const harness = await gateway((request) => {
      seen.push(request.method);
      return {};
    });
    try {
      for (const method of ["playbook.update", "task.delete", "session.terminate", "companion.transcriptClear"]) {
        const response = await call(harness.port, method, { projectId: "project-1" });
        expect(response.ok).toBe(false);
        expect(response.error.code).toBe("methodNotFound");
      }
      expect(seen).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("refuses the full-credential methods when this Mac published no full credential", async () => {
    const harness = await gateway(() => ({}), { withFullToken: false });
    try {
      const refused = await call(harness.port, "playbook.runtime", { projectId: "project-1" });
      expect(refused.ok).toBe(false);
      expect(refused.error.code).toBe("unauthenticated");
      const changes = await call(harness.port, "task.worktreeChangeList", { taskId: "task-1" });
      expect(changes.ok).toBe(false);
      expect(changes.error.code).toBe("unauthenticated");
      const preImage = await call(harness.port, "task.worktreePreImage", {
        taskId: "task-1", observationId: "observation-1", entryId: "entry-1",
      });
      expect(preImage.ok).toBe(false);
      expect(preImage.error.code).toBe("unauthenticated");

      // Reads keep working, so a credential-free discovery file degrades rather
      // than taking the whole phone offline.
      const allowed = await call(harness.port, "project.list");
      expect(allowed.ok).toBe(true);
    } finally {
      await harness.close();
    }
  });
});

async function gateway(onRequest, { withFullToken = true } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "termloop-mobile-scope-"));
  const runtimeFile = path.join(directory, "runtime.json");
  const gatewayConfig = path.join(directory, "gateway.json");
  const upstreamServer = http.createServer();
  const upstreamSockets = new WebSocketServer({ server: upstreamServer });
  upstreamSockets.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      socket.send(JSON.stringify({ id: request.id, ok: true, result: onRequest(request) }));
    });
  });
  const upstreamPort = await listen(upstreamServer);
  writeFileSync(runtimeFile, JSON.stringify({
    protocolVersion: `sha256:${"a".repeat(64)}`,
    controlUrl: `ws://127.0.0.1:${upstreamPort}/control`,
    terminalUrl: `ws://127.0.0.1:${upstreamPort}/terminal`,
    readOnlyToken: "r".repeat(64),
    terminalToken: "m".repeat(64),
    ...(withFullToken ? { token: "f".repeat(64) } : {}),
  }));
  const port = await freePort();
  writeFileSync(gatewayConfig, JSON.stringify({
    version: 1,
    runtimeFile,
    port,
    controlToken: "c".repeat(64),
    terminalToken: "m".repeat(64),
  }));
  const child = spawn(process.execPath, [path.resolve("scripts/mobile-access-gateway.mjs"), gatewayConfig], {
    cwd: path.resolve("."), stdio: "ignore",
  });
  await waitForHealth(port);
  return {
    port,
    async close() {
      child.kill("SIGTERM");
      upstreamSockets.close();
      await new Promise((resolve) => upstreamServer.close(resolve));
    },
  };
}

async function call(port, method, params = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/control`);
  await opened(socket);
  socket.send(JSON.stringify({
    id: `mobile-${method}`,
    mobileApiVersion: 1,
    token: "c".repeat(64),
    method,
    params,
  }));
  const response = JSON.parse((await message(socket)).toString("utf8"));
  socket.close();
  return response;
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
    socket.once("message", (data) => resolve(Buffer.isBuffer(data) ? data : Buffer.from(data)));
    socket.once("error", reject);
  });
}
