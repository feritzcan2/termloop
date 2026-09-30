import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const source = await Bun.file(new URL("./opencode-observation.js", import.meta.url)).text();
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function harness(initialID) {
  const directory = await mkdtemp(join(tmpdir(), "termloop-opencode-observation-"));
  const log = join(directory, "events.jsonl");
  const hook = join(directory, "hook.sh");
  await writeFile(hook, `#!/bin/sh\nentry="$(cat)"\ncase "$entry" in *OpenCodeWorking*) sleep 0.15;; esac\nprintf '%s\\n' "$entry" >> '${log}'\n`);
  await chmod(hook, 0o700);
  const plugin = join(directory, "plugin.mjs");
  await writeFile(plugin, source.replace("__TERMLOOP_HOOK_EXECUTABLE__", JSON.stringify(hook)));
  const { tui } = await import(pathToFileURL(plugin).href);
  const handlers = new Map();
  let current = initialID;
  let disposed;
  const sessions = new Map();
  for (const id of ["ses_A", "ses_B", "ses_C"]) sessions.set(id, { id });
  const statuses = new Map();
  const api = {
    route: { get current() { return current ? { name: "session", params: { sessionID: current } } : { name: "home" }; } },
    client: { session: { async get({ sessionID }) { return { data: sessions.get(sessionID) }; } } },
    state: { session: {
      permission: () => [],
      question: () => [],
      status: (id) => statuses.get(id),
    } },
    event: { on(type, handler) {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    } },
    lifecycle: { onDispose(fn) { disposed = fn; } },
  };
  await tui(api);
  const events = async () => {
    const data = await readFile(log, "utf8").catch(() => "");
    return data.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  };
  const waitFor = async (count) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const result = await events();
      if (result.length >= count) return result;
      await Bun.sleep(20);
    }
    throw new Error(`Only ${(await events()).length} of ${count} observations arrived`);
  };
  cleanups.push(async () => { disposed?.(); await rm(directory, { recursive: true, force: true }); });
  return {
    events, waitFor,
    route(id) { current = id; },
    publish(type, properties) { handlers.get(type)?.({ type, properties }); },
    setStatus(id, type) { statuses.set(id, { type }); },
  };
}

test("an idle resumed session sends an exact readiness observation without input", async () => {
  const app = await harness("ses_A");
  expect(await app.waitFor(1)).toEqual([{ hook_event_name: "OpenCodeSessionStart", session_id: "ses_A" }]);
});

test("picker, new session and in-TUI fork follow only the selected root session", async () => {
  const app = await harness("ses_A");
  await app.waitFor(1);
  app.publish("session.status", { sessionID: "ses_C", status: { type: "busy" } });
  app.route("ses_B");
  await app.waitFor(2);
  app.publish("session.status", { sessionID: "ses_A", status: { type: "busy" } });
  app.route("ses_C");
  const result = await app.waitFor(3);
  expect(result).toEqual(["ses_A", "ses_B", "ses_C"].map((session_id) => ({
    hook_event_name: "OpenCodeSessionStart", session_id,
  })));
});

test("delivery stays ordered and questions hold attention until answered", async () => {
  const app = await harness("ses_A");
  await app.waitFor(1);
  app.publish("session.status", { sessionID: "ses_A", status: { type: "busy" } });
  app.publish("session.status", { sessionID: "ses_A", status: { type: "idle" } });
  let result = await app.waitFor(3);
  expect(result.map((entry) => entry.hook_event_name)).toEqual([
    "OpenCodeSessionStart", "OpenCodeWorking", "OpenCodeIdle",
  ]);
  app.setStatus("ses_A", "busy");
  app.publish("question.asked", { sessionID: "ses_A", id: "req_1" });
  app.publish("session.status", { sessionID: "ses_A", status: { type: "busy" } });
  result = await app.waitFor(4);
  expect(result.at(-1).hook_event_name).toBe("OpenCodePermission");
  app.publish("question.replied", { sessionID: "ses_A", requestID: "req_1" });
  result = await app.waitFor(5);
  expect(result.at(-1).hook_event_name).toBe("OpenCodeWorking");
});

test("question rejection and permission reply clear only their own requests", async () => {
  const app = await harness("ses_A");
  await app.waitFor(1);
  app.setStatus("ses_A", "busy");
  app.publish("question.asked", { sessionID: "ses_A", id: "question_1" });
  app.publish("permission.asked", { sessionID: "ses_A", id: "permission_1" });
  await app.waitFor(3);
  app.publish("question.rejected", { sessionID: "ses_A", requestID: "question_1" });
  await Bun.sleep(40);
  expect((await app.events()).length).toBe(3);
  app.publish("permission.replied", { sessionID: "ses_A", requestID: "permission_1" });
  const result = await app.waitFor(4);
  expect(result.at(-1).hook_event_name).toBe("OpenCodeWorking");
});
