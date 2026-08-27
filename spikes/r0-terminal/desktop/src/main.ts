import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(directory, "../../../..");
const discoveryPath = process.env.TERMLOOP_R0_DISCOVERY ?? path.join(repoRoot, "artifacts/evidence/r0/runtime.json");
const outputPath = process.env.TERMLOOP_R0_OUTPUT ?? path.join(repoRoot, "artifacts/evidence/r0/local.json");
const packageRecord = JSON.parse(await readFile(path.join(repoRoot, "spikes/r0-terminal/desktop/package.json"), "utf8"));
const windowShown = process.env.TERMLOOP_R0_HEADLESS !== "1";

ipcMain.handle("r0:config", async () => {
  const discovery = JSON.parse(await readFile(discoveryPath, "utf8"));
  return { ...discovery, full: process.env.TERMLOOP_R0_FULL === "1", platform: process.platform };
});

ipcMain.on("r0:result", async (_event, result) => {
  const envelope = {
    schemaVersion: "r0-v1",
    capturedAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, osRelease: os.release(), cpus: os.cpus().map((cpu) => cpu.model), memoryBytes: os.totalmem() },
    runtime: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, xterm: packageRecord.dependencies["@xterm/xterm"], windowShown },
    physicalPixelLatencyMeasured: false,
    result
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(envelope, null, 2));
  console.log(`R0_RESULT=${outputPath}`);
  app.quit();
});

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: windowShown,
    width: 1280,
    height: 900,
    backgroundColor: "#111111",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, preload: path.join(directory, "preload.cjs") }
  });
  await window.loadFile(path.join(directory, "index.html"));
});
