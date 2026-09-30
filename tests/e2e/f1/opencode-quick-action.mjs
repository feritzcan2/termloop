import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { TermLoopControlClient } from "../../../contract/generated/typescript/dist/current.js";

if (process.platform === "win32") {
  console.log("SKIP: OpenCode fixture currently requires a Unix executable");
  process.exit(0);
}

const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-opencode-quick-action-"));
const testHome = path.join(temporary, "home");
const bin = path.join(testHome, ".local/bin");
const runtime = path.join(temporary, "runtime");
const projectPath = path.join(temporary, "project");
const trace = path.join(projectPath, "launch.json");
await Promise.all([bin, runtime, projectPath].map((directory) => mkdir(directory, { recursive: true })));
const executable = path.join(bin, "opencode");
await writeFile(executable, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--help") {
  console.log("  --standalone  Private server\\n  --session <id>  Session\\n  --prompt <text>  Prompt\\n  --auto  Auto approve");
  process.exit(0);
}
if (args[0] === "--version") { console.log("opencode v2.0.20"); process.exit(0); }
if (args.includes("--model") || args.includes("--agent")) process.exit(1);
fs.writeFileSync(${JSON.stringify(trace)}, JSON.stringify({
  args,
  config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}"),
  observation: Boolean(process.env.TERMLOOP_HOOK_TOKEN),
}));
setInterval(() => {}, 1000);
`);
await chmod(executable, 0o755);

const target = path.resolve(process.env.CARGO_TARGET_DIR ?? "target");
const server = spawn(path.join(target, "debug/termloop-server"), [], {
  env: { ...process.env, HOME: testHome, PATH: `${bin}:/usr/bin:/bin`, TERMLOOP_RUNTIME_DIR: runtime, TERMLOOP_STATE_DIR: path.join(temporary, "state") },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
server.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
let client;
try {
  const record = await waitForJson(path.join(runtime, "runtime.json"));
  assert.equal(record.pid, server.pid);
  client = new TermLoopControlClient(record.controlUrl, record.token, (url) => new WebSocket(url));
  const capabilities = await client.call("agent.capabilityList");
  const opencode = capabilities.find((entry) => entry.agent_id === "opencode");
  assert.equal(opencode.quick_action_supported, true);
  assert.equal(opencode.resume_supported, false);
  const project = await client.call("project.create", { name: "OpenCode preview", folderPath: projectPath });
  let previewCount = 0;
  for (const permission of ["default", "plan", "bypassPermissions"]) {
    const params = {
      projectId: project.id, cwd: projectPath, agentId: "opencode",
      model: "opencode-go/minimax-m3", permission, reasoning: "default",
      templateRef: "builtin.quick-action.free-prompt", bindings: { prompt: "dsa" }, attachments: [],
    };
    // The generated client validates the complete actual daemon response, just
    // as the desktop does before opening its launch inspector.
    const preview = await client.call("quickAction.preview", params);
    assert.equal(preview.delivery, "providerPromptArgument");
    assert.equal(preview.manifest.target.model, params.model);
    const config = preview.manifest.environment.find((entry) => entry.key === "OPENCODE_CONFIG_CONTENT");
    assert.equal(config.visibility, "redacted");
    assert.equal(config.source, "invocation");
    previewCount += 1;
    if (permission !== "bypassPermissions") continue;
    const session = await client.call("quickAction.launch", { ...params, launchTicket: preview.launch_ticket });
    const delivered = await waitForJson(trace);
    assert.deepEqual(delivered.config, { model: params.model });
    assert.equal(delivered.observation, false);
    assert.ok(delivered.args.includes("--standalone"));
    assert.ok(delivered.args.includes("--auto"));
    assert.equal(delivered.args.filter((argument) => argument === "--prompt=dsa").length, 1);
    await client.call("session.terminate", { sessionId: session.id });
  }
  console.log(`OPENCODE_QUICK_ACTION_OK: ${previewCount} validated previews; launch delivered once without observation`);
} finally {
  client?.close();
  if (server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, "exit");
    server.kill("SIGTERM");
    const force = setTimeout(() => server.kill("SIGKILL"), 10_000);
    await stopped;
    clearTimeout(force);
  }
  await rm(temporary, { recursive: true, force: true });
}

async function waitForJson(file) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(file, "utf8")); } catch { /* wait for atomic publication */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Fixture publication timed out: ${path.basename(file)}\n${stderr}`);
}
