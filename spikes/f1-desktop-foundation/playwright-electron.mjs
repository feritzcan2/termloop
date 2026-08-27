import { _electron as electron } from "playwright";
import WebSocket from "ws";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const packaged = process.argv.includes("--packaged");
const spikeDirectory = path.join(root, "spikes/f1-desktop-foundation");
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-f1-playwright-"));
const runtimeDirectory = path.join(temporary, "runtime");
const stateDirectory = path.join(temporary, "state");
const projectDirectory = path.join(temporary, "project");
const electronUserDataDirectory = path.join(temporary, "electron-user-data");
const runtimeFile = path.join(runtimeDirectory, "runtime.json");
const serverBinary = path.join(root, "target/debug/termloop-server");
await Promise.all([mkdir(runtimeDirectory, { recursive: true }), mkdir(stateDirectory, { recursive: true }), mkdir(projectDirectory, { recursive: true })]);

const evidence = {
  schema: "f1-playwright-electron-v1",
  recordedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, release: os.release(), cpu: os.cpus()[0]?.model ?? "unknown" },
  dependencies: {},
  mode: packaged ? "packaged" : "development",
  checks: {
    xtermBufferReadable: false,
    keyboardPtyRoundTrip: false,
    projectionRefreshPreservesTerminal: false,
    sixTerminalPreservation: false,
    projectSwitchPreservesTerminal: false,
    daemonRestartRetiresOldEpochs: 0,
    reconnectRuns: 0,
    reconnectTarget: packaged ? 1 : 20,
  },
  latency: {
    measurement: "utility input send to PTY echo to xterm write callback plus two requestAnimationFrame",
    comparisonLimit: "The accepted proxy proves the utility path is within budget; its two-frame floor does not distinguish utility from the prior direct path.",
  },
  failures: [],
};

let server;
let electronApp;
let page;
try {
  server = await startServer();
  const firstRecord = await readRecord(server.pid);
  const projectA = await controlCall(firstRecord, "project.create", { name: "Playwright Project A", folderPath: projectDirectory });
  const projectBDirectory = path.join(temporary, "project-b");
  await mkdir(projectBDirectory, { recursive: true });
  const projectB = await controlCall(firstRecord, "project.create", { name: "Playwright Project B", folderPath: projectBDirectory });

  electronApp = await electron.launch({
    ...(packaged
      ? { executablePath: path.join(root, "clients/desktop/out/mac-arm64/TermLoop Next.app/Contents/MacOS/TermLoop Next"), args: [] }
      : { args: [path.join(root, "clients/desktop")] }),
    cwd: root,
    env: {
      ...process.env,
      TERMLOOP_RUNTIME_FILE: runtimeFile,
      TERMLOOP_DESKTOP_DIAGNOSTICS: "1",
      TERMLOOP_DESKTOP_USER_DATA_DIR: electronUserDataDirectory,
    },
  });
  page = await electronApp.firstWindow();
  await page.locator("[aria-label='Projects and sessions']").waitFor();
  await waitUntil(async () => page.locator("#new-terminal").isEnabled(), 8_000, "new terminal action did not become enabled");
  await page.locator("#new-terminal").click();
  await page.locator(".layout-pane.active").waitFor({ state: "visible" });
  await page.locator(".xterm").waitFor({ state: "visible" });
  await waitUntil(
    async () => Boolean((await selectedProbe(page))?.text?.trim()),
    8_000,
    "xterm buffer diagnostics did not expose rendered content",
  );
  evidence.checks.xtermBufferReadable = true;

  await page.locator(".layout-pane.active .xterm-helper-textarea").focus();
  await page.keyboard.type("printf 'PW_INPUT_OK\\n'");
  await page.keyboard.press("Enter");
  await waitUntil(
    async () => await selectedTextOccurrences(page, "PW_INPUT_OK") >= 2,
    8_000,
    "keyboard input did not round-trip through the PTY",
  );
  evidence.checks.keyboardPtyRoundTrip = true;

  const beforeRefreshProbe = await selectedProbe(page);
  const beforeRefreshMetrics = await rendererMetrics(page);
  await page.evaluate(async () => await globalThis.termloopDiagnostics.refreshProjection());
  await page.waitForTimeout(100);
  const afterRefreshProbe = await selectedProbe(page);
  const afterRefreshMetrics = await rendererMetrics(page);
  assertProbeEqual(beforeRefreshProbe, afterRefreshProbe, "projection refresh changed the selected terminal");
  if (afterRefreshMetrics.mountCalls !== beforeRefreshMetrics.mountCalls
    || afterRefreshMetrics.unmountCalls !== beforeRefreshMetrics.unmountCalls
    || afterRefreshMetrics.webglContextsCreated !== beforeRefreshMetrics.webglContextsCreated
    || afterRefreshMetrics.webglContextsDisposed !== beforeRefreshMetrics.webglContextsDisposed) {
    throw new Error(`projection refresh churned terminal resources: ${JSON.stringify({ beforeRefreshMetrics, afterRefreshMetrics })}`);
  }
  evidence.checks.projectionRefreshPreservesTerminal = true;

  await page.waitForTimeout(150);
  const latency = await page.evaluate(async () => await globalThis.termloopDiagnostics.measureSelectedEcho(100));
  const latencyBudgetP95Ms = 3 * latency.frameIntervalMs + 5;
  evidence.latency = {
    ...evidence.latency,
    ...latency,
    budgetP95Ms: latencyBudgetP95Ms,
    passed: latency.p95 <= latencyBudgetP95Ms,
  };
  if (!evidence.latency.passed) throw new Error(`utility transport p95 ${latency.p95} exceeded ${latencyBudgetP95Ms}`);

  for (let index = 2; index <= 5; index += 1) {
    await page.locator("#new-terminal").click();
    await waitForTerminalCount(page, index);
    await page.locator(".layout-pane.active .xterm-helper-textarea").focus();
    await page.keyboard.type(`printf 'PW_BUFFER_${index}\\n'`);
    await page.keyboard.press("Enter");
    await waitUntil(
      async () => await selectedTextOccurrences(page, `PW_BUFFER_${index}`) >= 2,
      8_000,
      `terminal ${index} did not render its buffer marker`,
    );
  }
  const originalSessionIds = await page.locator("[aria-label='Terminal sessions'] .session-item").evaluateAll(
    (items) => items.map((item) => item.getAttribute("data-session-id")).filter(Boolean),
  );
  const originalProbes = [];
  for (const sessionId of originalSessionIds) {
    await selectTerminal(page, sessionId);
    await page.waitForTimeout(75);
    originalProbes.push(await selectedProbe(page));
  }
  await page.locator("#new-terminal").click();
  await waitForTerminalCount(page, 6);
  for (let index = 0; index < originalSessionIds.length; index += 1) {
    await selectTerminal(page, originalSessionIds[index]);
    await page.waitForTimeout(75);
    assertProbeEqual(originalProbes[index], await selectedProbe(page), `terminal ${index + 1} changed after creating terminal 6`);
  }
  evidence.checks.sixTerminalPreservation = true;

  await selectTerminal(page, originalSessionIds[0]);
  const projectABeforeSwitch = await selectedProbe(page);
  await page.locator("#project").selectOption(projectB.id);
  await page.locator("#new-terminal").click();
  await waitForTerminalCount(page, 1);
  await page.locator(".layout-pane.active .xterm-helper-textarea").focus();
  await page.keyboard.type("printf 'PW_PROJECT_B\\n'");
  await page.keyboard.press("Enter");
  await waitUntil(
    async () => await selectedTextOccurrences(page, "PW_PROJECT_B") >= 2,
    8_000,
    "Project B terminal did not render",
  );
  await page.locator("#project").selectOption(projectA.id);
  await waitForTerminalCount(page, 6);
  await page.waitForTimeout(100);
  assertProbeEqual(projectABeforeSwitch, await selectedProbe(page), "Project A terminal changed after A → B → A");
  evidence.checks.projectSwitchPreservesTerminal = true;

  for (let index = 0; index < evidence.checks.reconnectTarget; index += 1) {
    const beforeRestart = await controlCall(await readRecord(server.pid), "session.list");
    const runningBeforeRestart = beforeRestart.filter((session) => session.lifecycle_state === "running");
    await stopServer(server);
    server = undefined;
    await expectText(page.locator(".connection-status"), /reconnect|not running|lost/i, 4_000);
    server = await startServer();
    await expectText(page.locator(".connection-status"), /\d+ live · 2 projects/, 8_000);
    const afterRestart = await controlCall(await readRecord(server.pid), "session.list");
    const afterById = new Map(afterRestart.map((session) => [session.id, session]));
    if (afterRestart.some((session) => session.lifecycle_state === "running")
      || runningBeforeRestart.some((session) => afterById.get(session.id)?.lifecycle_state !== "exited")) {
      throw new Error("daemon restart created an implicit replacement PTY or failed to stale the old epoch");
    }
    evidence.checks.daemonRestartRetiresOldEpochs += 1;
    evidence.checks.reconnectRuns += 1;
    if (index + 1 < evidence.checks.reconnectTarget) {
      await page.locator("#new-terminal").click();
      await page.locator(".layout-pane.active .xterm").waitFor({ state: "visible" });
      await waitUntil(async () => Boolean((await selectedProbe(page))?.text?.trim()), 8_000, "reconnected terminal did not render");
    }
  }

  evidence.dependencies = await electronApp.evaluate(({ app }) => ({
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    appVersion: app.getVersion(),
    playwright: "1.55.0",
    xterm: "6.0.0",
    shown: true,
  }));
} catch (error) {
  evidence.failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
  if (page) {
    await page.screenshot({ path: path.join(spikeDirectory, "failure.png") }).catch(() => undefined);
    evidence.failureState = await page.evaluate(() => ({
      status: document.querySelector(".connection-status")?.textContent ?? "",
      sessions: document.querySelectorAll(".session-item").length,
      terminalPanels: document.querySelectorAll(".layout-pane").length,
      xterms: document.querySelectorAll(".xterm").length,
      probe: globalThis.termloopDiagnostics?.selectedTerminalProbe(),
    })).catch(() => undefined);
  }
} finally {
  if (electronApp) await electronApp.close().catch(() => undefined);
  if (server) await stopServer(server).catch(() => undefined);
  const passed = evidence.checks.xtermBufferReadable
    && evidence.checks.keyboardPtyRoundTrip
    && evidence.checks.projectionRefreshPreservesTerminal
    && evidence.checks.sixTerminalPreservation
    && evidence.checks.projectSwitchPreservesTerminal
    && evidence.checks.daemonRestartRetiresOldEpochs === evidence.checks.reconnectTarget
    && evidence.latency.passed === true
    && evidence.checks.reconnectRuns === evidence.checks.reconnectTarget
    && evidence.failures.length === 0;
  evidence.status = passed ? "GO" : "NO-GO";
  const suffix = packaged ? "-packaged" : "";
  if (passed) await rm(path.join(spikeDirectory, "failure.png"), { force: true });
  await writeFile(path.join(spikeDirectory, `evidence${suffix}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(path.join(spikeDirectory, `REPORT${suffix}.md`), report(evidence));
  await rm(temporary, { recursive: true, force: true });
  if (!passed) process.exitCode = 1;
}

async function startServer() {
  const child = spawn(serverBinary, [], {
    cwd: root,
    env: { ...process.env, TERMLOOP_RUNTIME_DIR: runtimeDirectory, TERMLOOP_STATE_DIR: stateDirectory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.once("exit", (code) => {
    if (code && !child.killed) evidence.failures.push(`server exited ${code}: ${stderr}`);
  });
  await readRecord(child.pid);
  return child;
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGINT");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function readRecord(pid) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(await readFile(runtimeFile, "utf8"));
      if (record.pid === pid) return record;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`runtime discovery did not appear for pid ${pid}`);
}

async function controlCall(record, method, params = {}) {
  const socket = new WebSocket(record.controlUrl);
  const id = crypto.randomUUID();
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error(`${method} timed out`)); }, 5_000);
    socket.once("open", () => socket.send(JSON.stringify({ id, protocolVersion: record.protocolVersion, token: record.token, method, params })));
    socket.once("message", (raw) => {
      clearTimeout(timeout);
      socket.close();
      const response = JSON.parse(String(raw));
      if (response.ok) resolve(response.result);
      else reject(new Error(`${method}: ${response.error?.message ?? "failed"}`));
    });
    socket.once("error", reject);
  });
}

async function expectText(locator, pattern, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = await locator.innerText().catch(() => "");
    if (pattern.test(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`text ${pattern} was not observed within ${timeout}ms`);
}

async function waitUntil(check, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function selectedProbe(targetPage) {
  return await targetPage.evaluate(() => globalThis.termloopDiagnostics?.selectedTerminalProbe());
}

async function selectedTextOccurrences(targetPage, marker) {
  const text = (await selectedProbe(targetPage))?.text ?? "";
  return text.split(marker).length - 1;
}

async function rendererMetrics(targetPage) {
  return await targetPage.evaluate(() => globalThis.termloopDiagnostics?.rendererMetrics());
}

async function waitForTerminalCount(targetPage, count) {
  await waitUntil(
    async () => await targetPage.locator("[aria-label='Terminal sessions'] .session-item").count() === count,
    8_000,
    `terminal count did not reach ${count}`,
  );
  await targetPage.locator(".layout-pane.active .xterm").waitFor({ state: "visible" });
}

async function selectTerminal(targetPage, sessionId) {
  await targetPage.locator(`[aria-label='Terminal sessions'] [data-session-id="${sessionId}"]`).click();
  await targetPage.locator(".layout-pane.active .xterm").waitFor({ state: "visible" });
}

function assertProbeEqual(expected, actual, message) {
  const fields = ["lines", "cursorX", "cursorY", "text"];
  if (!expected || !actual || fields.some((field) => expected[field] !== actual[field])) {
    throw new Error(`${message}: ${JSON.stringify({ expected, actual })}`);
  }
}

function report(result) {
  const latencyResult = result.latency.passed
    ? `PASS (${result.latency.p95.toFixed(2)} ms ≤ ${result.latency.budgetP95Ms.toFixed(2)} ms; no direct-path delta claimed)`
    : "FAIL";
  return `# F1 Playwright Electron Spike\n\n- Status: **${result.status}**\n- Recorded: ${result.recordedAt}\n- Host: ${result.host.platform} ${result.host.arch} ${result.host.release}\n- Mode: shown ${result.mode} Electron window\n\n## Checks\n\n| Check | Result |\n|---|---|\n| xterm buffer readable | ${result.checks.xtermBufferReadable ? "PASS" : "FAIL"} |\n| keyboard → PTY → xterm | ${result.checks.keyboardPtyRoundTrip ? "PASS" : "FAIL"} |\n| projection refresh preserves mount/WebGL + buffer | ${result.checks.projectionRefreshPreservesTerminal ? "PASS" : "FAIL"} |\n| five terminals preserved after creating sixth | ${result.checks.sixTerminalPreservation ? "PASS" : "FAIL"} |\n| Project A → B → A preserves buffer | ${result.checks.projectSwitchPreservesTerminal ? "PASS" : "FAIL"} |\n| daemon restart retires old epochs; no implicit PTY | ${result.checks.daemonRestartRetiresOldEpochs}/${result.checks.reconnectTarget} |\n| utility transport p95 ≤ 3F+5 | ${latencyResult} |\n| reconnect runs | ${result.checks.reconnectRuns}/${result.checks.reconnectTarget} |\n\n## Latency interpretation\n\n${result.latency.comparisonLimit}\n\n## Dependencies\n\n\`\`\`json\n${JSON.stringify(result.dependencies, null, 2)}\n\`\`\`\n\n## Failures\n\n${result.failures.length ? result.failures.map((failure) => `- ${failure}`).join("\n") : "None."}\n`;
}
