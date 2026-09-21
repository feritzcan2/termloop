import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import ssh2, { type AgentAuthMethod } from "ssh2";
import { authenticateSetup } from "../src/platform/ssh-setup-connection.js";

const captured = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("ssh2", async (original) => {
  const module = await original<typeof import("ssh2") & { default: typeof import("ssh2") }>();
  const { EventEmitter } = await import("node:events");
  class FixtureClient extends EventEmitter {
    connect(options: { authHandler: unknown[] }) {
      captured.connect({ ...options, authHandler: [...options.authHandler] });
      queueMicrotask(() => this.emit("ready"));
    }
    end() { this.emit("close"); }
  }
  return { ...module, default: { ...module.default, Client: FixtureClient } };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  captured.connect.mockClear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each(["missing", "unreadable", "public-path"])("offers the selected agent key with a %s private key", async (kind) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "termloop-agent-selection-"));
  roots.push(root);
  const file = path.join(root, "key");
  if (kind === "unreadable") await writeFile(file, Buffer.alloc(65537));
  const selected = ssh2.utils.generateKeyPairSync("ed25519").public;
  const unrelated = ssh2.utils.generateKeyPairSync("ed25519").public;
  await writeFile(`${file}.pub`, selected);
  const agent = ssh2.createAgent("/unused-fixture-agent");
  agent.getIdentities = (callback) => callback(null, [unrelated, selected]);
  vi.spyOn(ssh2, "createAgent").mockReturnValue(agent);
  const client = await authenticateSetup({
    host: "fixture.invalid", user: "fixture", port: 22, name: "Fixture",
    identityFiles: [kind === "public-path" ? `${file}.pub` : file], identitiesOnly: true, agent: "/unused-fixture-agent",
  }, { key: Buffer.alloc(0), fingerprint: "fixture" }, {}, new AbortController().signal);
  client.end();
  const attempts = captured.connect.mock.calls[0]![0].authHandler as AgentAuthMethod[];
  const attempt = attempts.find((item) => item.type === "agent")!;
  const filtered = attempt.agent as ssh2.BaseAgent;
  const keys = await new Promise((resolve, reject) => filtered.getIdentities((error, keys) => error ? reject(error) : resolve(keys)));
  expect(keys).toEqual([selected]);
});
