// Spike harness: two native Ghostty surfaces inside an Electron
// BrowserWindow, external-fd IO with a JS echo pump (no daemon needed),
// DOM overlay occlusion test, and automated evidence collection.
//
// Run:  pnpm start            (interactive)
//       pnpm evidence         (automated evidence -> evidence.json)

const { app, BrowserWindow, ipcMain, desktopCapturer } = require("electron");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const ghostty = require(path.join(
  __dirname,
  "..",
  "build",
  "Release",
  "ghostty_host.node",
));

const VENDOR = path.join(__dirname, "..", "..", "..", "vendor", "ghostty");
process.env.GHOSTTY_RESOURCES_DIR = path.join(
  VENDOR,
  "zig-out",
  "share",
  "ghostty",
);

const EVIDENCE_MODE = process.argv.includes("--evidence");
const MODIFIER_TEST_MODE = process.argv.includes("--modifier-test");
const CLIPBOARD_TEST_MODE = process.argv.includes("--clipboard-test");

// Layout constants (web coordinates, top-left origin, DIP).
const PANE_TOP = 64;
const PANE_MARGIN = 16;
const PANE_GAP = 12;

/** @type {Map<number, {socket: net.Socket, received: Buffer[]}>} */
const pumps = new Map();
let win = null;
let surfaceIds = [];
const consumedBySurface = new Map();

function paneRects(bounds) {
  const w = (bounds.width - PANE_MARGIN * 2 - PANE_GAP) / 2;
  const h = bounds.height - PANE_TOP - PANE_MARGIN;
  return [
    { x: PANE_MARGIN, y: PANE_TOP, width: w, height: h },
    { x: PANE_MARGIN + w + PANE_GAP, y: PANE_TOP, width: w, height: h },
  ];
}

// Echo pump: whatever ghostty writes (user input) is echoed back as
// terminal output, proving the full external-IO round trip.
function attachPump(surfaceId, hostFd) {
  const socket = new net.Socket({ fd: hostFd, readable: true, writable: true });
  const received = [];
  socket.on("data", (chunk) => {
    received.push(chunk);
    // Echo with CR -> CRLF so typed Enter looks right on screen.
    socket.write(Buffer.from(chunk.toString("binary").replace(/\r/g, "\r\n"), "binary"));
  });
  socket.on("error", (err) => console.error(`pump ${surfaceId}:`, err.message));
  pumps.set(surfaceId, { socket, received });
  return socket;
}

function createSurfaces() {
  const handle = win.getNativeWindowHandle();
  const rects = paneRects(win.getContentBounds());
  for (const rect of rects) {
    const created = ghostty.createSurface({ handle, ...rect });
    attachPump(created.id, created.hostFd);
    surfaceIds.push(created.id);
    const banner = `\x1b[1;32mTermLoop Ghostty spike — surface ${created.id}\x1b[0m\r\n` +
      `external fd IO, no child process. Type to echo.\r\n\r\n`;
    pumps.get(created.id).socket.write(banner);
  }
  syncFrames();
}

function syncFrames() {
  const rects = paneRects(win.getContentBounds());
  surfaceIds.forEach((id, i) => {
    if (rects[i]) ghostty.setSurfaceFrame(id, rects[i].x, rects[i].y, rects[i].width, rects[i].height);
  });
}

function electronChildren() {
  try {
    const out = execFileSync("pgrep", ["-lP", String(process.pid)], {
      encoding: "utf8",
    });
    return out.trim().split("\n").filter(Boolean);
  } catch {
    return []; // pgrep exits 1 when no children
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runEvidence() {
  const evidence = {
    startedAt: new Date().toISOString(),
    host: {
      macos: os.release(),
      arch: os.arch(),
      electron: process.versions.electron,
      node: process.versions.node,
      ghosttyCommit: execFileSync("git", ["-C", VENDOR, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      ghosttyBranch: execFileSync("git", ["-C", VENDOR, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(),
      zig: execFileSync("zig", ["version"], { encoding: "utf8" }).trim(),
      mode: "shown window (not headless)",
    },
    checks: {},
  };
  const checks = evidence.checks;

  const childrenBefore = electronChildren();
  createSurfaces();
  await sleep(1500); // let renderer threads spin up + banner render

  // 1. Surfaces created with a real grid.
  const sizes = surfaceIds.map((id) => ghostty.surfaceSize(id));
  checks.surfacesCreated = {
    pass: surfaceIds.length === 2 && sizes.every((s) => s.rows > 5 && s.cols > 20),
    sizes,
  };

  // 2. Output path: daemon-side bytes appear in the VT screen.
  const marker = `OUT-${Date.now().toString(36)}`;
  const markerBytes = Buffer.from(`${marker}\r\n`);
  const consumedBefore = consumedBySurface.get(surfaceIds[0]) ?? 0;
  pumps.get(surfaceIds[0]).socket.write(markerBytes);
  await sleep(700);
  const text0 = ghostty.surfaceText(surfaceIds[0]) ?? "";
  checks.outputPath = {
    pass: text0.includes(marker),
    marker,
    screenExcerpt: text0.slice(0, 400),
  };

  // 3. Input path: NSTextInputClient marked text + commit -> Ghostty input
  // encoding -> external backend -> host fd.
  const typed = `IN-${Date.now().toString(36)}-日本語-é`;
  const pump1 = pumps.get(surfaceIds[1]);
  pump1.received.length = 0;
  ghostty.sendText(surfaceIds[1], typed);
  await sleep(700);
  const inputSeen = Buffer.concat(pump1.received).toString();
  checks.inputPath = {
    pass: inputSeen.includes(typed),
    typed,
    inputSeen,
    note: "marked-text preedit and committed-text NSTextInputClient path",
  };

  // 4. Echo round trip: the echoed input is rendered back on screen.
  await sleep(300);
  const text1 = ghostty.surfaceText(surfaceIds[1]) ?? "";
  checks.echoRoundTrip = { pass: text1.includes(typed), screenExcerpt: text1.slice(0, 400) };

  // 4b. Claude enables Kitty's enhanced keyboard protocol. Exercise the
  // physical NSEvent path after enabling all flags and prove Ghostty emits
  // encoded press/release input instead of dropping the key.
  pump1.received.length = 0;
  pump1.socket.write("\x1b[>31u");
  await sleep(200);
  // Electron can deliver physical child-NSView events with an empty
  // `characters` property even though charactersByApplyingModifiers still
  // resolves the key. Kitty mode must use that explicit AppKit fallback.
  ghostty.sendKey(surfaceIds[1], "a", 0x00, true);
  await sleep(300);
  const kittyInput = Buffer.concat(pump1.received);
  checks.kittyKeyboardInput = {
    pass: kittyInput.byteLength > 0 && kittyInput.includes(Buffer.from("97")),
    receivedHex: kittyInput.toString("hex"),
    note: "NSEvent with empty characters property under Kitty report-all flags",
  };
  pump1.socket.write("\x1b[<u");

  // 5. Resize propagation: grid follows the native frame.
  const before = ghostty.surfaceSize(surfaceIds[0]);
  const resizeCallback = ghostty.setSurfaceFrame(surfaceIds[0], PANE_MARGIN, PANE_TOP, 300, 220);
  await sleep(500);
  const after = ghostty.surfaceSize(surfaceIds[0]);
  checks.resizePropagation = {
    pass: after.cols < before.cols && after.rows < before.rows && after.cols > 10,
    before, after, resizeCallback,
    note: "native host returned the new grid synchronously; production forwards this to the daemon-owned PTY",
  };

  const consumedDelta = (consumedBySurface.get(surfaceIds[0]) ?? 0) - consumedBefore;
  checks.consumedCredit = {
    pass: consumedDelta === markerBytes.byteLength,
    writtenBytes: markerBytes.byteLength,
    consumedBytes: consumedDelta,
    note: "callback fires after Termio.processOutput returns; production resolves binary-plane credit promises from this signal",
  };
  syncFrames();

  // 6. No child process spawned by ghostty.
  const childrenAfter = electronChildren();
  const newChildren = childrenAfter.filter((c) => !childrenBefore.includes(c));
  checks.noChildProcess = {
    pass: newChildren.every((c) => /Helper|crashpad/i.test(c)),
    childrenBefore, childrenAfter, newChildren,
  };

  // 7. Overlay occlusion: hide/show native view under a DOM overlay.
  win.webContents.send("overlay", true);
  ghostty.setSurfaceVisible(surfaceIds[0], false);
  await sleep(600);
  win.webContents.send("overlay", false);
  ghostty.setSurfaceVisible(surfaceIds[0], true);
  await sleep(400);
  const textAfterOverlay = ghostty.surfaceText(surfaceIds[0]) ?? "";
  checks.overlayHideShow = {
    pass: textAfterOverlay.includes(marker),
    note: "native view hidden+reshown; screen content retained",
  };

  // 7b. Visual: self-capture the window (includes native views) so the
  // report can show actual rendered pixels. Best-effort.
  try {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 1200, height: 800 },
    });
    const own = sources.find((s) => s.name.includes("Ghostty spike"));
    if (own && !own.thumbnail.isEmpty()) {
      const shot = path.join(__dirname, "..", "evidence-window.png");
      fs.writeFileSync(shot, own.thumbnail.toPNG());
      checks.visualCapture = { pass: true, file: "evidence-window.png" };
    } else {
      checks.visualCapture = { neutral: true, skipped: "window source not found; verify visually via pnpm start" };
    }
  } catch (err) {
    checks.visualCapture = { neutral: true, skipped: `capture unavailable: ${err.message}; verify visually via pnpm start` };
  }

  // 8. Teardown.
  for (const id of surfaceIds) ghostty.destroySurface(id);
  for (const { socket } of pumps.values()) socket.destroy();
  checks.teardown = { pass: ghostty.surfaceCount() === 0 };
  surfaceIds = [];

  evidence.finishedAt = new Date().toISOString();
  evidence.pass = Object.values(checks).every((c) => c.neutral || c.pass === true);
  const out = path.join(__dirname, "..", "evidence.json");
  fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
  console.log(`evidence written: ${out} pass=${evidence.pass}`);
  for (const [name, c] of Object.entries(checks)) {
    console.log(`  ${c.neutral ? "NEUTRAL" : c.pass ? "PASS" : "FAIL"} ${name}`);
  }
  app.exit(evidence.pass ? 0 : 1);
}

async function runModifierTest() {
  createSurfaces();
  await sleep(300);
  const pump = pumps.get(surfaceIds[0]);
  pump.received.length = 0;
  for (const keyCode of [0x38, 0x3b, 0x37]) {
    ghostty.sendModifierKey(surfaceIds[0], keyCode);
  }
  const marker = `MODIFIER-OK-${Date.now().toString(36)}`;
  ghostty.sendText(surfaceIds[0], marker);
  await sleep(300);
  const input = Buffer.concat(pump.received).toString();
  for (const id of surfaceIds) ghostty.destroySurface(id);
  for (const { socket } of pumps.values()) socket.destroy();
  surfaceIds = [];
  if (!input.includes(marker)) throw new Error("surface input stopped after modifier events");
  console.log("GHOSTTY_MODIFIER_EVENTS_OK");
  app.exit(0);
}

async function runClipboardTest() {
  createSurfaces();
  await sleep(300);
  const pump = pumps.get(surfaceIds[0]);
  pump.received.length = 0;
  const marker = `PASTE-OK-${Date.now().toString(36)}`;
  const handled = ghostty.sendPasteShortcut(surfaceIds[0], marker);
  await sleep(300);
  const input = Buffer.concat(pump.received).toString();
  for (const id of surfaceIds) ghostty.destroySurface(id);
  for (const { socket } of pumps.values()) socket.destroy();
  surfaceIds = [];
  if (!handled || !input.includes(marker)) {
    throw new Error(`Cmd+V was not delivered: handled=${handled} input=${JSON.stringify(input)}`);
  }
  console.log("GHOSTTY_CLIPBOARD_PASTE_OK");
  app.exit(0);
}

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: "#1e2325",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await win.loadFile(path.join(__dirname, "index.html"));

  ghostty.initApp({
    onOutputConsumed: (surfaceId, bytes) => {
      consumedBySurface.set(surfaceId, (consumedBySurface.get(surfaceId) ?? 0) + bytes);
    },
  });

  win.on("resize", syncFrames);
  ipcMain.on("toggle-overlay", (_e, shown) => {
    // DOM overlay cannot draw above the native view; occlude it instead.
    if (surfaceIds[0] !== undefined) ghostty.setSurfaceVisible(surfaceIds[0], !shown);
  });
  ipcMain.on("focus-surface", (_e, index) => {
    if (surfaceIds[index] !== undefined) ghostty.focusSurface(surfaceIds[index]);
  });

  if (CLIPBOARD_TEST_MODE) {
    runClipboardTest().catch((err) => {
      console.error(err);
      app.exit(2);
    });
  } else if (MODIFIER_TEST_MODE) {
    runModifierTest().catch((err) => {
      console.error(err);
      app.exit(2);
    });
  } else if (EVIDENCE_MODE) {
    runEvidence().catch((err) => {
      console.error(err);
      app.exit(2);
    });
  } else {
    createSurfaces();
    ghostty.focusSurface(surfaceIds[0]);
  }
});

app.on("window-all-closed", () => app.quit());
