import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import WebSocket from "ws";

import { CONTRACT_IDENTITY } from "../../contract/generated/typescript/dist/current.js";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-multi-source-desktop-"));
const localHost = hostPaths("local");
const remoteHost = hostPaths("remote");
const desktopUserData = path.join(temporary, "desktop-user-data");
const layoutFile = path.join(temporary, "desktop", "layout.v2.json");
const localProjectDirectory = path.join(temporary, "local-project");
const remoteProjectDirectory = path.join(temporary, "remote-project");
const remoteCreatedDirectory = path.join(temporary, "remote-created-project");
const testHomeDirectory = path.join(temporary, "home");
const fakeBinDirectory = path.join(testHomeDirectory, ".local", "bin");
const cargoTargetDirectory = path.resolve(root, process.env.CARGO_TARGET_DIR ?? "target");
const serverBinary = path.join(
  cargoTargetDirectory,
  "debug",
  process.platform === "win32" ? "termloop-server.exe" : "termloop-server",
);

await Promise.all([
  localHost.runtimeDirectory,
  localHost.stateDirectory,
  remoteHost.runtimeDirectory,
  remoteHost.stateDirectory,
  desktopUserData,
  path.dirname(layoutFile),
  localProjectDirectory,
  remoteProjectDirectory,
  remoteCreatedDirectory,
  fakeBinDirectory,
].map((directory) => mkdir(directory, { recursive: true })));
await installFakeClaude();

let localServer;
let remoteServer;
let app;
try {
  localServer = await startServer(localHost);
  remoteServer = await startServer(remoteHost);

  const localProject = await controlCall(localServer.runtime, "project.create", {
    name: "Local Existing",
    folderPath: localProjectDirectory,
  });
  const remoteProject = await controlCall(remoteServer.runtime, "project.create", {
    name: "Remote Existing",
    folderPath: remoteProjectDirectory,
  });
  const remoteAgent = await launchProjectAgent(remoteServer.runtime, {
    projectId: remoteProject.id,
    cwd: remoteProjectDirectory,
    agentId: "claude",
  });
  await waitForRemoteResumeRef(remoteAgent.id);
  await controlCall(localServer.runtime, "session.launchTerminal", {
    projectId: localProject.id,
    cwd: localProjectDirectory,
  });
  await controlCall(remoteServer.runtime, "session.launchTerminal", {
    projectId: remoteProject.id,
    cwd: remoteProjectDirectory,
  });

  const accessPort = await reservePort();
  const access = await controlCall(remoteServer.runtime, "access.enable", { port: accessPort });
  assert.equal(access.listening, true);
  assert.equal(typeof access.access_url, "string");

  app = await electron.launch({
    args: [path.join(root, "clients/desktop")],
    cwd: root,
    env: {
      ...process.env,
      TERMLOOP_RUNTIME_FILE: localHost.runtimeFile,
      TERMLOOP_DESKTOP_USER_DATA_DIR: desktopUserData,
      TERMLOOP_LAYOUT_FILE: layoutFile,
      TERMLOOP_DESKTOP_DIAGNOSTICS: "1",
      TERMLOOP_TERMINAL_RENDERER: "xterm",
    },
  });
  const desktopPid = app.process().pid;
  const page = await app.firstWindow();
  await page.locator("[aria-label='Projects and sessions']").waitFor();
  await page.getByText("Local Existing", { exact: true }).first().waitFor();

  await openServers(page);
  const connectionDialog = page.locator(".server-profiles-dialog");
  const remoteCard = connectionDialog.locator(".conn-card").filter({ hasText: "Remote computer" });
  await connectionDialog.getByText("Add by address instead").click();
  const manualForm = connectionDialog.locator(".conn-manual");
  await manualForm.getByLabel("Name", { exact: true }).fill("Remote computer");
  await manualForm.getByLabel("Server address").fill(access.access_url);
  await manualForm.getByRole("button", { name: "Connect", exact: true }).click();
  await connectionDialog.getByText("Connected to Remote computer.", { exact: true }).waitFor();
  await connectionDialog.getByRole("button", { name: "Close", exact: true }).click();

  await openProjectMenu(page);
  await expectSourceHeadings(page, ["This computer", "Remote computer"]);
  await projectOption(page, "Local Existing").waitFor();
  await projectOption(page, "Remote Existing").waitFor();
  await projectOption(page, "Remote Existing").click();
  await page.locator("#project-title").getByText("Remote Existing", { exact: true }).waitFor();
  await assertTerminalRoundTrip(page, "TERMLOOP_REMOTE_SOURCE_READY");
  await openProjectMenu(page);
  await projectOption(page, "Local Existing").click();
  await page.locator("#project-title").getByText("Local Existing", { exact: true }).waitFor();
  await assertTerminalRoundTrip(page, "TERMLOOP_LOCAL_SOURCE_READY");

  await page.getByRole("button", { name: "Add Project", exact: true }).click();
  const addProjectDialog = page.getByRole("dialog", { name: "Add a Project folder" });
  await addProjectDialog.getByLabel("Computer").selectOption({ label: "Remote computer" });
  await addProjectDialog.getByRole("button", { name: "Type a folder path" }).click();
  const folderPath = addProjectDialog.getByRole("textbox", { name: "Folder path", exact: true });
  await folderPath.fill(remoteCreatedDirectory);
  await folderPath.press("Enter");
  await addProjectDialog.getByLabel("Name", { exact: true }).fill("Created on remote");
  await addProjectDialog.locator(".primary-button").click();
  await waitUntil(
    async () => (await controlCall(remoteServer.runtime, "project.list")).some((project) => project.name === "Created on remote"),
    5_000,
    "remote Project was not created",
  );
  await openProjectMenu(page);
  await projectOption(page, "Created on remote").click();
  await page.locator("#project-title").getByText("Created on remote", { exact: true }).waitFor();

  const remoteProjects = await controlCall(remoteServer.runtime, "project.list");
  const localProjects = await controlCall(localServer.runtime, "project.list");
  assert.equal(remoteProjects.some((project) => project.name === "Created on remote"), true);
  assert.equal(localProjects.some((project) => project.name === "Created on remote"), false);
  const crossSourceDeleteError = await page.evaluate(async () => {
    const profiles = await window.termloop.connectionProfileList();
    const remoteProfile = profiles.find((profile) => profile.name === "Remote computer");
    const projects = await window.termloop.projectList("local");
    if (!remoteProfile || !projects[0]) return "missing E2E source fixture";
    try {
      await window.termloop.projectDelete(remoteProfile.id, projects[0].id);
      return "project.delete unexpectedly succeeded";
    } catch (error) {
      return String(error);
    }
  });
  assert.match(crossSourceDeleteError, /crossConnectionEntityDenied/u);
  assert.equal(
    (await controlCall(localServer.runtime, "project.list")).some((project) => project.id === localProject.id),
    true,
    "cross-source delete guard must leave the local project untouched",
  );

  await openProjectMenu(page);
  await stopServer(remoteServer.child);
  remoteServer = undefined;
  await waitUntil(
    async () => await projectOption(page, "Created on remote").getAttribute("data-connection-state") === "offline",
    8_000,
    "remote source did not become offline",
  );
  assert.equal(await projectOption(page, "Local Existing").getAttribute("data-connection-state"), "connected");
  await projectOption(page, "Local Existing").click();
  await page.locator("#project-title").getByText("Local Existing", { exact: true }).waitFor();
  await waitUntil(
    async () => (await selectedTerminalText(page)).includes("TERMLOOP_LOCAL_SOURCE_READY"),
    5_000,
    "local terminal was affected when the remote source stopped",
  );
  await waitUntil(async () => {
    const before = await projectionRefreshCountFor(page);
    await new Promise((resolve) => setTimeout(resolve, 500));
    return await projectionRefreshCountFor(page) === before;
  }, 5_000, "projection refreshes did not settle after selecting the local project");
  const offlineIsolation = await page.evaluate(async () => {
    const initialRefreshCount = window.termloopDiagnostics?.projectionRefreshCount() ?? 0;
    let globalConnectionAlertAppeared = document.querySelector(".server-connection-alert") !== null;
    const observer = new MutationObserver(() => {
      globalConnectionAlertAppeared ||= document.querySelector(".server-connection-alert") !== null;
    });
    observer.observe(document.body, { childList: true, subtree: true });
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    observer.disconnect();
    return {
      globalConnectionAlertAppeared,
      projectionRefreshDelta: (window.termloopDiagnostics?.projectionRefreshCount() ?? 0) - initialRefreshCount,
    };
  });
  assert.equal(
    offlineIsolation.globalConnectionAlertAppeared,
    false,
    "an offline remote source showed the global connection alert",
  );
  assert.equal(
    offlineIsolation.projectionRefreshDelta,
    0,
    "an offline remote source caused repeated full projection refreshes",
  );
  await openServers(page);
  await remoteCard.getByText(/^Offline/u).waitFor();
  await connectionDialog.getByRole("button", { name: "Close", exact: true }).click();

  remoteServer = await startServer(remoteHost);
  await waitUntil(async () => {
    const status = await controlCall(remoteServer.runtime, "access.status");
    return status.listening;
  }, 8_000, "remote access listener did not restore");
  await openProjectMenu(page);
  await waitUntil(
    async () => await projectOption(page, "Created on remote").getAttribute("data-connection-state") === "connected",
    10_000,
    "remote source did not reconnect",
  );
  await closeProjectMenu(page);
  const resumedRemoteAgent = await waitUntil(async () => {
    const sessions = await controlCall(remoteServer.runtime, "session.list");
    const current = sessions.find((session) => session.id === remoteAgent.id);
    return current?.lifecycle_state === "running" && current.runtime_epoch !== remoteAgent.runtime_epoch
      ? current
      : undefined;
  }, 12_000, "remote Agent did not resume after the server restart");
  assert.equal(resumedRemoteAgent.id, remoteAgent.id);
  await openProjectMenu(page);
  await projectOption(page, "Remote Existing").click();
  await page.locator("#project-title").getByText("Remote Existing", { exact: true }).waitFor();
  await page.locator(sessionSelector(remoteAgent.id)).click();
  let lastResumedTerminalText = "";
  const resumedTerminalText = await waitUntil(async () => {
    const text = await selectedTerminalText(page);
    lastResumedTerminalText = text;
    return text.includes("TERMLOOP_REMOTE_RESUME_SCREEN") ? text : undefined;
  }, 15_000, () => `remote Agent resumed but its replacement terminal never attached; terminal tail: ${JSON.stringify(lastResumedTerminalText.slice(-500))}`);
  assert.equal(
    (resumedTerminalText.match(/\[terminal connection lost/gu) ?? []).length,
    0,
    "transport retries polluted the remote terminal scrollback",
  );

  await openServers(page);
  await remoteCard.getByRole("switch", { name: "Disable Remote computer" }).click();
  await connectionDialog.getByText("Server disabled.", { exact: true }).waitFor();
  await connectionDialog.getByRole("button", { name: "Close", exact: true }).click();
  await openProjectMenu(page);
  await waitUntil(async () => await projectOption(page, "Remote Existing").count() === 0, 5_000, "disabled source stayed visible");
  await projectOption(page, "Local Existing").waitFor();
  await closeProjectMenu(page);

  await openServers(page);
  await remoteCard.getByRole("switch", { name: "Enable Remote computer" }).click();
  await connectionDialog.getByText("Server enabled.", { exact: true }).waitFor();
  await connectionDialog.getByRole("button", { name: "Close", exact: true }).click();
  await openProjectMenu(page);
  await projectOption(page, "Created on remote").waitFor();
  assert.equal(app.process().pid, desktopPid, "profile enable/disable must not relaunch Electron");

  console.log("multi-source desktop e2e: PASS");
} finally {
  if (app) await app.close().catch(() => undefined);
  if (remoteServer) await stopServer(remoteServer.child).catch(() => undefined);
  if (localServer) await stopServer(localServer.child).catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
}

function hostPaths(name) {
  const base = path.join(temporary, name);
  const runtimeDirectory = path.join(base, "runtime");
  return {
    runtimeDirectory,
    stateDirectory: path.join(base, "state"),
    runtimeFile: path.join(runtimeDirectory, "runtime.json"),
  };
}

async function startServer(host) {
  const child = spawn(serverBinary, [], {
    cwd: root,
    env: {
      ...process.env,
      HOME: testHomeDirectory,
      PATH: `${fakeBinDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      TERMLOOP_RUNTIME_DIR: host.runtimeDirectory,
      TERMLOOP_STATE_DIR: host.stateDirectory,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000); });
  const runtime = await waitUntil(async () => {
    try {
      const record = JSON.parse(await readFile(host.runtimeFile, "utf8"));
      return record.pid === child.pid ? record : undefined;
    } catch {
      return undefined;
    }
  }, 10_000, () => `daemon discovery did not appear: ${stderr}`);
  return { child, runtime };
}

async function launchProjectAgent(runtime, params) {
  const preview = await controlCall(runtime, "session.previewAgent", params);
  return controlCall(runtime, "session.launchAgent", {
    projectId: params.projectId,
    cwd: params.cwd,
    agentId: params.agentId,
    launchTicket: preview.launch_ticket,
  });
}

async function waitForRemoteResumeRef(sessionId) {
  return waitUntil(async () => {
    try {
      const state = JSON.parse(await readFile(path.join(remoteHost.stateDirectory, "state.v1.json"), "utf8"));
      return state.sessions.some((session) => session.id === sessionId && session.resume_ref) || undefined;
    } catch {
      return undefined;
    }
  }, 8_000, "remote Agent did not publish its resumable provider identity");
}

async function installFakeClaude() {
  const executable = path.join(fakeBinDirectory, process.platform === "win32" ? "claude.cmd" : "claude");
  if (process.platform === "win32") throw new Error("deterministic remote resume fixture is not implemented for Windows");
  await writeFile(executable, `#!/bin/sh
case "$1" in
  --help) printf '%s\\n' '  --session-id <uuid>' '  --resume <uuid>' '  --settings <file>'; exit 0 ;;
  --version) echo '2.1.fake'; exit 0 ;;
esac
settings=''
native_session_id=''
previous=''
for argument in "$@"; do
  if [ "$previous" = '--settings' ]; then settings="$argument"; fi
  if [ "$previous" = '--session-id' ] || [ "$previous" = '--resume' ]; then native_session_id="$argument"; fi
  previous="$argument"
done
run_hook() {
  event="$1"
  [ -n "$settings" ] || return
  hook_command=$(node -e "const value=JSON.parse(process.argv[1]); process.stdout.write(value.hooks[process.argv[2]][0].hooks[0].command)" "$settings" "$event")
  printf '{"hook_event_name":"%s","session_id":"%s"}' "$event" "$native_session_id" | sh -c "$hook_command"
}
case " $* " in
  *' --session-id '*)
    sleep 0.1
    run_hook UserPromptSubmit || true
    printf 'TERMLOOP_REMOTE_FRESH_SCREEN\\r\\n'
    ;;
  *' --resume '*)
    run_hook SessionStart || true
    printf 'TERMLOOP_REMOTE_RESUME_SCREEN\\r\\n'
    ;;
esac
while :; do sleep 1; done
`);
  await chmod(executable, 0o755);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGINT");
  await waitUntil(() => child.exitCode !== null, 5_000, "daemon did not stop");
}

async function controlCall(runtime, method, params = {}) {
  const socket = await openSocket(runtime.controlUrl);
  try {
    const id = randomUUID();
    socket.send(JSON.stringify({
      id,
      protocolVersion: CONTRACT_IDENTITY,
      token: runtime.token,
      method,
      params,
    }));
    const response = await waitForJson(socket, 12_000, `${method} timed out`);
    if (!response.ok) throw new Error(`${method} failed: ${response.error?.code ?? "unknown"}`);
    return response.result;
  } finally {
    socket.close();
  }
}

async function openSocket(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`websocket open timed out: ${url}`)), 5_000);
    socket.once("open", () => { clearTimeout(timer); resolve(); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  return socket;
}

async function waitForJson(socket, timeoutMs, message) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(message)); }, timeoutMs);
    const received = (raw) => {
      cleanup();
      try { resolve(JSON.parse(String(raw))); } catch (error) { reject(error); }
    };
    const failed = (error) => { cleanup(); reject(error instanceof Error ? error : new Error(message)); };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", received);
      socket.off("error", failed);
      socket.off("close", failed);
    };
    socket.once("message", received);
    socket.once("error", failed);
    socket.once("close", failed);
  });
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve access port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function openServers(page) {
  await page.locator(".server-connect-trigger").click();
  await page.locator(".server-profiles-dialog").waitFor();
}

async function openProjectMenu(page) {
  await page.getByRole("button", { name: "Current Project" }).click();
  await page.getByRole("menu", { name: "Project menu" }).waitFor();
}

async function closeProjectMenu(page) {
  await page.locator(".project-menu-backdrop").click({ position: { x: 2, y: 2 } });
  await page.getByRole("menu", { name: "Project menu" }).waitFor({ state: "hidden" });
}

function projectOption(page, name) {
  return page.getByRole("menuitem").filter({ hasText: name });
}

function sessionSelector(rawSessionId) {
  return `[data-session-id$="${rawSessionId}"]`;
}

async function assertTerminalRoundTrip(page, marker) {
  const input = page.locator(".layout-pane.active .xterm-helper-textarea");
  await input.waitFor();
  await input.focus();
  await page.keyboard.type(`echo ${marker}`);
  await page.keyboard.press("Enter");
  await waitUntil(
    async () => (await selectedTerminalText(page)).includes(marker),
    8_000,
    `terminal data did not round-trip for ${marker}`,
  );
}

async function selectedTerminalText(page) {
  return await page.evaluate(async () => await window.termloopDiagnostics?.selectedTerminalText() ?? "");
}

async function projectionRefreshCountFor(page) {
  return await page.evaluate(() => window.termloopDiagnostics?.projectionRefreshCount() ?? 0);
}

async function expectSourceHeadings(page, expected) {
  assert.deepEqual(await page.locator(".project-source-heading").allTextContents(), expected);
}

async function waitUntil(probe, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(typeof message === "function" ? message() : message);
}
