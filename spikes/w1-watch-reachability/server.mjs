// W1 watch-reachability spike server. Zero dependencies; run with:
//   node spikes/w1-watch-reachability/server.mjs [--port 47613]
import { createServer } from "node:http";
import { networkInterfaces, homedir } from "node:os";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { connect as http2Connect } from "node:http2";
import { createPrivateKey, sign as cryptoSign, randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const evidenceDir = join(here, "evidence");
mkdirSync(evidenceDir, { recursive: true });

const portArgIndex = process.argv.indexOf("--port");
const port = portArgIndex === -1 ? 47613 : Number(process.argv[portArgIndex + 1]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error("Invalid --port value");
  process.exit(1);
}

const MAX_REPORT_BYTES = 64 * 1024;

function appendJsonl(file, record) {
  appendFileSync(join(evidenceDir, file), `${JSON.stringify(record)}\n`);
}

const MAX_PATCH_CHARS = 48 * 1024;

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function changedFiles(worktreePath, base) {
  const files = new Map();
  const numstat = base ? git(worktreePath, ["diff", "--numstat", base]) : "";
  for (const line of numstat.split("\n")) {
    const [additions, deletions, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (!path) continue;
    files.set(path, {
      path,
      status: "M",
      additions: additions === "-" ? null : Number(additions),
      deletions: deletions === "-" ? null : Number(deletions),
    });
  }
  const nameStatus = base ? git(worktreePath, ["diff", "--name-status", base]) : "";
  for (const line of nameStatus.split("\n")) {
    const [status, ...rest] = line.split("\t");
    const path = rest[rest.length - 1];
    if (!path || !files.has(path)) continue;
    files.get(path).status = status[0];
  }
  const untracked = git(worktreePath, ["ls-files", "--others", "--exclude-standard"]);
  for (const path of untracked.split("\n")) {
    if (!path) continue;
    files.set(path, { path, status: "?", additions: null, deletions: null });
  }
  return [...files.values()];
}

function listWorktrees() {
  const raw = git(here, ["worktree", "list", "--porcelain"]);
  const entries = [];
  let current = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) current = { path: line.slice("worktree ".length) };
    else if (line.startsWith("branch ") && current)
      current.branch = line.slice("branch ".length).replace("refs/heads/", "");
    else if (line === "" && current) {
      entries.push(current);
      current = null;
    }
  }
  return entries.map((entry, id) => {
    let base = null;
    try {
      base = git(entry.path, ["merge-base", "main", "HEAD"]).trim();
    } catch {
      base = null;
    }
    let files = [];
    try {
      files = changedFiles(entry.path, base);
    } catch {
      files = [];
    }
    const name = entry.path.split("/").pop().replace(/_worktree$/, "");
    return { id, name, branch: entry.branch ?? "(detached)", path: entry.path, base, files };
  });
}

// listWorktrees walks git for every worktree (worktree list + merge-base +
// numstat each); at ~10 worktrees that dominates request latency, so cache it.
let worktreeCacheAt = 0;
let worktreeCacheData = null;
function listWorktreesCached() {
  const now = Date.now();
  if (!worktreeCacheData || now - worktreeCacheAt > 5000) {
    worktreeCacheData = listWorktrees();
    worktreeCacheAt = now;
  }
  return worktreeCacheData;
}

function patchFor(worktree, filePath) {
  const known = worktree.files.find((file) => file.path === filePath);
  if (!known) return null;
  let patch;
  if (known.status === "?") {
    try {
      patch = git(worktree.path, ["diff", "--no-index", "--", "/dev/null", filePath]);
    } catch (error) {
      // git diff --no-index exits 1 when the files differ; stdout still has the patch.
      patch = error.stdout ?? "";
    }
  } else {
    patch = git(worktree.path, ["diff", worktree.base, "--", filePath]);
  }
  if (patch.length > MAX_PATCH_CHARS) {
    patch = `${patch.slice(0, MAX_PATCH_CHARS)}\n… (truncated)`;
  }
  return patch;
}

// --- Push notifications (APNs) -------------------------------------------
// Config lives in apns.json next to this file:
//   { "keyId": "…", "teamId": "S9QXLS2NJ2", "keyPath": "/path/AuthKey_XXX.p8" }
// Without it (or before the watch registers a token) pushes are skipped.
const apnsConfigPath = join(here, "apns.json");
const deviceTokenPath = join(evidenceDir, "device-token.json");

function loadApnsConfig() {
  if (!existsSync(apnsConfigPath)) return null;
  try {
    const config = JSON.parse(readFileSync(apnsConfigPath, "utf8"));
    if (!config.keyId || !config.teamId || !config.keyPath) return null;
    return {
      topic: "dev.termloop.spikes.watchreach",
      host: "api.sandbox.push.apple.com",
      ...config,
    };
  } catch {
    return null;
  }
}

function apnsJwt(config) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "ES256", kid: config.keyId })}.${encode({
    iss: config.teamId,
    iat: Math.floor(Date.now() / 1000),
  })}`;
  const key = createPrivateKey(readFileSync(config.keyPath, "utf8"));
  const signature = cryptoSign("sha256", Buffer.from(unsigned), {
    key,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${unsigned}.${signature}`;
}

function sendPush(title, body, extra = {}) {
  const config = loadApnsConfig();
  if (!config) {
    console.log("push skipped: apns.json missing or incomplete");
    return Promise.resolve({ skipped: "no apns.json" });
  }
  if (!existsSync(deviceTokenPath)) {
    console.log("push skipped: no device token registered yet");
    return Promise.resolve({ skipped: "no device token" });
  }
  const { token } = JSON.parse(readFileSync(deviceTokenPath, "utf8"));
  return new Promise((resolve) => {
    const client = http2Connect(`https://${config.host}`);
    client.on("error", (error) => resolve({ error: String(error) }));
    const request = client.request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      authorization: `bearer ${apnsJwt(config)}`,
      "apns-topic": config.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
    });
    let status = 0;
    let responseBody = "";
    request.on("response", (headers) => {
      status = headers[":status"];
    });
    request.on("data", (chunk) => {
      responseBody += chunk;
    });
    request.on("end", () => {
      client.close();
      console.log(`push sent: status=${status} ${responseBody}`);
      resolve({ status, body: responseBody });
    });
    request.on("error", (error) => {
      client.close();
      resolve({ error: String(error) });
    });
    request.end(JSON.stringify({ aps: { alert: { title, body }, sound: "default" }, ...extra }));
  });
}

// --- TermLoop daemon watcher: push when an agent finishes ------------------
const runtimeDiscoveryPath = join(
  homedir(),
  "Library/Application Support/termloop-next/runtime.json",
);
const FINISHED_STATES = new Set(["awaitingInput", "idle", "exited"]);

function worktreeNameForCwd(cwd) {
  if (!cwd) return null;
  try {
    for (const worktree of listWorktreesCached()) {
      if (cwd === worktree.path || cwd.startsWith(`${worktree.path}/`)) return worktree.name;
    }
  } catch {
    return null;
  }
  return null;
}

async function watchAgents() {
  const lastStatus = new Map();
  for (;;) {
    let ws;
    try {
      const runtime = JSON.parse(readFileSync(runtimeDiscoveryPath, "utf8"));
      ws = new WebSocket(runtime.controlUrl);
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error("control socket connect failed"));
      });
      const call = (method) =>
        new Promise((resolve, reject) => {
          const id = randomUUID();
          const timer = setTimeout(() => {
            ws.removeEventListener("message", onMessage);
            reject(new Error("control call timeout"));
          }, 10_000);
          const onMessage = (event) => {
            const message = JSON.parse(event.data);
            if (message.id !== id) return;
            clearTimeout(timer);
            ws.removeEventListener("message", onMessage);
            if (message.ok) resolve(message.result);
            else reject(new Error(message.error?.message ?? "control error"));
          };
          ws.addEventListener("message", onMessage);
          ws.send(
            JSON.stringify({
              id,
              protocolVersion: runtime.protocolVersion,
              token: runtime.readOnlyToken,
              method,
              params: {},
            }),
          );
        });
      console.log("agent watcher: connected to TermLoop daemon");
      let first = lastStatus.size === 0;
      for (;;) {
        const statuses = await call("agent.statusList");
        const sessions = await call("session.list");
        const sessionById = new Map(sessions.map((session) => [session.id, session]));
        for (const entry of statuses) {
          const previous = lastStatus.get(entry.sessionId);
          lastStatus.set(entry.sessionId, entry.status);
          if (first || previous === entry.status) continue;
          if (previous === "working" && FINISHED_STATES.has(entry.status)) {
            const session = sessionById.get(entry.sessionId);
            const worktree = worktreeNameForCwd(session?.process?.cwd);
            const label =
              session?.name ?? session?.process?.agent_id ?? entry.sessionId.slice(0, 8);
            console.log(`agent finished: ${label} → ${entry.status} (worktree=${worktree})`);
            await sendPush(
              "Agent finished",
              worktree ? `${label} — ${worktree}` : String(label),
              worktree ? { wt: worktree } : {},
            );
          }
        }
        first = false;
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    } catch (error) {
      try {
        ws?.close();
      } catch {}
      console.log(`agent watcher: ${String(error?.message ?? error)}; retrying in 15s`);
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
  }
}
watchAgents();

const server = createServer((req, res) => {
  const receivedAtEpochMs = Date.now();
  const remoteAddress = req.socket.remoteAddress ?? "unknown";
  appendJsonl("server-log.jsonl", {
    receivedAtEpochMs,
    method: req.method,
    url: req.url,
    remoteAddress,
  });

  if (req.method === "GET" && req.url?.startsWith("/ping")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, serverTimeEpochMs: receivedAtEpochMs, remoteAddress }));
    return;
  }

  if (req.method === "POST" && req.url === "/report") {
    let body = "";
    let overflow = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_REPORT_BYTES) {
        overflow = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      if (overflow) return;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid JSON" }));
        return;
      }
      appendJsonl("watch-reports.jsonl", {
        receivedAtEpochMs,
        remoteAddress,
        report: parsed,
      });
      console.log(
        `report: scenario=${parsed?.scenario} ok=${parsed?.successCount}/${parsed?.attemptCount} from ${remoteAddress}`,
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (req.method === "POST" && req.url === "/device-token") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) req.destroy();
    });
    req.on("end", () => {
      try {
        const { token } = JSON.parse(body);
        if (typeof token !== "string" || !/^[0-9a-f]{16,200}$/.test(token)) throw new Error("bad token");
        writeFileSync(deviceTokenPath, JSON.stringify({ token, updatedAtEpochMs: receivedAtEpochMs }));
        console.log(`device token registered (${token.slice(0, 8)}…)`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid token payload" }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url?.startsWith("/notify-test")) {
    const url = new URL(req.url, "http://localhost");
    const requested = url.searchParams.get("wt");
    const candidates = listWorktreesCached().filter((worktree) => worktree.files.length > 0);
    const target = requested ?? candidates[0]?.name ?? null;
    sendPush("Agent finished", target ? `test push — ${target}` : "test push", target ? { wt: target } : {}).then(
      (outcome) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, target, outcome }));
      },
    );
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/worktrees")) {
    try {
      const worktrees = listWorktreesCached().map(({ base, path, ...rest }) => rest);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ worktrees }));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(error) }));
    }
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/patches")) {
    try {
      const url = new URL(req.url, "http://localhost");
      const id = Number(url.searchParams.get("wt"));
      const worktree = listWorktreesCached().find((entry) => entry.id === id);
      if (!worktree) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unknown worktree" }));
        return;
      }
      const MAX_BUNDLE_CHARS = 1_500_000;
      let total = 0;
      const files = worktree.files.map((file) => {
        if (total > MAX_BUNDLE_CHARS) {
          return { path: file.path, patch: "… (bundle size cap reached — reopen to load)" };
        }
        const patch = patchFor(worktree, file.path) ?? "";
        total += patch.length;
        return { path: file.path, patch };
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ files }));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(error) }));
    }
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/patch")) {
    try {
      const url = new URL(req.url, "http://localhost");
      const id = Number(url.searchParams.get("wt"));
      const filePath = url.searchParams.get("file") ?? "";
      const worktree = listWorktreesCached().find((entry) => entry.id === id);
      const patch = worktree ? patchFor(worktree, filePath) : null;
      if (patch === null) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unknown worktree or file" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ patch }));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(error) }));
    }
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "not found" }));
});

server.listen(port, "0.0.0.0", () => {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === "IPv4" && !iface.internal)
    .map((iface) => iface.address);
  console.log(`W1 spike server listening on 0.0.0.0:${port}`);
  console.log("Enter one of these host addresses on the watch:");
  for (const address of addresses) console.log(`  ${address}`);
  console.log(`Evidence directory: ${evidenceDir}`);
});
