import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const [evidenceDirectory, ...args] = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("--session-id <uuid> --resume <uuid> --fork-session --settings <json> --mcp-config <file>");
  process.exit(0);
}
if (args.includes("--version")) { console.log("2.1.fake"); process.exit(0); }

const settingsArgument = args[args.indexOf("--settings") + 1];
const settings = JSON.parse(settingsArgument.startsWith("{") ? settingsArgument : await readFile(settingsArgument, "utf8"));
const isFork = args.includes("--fork-session");
const nativeId = isFork ? crypto.randomUUID() : args[args.indexOf("--session-id") + 1];
const sessionId = process.env.TERMLOOP_SESSION_ID;
const config = JSON.parse(await readFile(args[args.indexOf("--mcp-config") + 1], "utf8"));
const endpoint = config.mcpServers.termloop_next.url;
let requestId = 0;

function hook(event) {
  const command = settings.hooks?.[event]?.[0]?.hooks?.[0]?.command;
  const result = spawnSync(command, { shell: true, env: process.env,
    input: JSON.stringify({ hook_event_name: event, session_id: nativeId }), stdio: ["pipe", "ignore", "ignore"] });
  return result.status === 0;
}
async function rpc(method, params = {}) {
  const response = await fetch(endpoint, { method: "POST", headers: {
    authorization: `Bearer ${process.env.TERMLOOP_MCP_TOKEN}`, "content-type": "application/json",
    accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25",
  }, body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }) });
  assert.equal(response.status, 200);
  return response.json();
}
async function call(name, arguments_ = {}) {
  const result = await rpc("tools/call", { name, arguments: arguments_ });
  assert.equal(result.error, undefined);
  assert.notEqual(result.result.isError, true);
  return result.result.structuredContent;
}

process.stdin.on("data", (bytes) => {
  const text = bytes.toString();
  if (text.includes("\x1b[6n")) process.stdout.write("\x1b[1;1R");
  if (text.includes("\r")) { hook("UserPromptSubmit"); hook("Stop"); }
});
process.stdin.resume();
setInterval(() => {}, 1_000);

try {
  let started = false;
  for (let attempt = 0; attempt < 30 && !started; attempt++) {
    started = hook("SessionStart");
    if (!started) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(started);
  await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "playbook-fixture", version: "1" } });
  const tools = (await rpc("tools/list")).result.tools.map((tool) => tool.name);
  if (tools.includes("playbook_evaluation_read")) {
    assert.ok(isFork);
    const selected = JSON.parse(await readFile(path.join(evidenceDirectory, "evaluator-settings.json"), "utf8"));
    assert.equal(args[args.indexOf("--model") + 1], selected.claudeModel ?? "sonnet");
    if (selected.permission === "bypassPermissions") assert.ok(args.includes("--dangerously-skip-permissions"));
    else assert.equal(args[args.indexOf("--permission-mode") + 1], selected.permission);
    assert.deepEqual(tools, ["playbook_evaluation_read", "playbook_evaluation_complete"]);
    assert.ok(args.at(-1).includes("builtin.agent.playbook-evaluator"));
    const read = JSON.parse((await call("playbook_evaluation_read")).content);
    assert.equal(read.assignment.step.finishWith, "playbook_evaluation_complete");
    const denied = await rpc("tools/call", { name: "send_to_agent", arguments: { sessionId: read.sourceSessionId, message: "Must be denied" } });
    assert.ok(denied.error || denied.result?.isError);
    await writeFile(path.join(evidenceDirectory, "evaluation.json"), JSON.stringify({ sessionId, sourceSessionId: read.sourceSessionId, taskId: read.task.id, scopedTools: true }));
    let inspected = false;
    for (let attempt = 0; attempt < 200 && !inspected; attempt++) {
      inspected = await readFile(path.join(evidenceDirectory, "inspection-complete"), "utf8").then(() => true, () => false);
      if (!inspected) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(inspected, "The UI routing projection was not inspected before completion");
    const report = JSON.parse(await readFile(path.join(evidenceDirectory, "report.json"), "utf8"));
    for (const evidence of ["a".repeat(1239), "ş".repeat(301)]) {
      const rejected = await rpc("tools/call", { name: "playbook_evaluation_complete", arguments: { checkId: read.assignment.checkId, status: report.status, evidence } });
      assert.equal(rejected.result.isError, true);
      assert.equal(rejected.result.structuredContent.code, "invalidArguments");
      assert.match(rejected.result.structuredContent.message, /600 UTF-8 bytes/);
      assert.ok(rejected.result.structuredContent.message.includes(`Received ${Buffer.byteLength(evidence)} bytes`));
      assert.match(rejected.result.structuredContent.message, /Nothing was recorded.*retry the same check/);
      const stillCurrent = JSON.parse((await call("playbook_evaluation_read")).content);
      assert.equal(stillCurrent.assignment.checkId, read.assignment.checkId);
    }
    await call("playbook_evaluation_complete", { checkId: read.assignment.checkId, ...report });
  } else if (tools.includes("steward_next_assignment")) {
    const assignment = JSON.parse((await call("steward_next_assignment")).content);
    await writeFile(path.join(evidenceDirectory, "steward.json"), JSON.stringify({ status: assignment.status }));
  } else {
    await writeFile(path.join(evidenceDirectory, "source.json"), JSON.stringify({ sessionId }));
  }
} catch (error) {
  await writeFile(path.join(evidenceDirectory, "error.json"), JSON.stringify({ message: error.message, sessionId }));
  process.exit(1);
}
