import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const [provider, evidenceDir, ...args] = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(provider === "claude" ? "2.1.228 (Claude Code)" : "codex-cli 0.147.0");
  process.exit(0);
}
if (args[0] === "app-server" && args.includes("--help")) {
  console.log("Usage: codex app-server\n  --listen <ADDR>");
  process.exit(0);
}
if (args[0] === "resume" && args.includes("--help")) {
  console.log("Usage: codex resume [OPTIONS] [SESSION_ID]\n  --remote <ADDR>");
  process.exit(0);
}
if (args.includes("--help")) {
  console.log(provider === "claude"
    ? "Usage: claude\n  --settings <FILE>\n  --session-id <ID>\n  --resume <ID>\n  --mcp-config <FILE>"
    : "Usage: codex\n  -c, --config <KEY=VALUE>\n  --remote <ADDR>");
  process.exit(0);
}

const token = process.env.TERMLOOP_MCP_TOKEN;
if (!token) throw new Error("TermLoop MCP bearer was not delivered");
const isResume = args.includes("--resume");
const subprocessBearerVisible = spawnSync(
  process.execPath,
  ["-e", "process.exit(process.env.TERMLOOP_MCP_TOKEN ? 0 : 1)"],
  { stdio: "ignore" },
).status === 0;
let endpoint;
let evidence;
if (provider === "claude") {
  const index = args.indexOf("--mcp-config");
  const config = JSON.parse(await readFile(args[index + 1], "utf8"));
  endpoint = config.mcpServers.termloop_next.url;
  if (config.mcpServers.termloop_next.headers.Authorization !== "Bearer ${TERMLOOP_MCP_TOKEN}") {
    throw new Error("Claude MCP config must remain secret-free");
  }
} else {
  const override = args.find((arg) => arg.startsWith("mcp_servers.termloop_next.url="));
  endpoint = JSON.parse(override.slice(override.indexOf("=") + 1));
}

async function reportClaudeObservation(signal) {
  const settingsIndex = args.indexOf("--settings");
  if (settingsIndex < 0) throw new Error("Claude helper has no observation settings");
  const settingsArgument = args[settingsIndex + 1];
  const settings = JSON.parse(settingsArgument.startsWith("{")
    ? settingsArgument
    : await readFile(settingsArgument, "utf8"));
  const command = settings.hooks?.[signal]?.[0]?.hooks?.[0]?.command;
  if (!command) throw new Error(`Claude helper has no ${signal} hook`);
  const observed = spawnSync(command, {
    shell: true,
    input: JSON.stringify({ hook_event_name: signal }),
    env: process.env,
    stdio: ["pipe", "ignore", "pipe"],
  });
  if (observed.status !== 0) throw new Error(`Claude ${signal} hook failed: ${observed.stderr}`);
}

let requestCounter = 0;
async function rpc(method, params = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      ...(method === "initialize" ? {} : { "mcp-protocol-version": provider === "claude" ? "2025-11-25" : "2025-06-18" }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestCounter, method, params }),
  });
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
  if (response.headers.has("mcp-session-id")) throw new Error("MVP MCP transport must remain stateless");
  return await response.json();
}
function structured(response) {
  if (response.error) throw new Error(JSON.stringify(response.error));
  return response.result?.structuredContent;
}

let discoveryFallback = false;
if (provider === "claude") {
  const getResponse = await fetch(endpoint, { headers: { authorization: `Bearer ${token}` } });
  if (getResponse.status !== 405) throw new Error(`unexpected MCP GET status ${getResponse.status}`);
  const discovered = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestCounter, method: "server/discover", params: {} }),
  }).then((response) => response.json());
  discoveryFallback = discovered.error?.code === -32601;
}
await rpc("initialize", {
  protocolVersion: provider === "claude" ? "2025-11-25" : "2025-06-18",
  capabilities: {},
  clientInfo: { name: `termloop-${provider}-acceptance`, version: "1" },
});
const listed = await rpc("tools/list");
const tools = listed.result.tools.map((tool) => tool.name);
const initialPrompt = args.at(-1) ?? "";
const isHelper = tools.includes("reply_to_request");
let preCommitCommandDenied = false;
if (provider === "claude" && isResume) {
  // Reproduce eager provider startup: MCP initialize and discovery happen
  // before the structured readiness signal that commits resume. Transport must
  // succeed, while tool commands remain unavailable until that commit.
  const preCommit = await rpc("tools/call", isHelper ? {
    name: "reply_to_request",
    arguments: {
      requestId: "00000000-0000-4000-8000-000000000000",
      message: "must remain unauthorized before resume commit",
    },
  } : {
    name: "ask_to",
    arguments: {
      target: "claude",
      message: "must remain unauthorized before resume commit",
    },
  });
  preCommitCommandDenied = preCommit.result?.isError === true;
  await reportClaudeObservation("SessionStart");
  await new Promise((resolve) => setTimeout(resolve, 1_200));
}

async function readSubmittedPrompt(label) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let idleTimer;
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label} PTY input`)), 10_000);
    const finish = () => {
      clearTimeout(timer);
      clearTimeout(idleTimer);
      process.stdin.off("data", onData);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk) => {
      chunks.push(chunk);
      const joined = Buffer.concat(chunks);
      if (joined.includes(Buffer.from("\x1b[201~\n")) || joined.includes(Buffer.from("\x1b[201~\r"))) {
        finish();
        return;
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(finish, 100);
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

async function waitForever() {
  process.stdin.resume();
  await new Promise(() => {});
}

if (!isHelper && !isResume) {
  const deniedToken = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${"0".repeat(64)}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "denied", method: "initialize", params: { protocolVersion: "2025-11-25" } }),
  });
  const deniedOrigin = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, origin: "https://example.com", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "origin", method: "initialize", params: { protocolVersion: "2025-11-25" } }),
  });
  const oversized = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "x".repeat(300 * 1024),
  });
  const wrongRevision = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "mcp-protocol-version": "2026-07-28" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "revision", method: "tools/list", params: {} }),
  }).then((response) => response.json());
  const missingRevision = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "missing-revision", method: "tools/list", params: {} }),
  }).then((response) => response.json());
  await new Promise((resolve) => setTimeout(resolve, 250));
  await reportClaudeObservation("UserPromptSubmit");
  const first = structured(await rpc("tools/call", {
    name: "ask_to",
    arguments: { target: "claude", message: "Return the exact acceptance marker MCP-ROUNDTRIP-OK.", idempotencyKey: "acceptance-retry" },
  }));
  const retry = structured(await rpc("tools/call", {
    name: "ask_to",
    arguments: { target: "claude", message: "Return the exact acceptance marker MCP-ROUNDTRIP-OK.", idempotencyKey: "acceptance-retry" },
  }));
  await writeFile(`${evidenceDir}/asker-pre-restart.json`, JSON.stringify({
    tools,
    discoveryFallback,
    tokenInArguments: args.some((argument) => argument.includes(token)),
    subprocessBearerVisible,
    denialChecks: deniedToken.status === 401 && deniedOrigin.status === 403 && oversized.status === 413 && wrongRevision.error?.code === -32600 && missingRevision.result?.tools?.length === 2,
    idempotentRequest: first.requestId === retry.requestId,
    conversationId: first.conversationId,
    status: first.status,
  }));
  await waitForever();
} else if (isHelper && !isResume) {
  const requestId = initialPrompt.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0];
  if (!requestId) throw new Error("helper prompt did not expose the bounded request ID");
  await writeFile(`${evidenceDir}/helper-pre-restart.json`, JSON.stringify({
    requestId,
    tools,
    tokenInArguments: args.some((argument) => argument.includes(token)),
    subprocessBearerVisible,
  }));
  await waitForever();
} else if (isHelper) {
  const recoveryText = await readSubmittedPrompt("Ask-To restart recovery");
  const requestId = recoveryText.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0];
  if (!requestId || !recoveryText.includes("daemon restarted")) {
    throw new Error("helper resume did not receive the exact recovery request");
  }
  const mismatched = await rpc("tools/call", {
    name: "reply_to_request",
    arguments: { requestId: "00000000-0000-4000-8000-000000000000", message: "wrong request" },
  });
  const reply = structured(await rpc("tools/call", {
    name: "reply_to_request",
    arguments: { requestId, message: "MCP-ROUNDTRIP-OK" },
  }));
  const duplicateReply = await rpc("tools/call", {
    name: "reply_to_request",
    arguments: { requestId, message: "MCP-ROUNDTRIP-OK" },
  });
  await reportClaudeObservation("Stop");
  const followUpText = await readSubmittedPrompt("follow-up question");
  const followUpRequestId = followUpText.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0];
  if (!followUpRequestId || followUpRequestId === requestId) {
    throw new Error("follow-up prompt did not expose a fresh request ID");
  }
  const followUpReply = structured(await rpc("tools/call", {
    name: "reply_to_request",
    arguments: { requestId: followUpRequestId, message: "MCP-FOLLOWUP-OK" },
  }));
  await writeFile(`${evidenceDir}/helper.json`, JSON.stringify({
    tools,
    status: reply.status,
    duplicateReplyDeniedAfterDelivery: duplicateReply.result?.isError === true,
    followUpStatus: followUpReply.status,
    followUpPromptVisible: followUpText.includes("Return the exact follow-up marker MCP-FOLLOWUP-OK."),
    requestMismatchDenied: mismatched.result?.isError === true,
    tokenInArguments: args.some((argument) => argument.includes(token)),
    subprocessBearerVisible,
    recoveryPromptVisible: recoveryText.includes(requestId),
    initializedBeforeReadiness: true,
    preCommitCommandDenied,
  }));
  await waitForever();
} else {
  const beforeRestart = JSON.parse(await readFile(`${evidenceDir}/asker-pre-restart.json`, "utf8"));
  await reportClaudeObservation("Stop");
  const firstReplyText = await readSubmittedPrompt("restarted first pushed reply");
  await reportClaudeObservation("UserPromptSubmit");
  const followUp = structured(await rpc("tools/call", {
    name: "ask_to",
    arguments: {
      target: "claude",
      message: "Return the exact follow-up marker MCP-FOLLOWUP-OK.",
      idempotencyKey: "acceptance-follow-up",
      conversationId: beforeRestart.conversationId,
    },
  }));
  await reportClaudeObservation("Stop");
  const followUpReplyText = await readSubmittedPrompt("restarted follow-up pushed reply");
  await writeFile(`${evidenceDir}/asker.json`, JSON.stringify({
    ...beforeRestart,
    tools,
    tokenInArguments: args.some((argument) => argument.includes(token)),
    subprocessBearerVisible,
    initializedBeforeReadiness: true,
    preCommitCommandDenied,
    pushedReplyVisible: firstReplyText.includes("TermLoop Ask-To final reply") && firstReplyText.includes("MCP-ROUNDTRIP-OK"),
    followUpRequestId: followUp.requestId,
    followUpConversationId: followUp.conversationId,
    followUpStatus: followUp.status,
    pushedFollowUpVisible: followUpReplyText.includes("TermLoop Ask-To final reply") && followUpReplyText.includes("MCP-FOLLOWUP-OK"),
  }));
  await waitForever();
}

const deleted = await fetch(endpoint, {
  method: "DELETE",
  headers: { authorization: `Bearer ${token}`, "mcp-protocol-version": provider === "claude" ? "2025-11-25" : "2025-06-18" },
});
if (deleted.status !== 204) throw new Error(`unexpected MCP DELETE status ${deleted.status}`);
await writeFile(`${evidenceDir}/${isHelper ? "helper" : "asker"}.json`, JSON.stringify(evidence));
