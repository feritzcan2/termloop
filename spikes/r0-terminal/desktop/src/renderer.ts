import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

declare global { interface Window { r0: { config(): Promise<{ terminalUrl: string; token: string; full: boolean; platform: string }>; result(value: unknown): void } } }

const MAGIC = new TextEncoder().encode("TL01");
const encoder = new TextEncoder();
const KIND_INPUT = 1, KIND_OUTPUT = 2, KIND_RESIZE = 3, KIND_SPAWN = 10, KIND_ACK = 11;

function encodeFrame(session: number, sequence: bigint, kind: number, payload = new Uint8Array()): ArrayBuffer {
  const bytes = new Uint8Array(29 + payload.length); const view = new DataView(bytes.buffer);
  bytes.set(MAGIC); view.setUint32(4, session); view.setBigUint64(8, 1n); view.setBigUint64(16, sequence); bytes[24] = kind; view.setUint32(25, payload.length); bytes.set(payload, 29); return bytes.buffer;
}

function decodeFrame(buffer: ArrayBuffer) {
  const view = new DataView(buffer); const bytes = new Uint8Array(buffer);
  return { session: view.getUint32(4), kind: bytes[24]!, payload: bytes.slice(29, 29 + view.getUint32(25)) };
}

function installDsrResponder(socket: WebSocket, platform: string) {
  if (platform !== "win32") return;
  const responded = new Set<number>();
  socket.addEventListener("message", (event: MessageEvent<ArrayBuffer>) => {
    if (typeof event.data === "string" || event.data.byteLength < 29) return;
    const frame = decodeFrame(event.data);
    if (frame.kind !== KIND_OUTPUT || responded.has(frame.session)) return;
    if (!new TextDecoder().decode(frame.payload).includes("\x1b[6n")) return;
    responded.add(frame.session);
    socket.send(encodeFrame(frame.session, 0n, KIND_INPUT, encoder.encode("\x1b[1;1R")));
  });
}

function percentile(values: number[], percentileValue: number) {
  const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percentileValue))] ?? 0;
}

async function twoFrames() { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); }

async function measuredFrameInterval() {
  const samples: number[] = []; let previous = performance.now();
  for (let index = 0; index < 30; index++) {
    await new Promise(requestAnimationFrame); const now = performance.now(); samples.push(now - previous); previous = now;
  }
  return percentile(samples.slice(5), .50);
}

async function rendererMatrix(full: boolean) {
  const root = document.querySelector("#matrix")!; const results = [];
  for (const count of [1, 8, 16, 32]) {
    root.replaceChildren(); const terminals: Terminal[] = []; const addons: WebglAddon[] = []; let loaded = 0; let losses = 0;
    const start = performance.now();
    for (let index = 0; index < count; index++) {
      const host = document.createElement("div"); host.style.cssText = "width:600px;height:180px;display:inline-block"; root.append(host);
      const terminal = new Terminal({ cols: 80, rows: 10, scrollback: 1000 }); terminal.open(host); terminals.push(terminal);
      try { const addon = new WebglAddon(); addon.onContextLoss(() => { losses++; }); terminal.loadAddon(addon); addons.push(addon); loaded++; } catch {}
      terminal.write(("output-" + index + " ").repeat(full ? 25000 : 1000));
    }
    await twoFrames();
    results.push({ count, webglLoaded: loaded, contextLosses: losses, renderMs: performance.now() - start });
    addons.forEach((addon) => addon.dispose()); terminals.forEach((terminal) => terminal.dispose());
  }
  root.replaceChildren(); return results;
}

async function ptyLatency(terminalUrl: string, token: string, full: boolean, platform: string) {
  const host = document.createElement("div"); host.style.cssText = "width:800px;height:400px"; document.querySelector("#matrix")!.append(host);
  const terminal = new Terminal({ cols: 80, rows: 24 }); terminal.open(host);
  let webgl = false; try { terminal.loadAddon(new WebglAddon()); webgl = true; } catch {}
  const socket = await connect(terminalUrl, token, platform);
  socket.send(encodeFrame(1, 0n, KIND_SPAWN));
  await new Promise<void>((resolve) => { const handler = (event: MessageEvent<ArrayBuffer>) => { const frame = decodeFrame(event.data); if (frame.kind === KIND_ACK) { socket.removeEventListener("message", handler); resolve(); } }; socket.addEventListener("message", handler); });
  const samples: number[] = []; const iterations = full ? 200 : 30;
  for (let index = 0; index < iterations; index++) {
    const started = performance.now();
    const completed = new Promise<void>((resolve) => { const handler = (event: MessageEvent<ArrayBuffer>) => { const frame = decodeFrame(event.data); if (frame.session === 1 && frame.kind === KIND_OUTPUT) { socket.removeEventListener("message", handler); terminal.write(frame.payload, async () => { await twoFrames(); samples.push(performance.now() - started); resolve(); }); } }; socket.addEventListener("message", handler); });
    socket.send(encodeFrame(1, BigInt(index + 1), KIND_INPUT, encoder.encode("x")));
    await completed;
  }
  socket.close(); terminal.dispose();
  return { renderer: webgl ? "webgl" : "fallback", samples, p50: percentile(samples, .50), p95: percentile(samples, .95), p99: percentile(samples, .99) };
}

async function connect(terminalUrl: string, token: string, platform: string) {
  const socket = new WebSocket(terminalUrl); socket.binaryType = "arraybuffer";
  installDsrResponder(socket, platform);
  await new Promise<void>((resolve, reject) => { socket.onopen = () => socket.send(new Blob([encoder.encode("AUTH" + token)])); socket.onerror = () => reject(new Error("socket failed")); socket.onmessage = (event) => { if (typeof event.data !== "string" && new TextDecoder().decode(event.data) === "TLOK") resolve(); }; });
  return socket;
}

async function spawnSession(socket: WebSocket, session: number) {
  socket.send(encodeFrame(session, 0n, KIND_SPAWN));
  await new Promise<void>((resolve) => { const handler = (event: MessageEvent<ArrayBuffer>) => { const frame = decodeFrame(event.data); if (frame.session === session && frame.kind === KIND_ACK) { socket.removeEventListener("message", handler); resolve(); } }; socket.addEventListener("message", handler); });
}

async function throughputTest(terminalUrl: string, token: string, full: boolean, platform: string) {
  const socket = await connect(terminalUrl, token, platform); const session = 2; await spawnSession(socket, session);
  const host = document.createElement("div"); host.style.cssText = "width:800px;height:400px"; document.querySelector("#matrix")!.append(host);
  const terminal = new Terminal({ cols: 120, rows: 30, scrollback: 1000 }); terminal.open(host); try { terminal.loadAddon(new WebglAddon()); } catch {}
  const total = full ? 20 * 1024 * 1024 : 1024 * 1024; const chunk = new Uint8Array(64 * 1024).fill("z".charCodeAt(0));
  let received = 0; let maxFrameGapMs = 0; let lastFrame = performance.now(); const started = performance.now();
  const done = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`throughput timeout ${received}/${total}`)), 90000);
    socket.addEventListener("message", (event: MessageEvent<ArrayBuffer>) => {
      const frame = decodeFrame(event.data); if (frame.session !== session || frame.kind !== KIND_OUTPUT) return;
      terminal.write(frame.payload);
      for (const byte of frame.payload) if (byte === 122) received++;
      if (received >= total) { clearTimeout(timeout); resolve(); }
    });
  });
  const heartbeat = () => { const now = performance.now(); maxFrameGapMs = Math.max(maxFrameGapMs, now - lastFrame); lastFrame = now; if (received < total) requestAnimationFrame(heartbeat); };
  requestAnimationFrame(heartbeat);
  for (let offset = 0; offset < total; offset += chunk.length) {
    socket.send(encodeFrame(session, BigInt(offset / chunk.length + 1), KIND_INPUT, chunk.subarray(0, Math.min(chunk.length, total - offset))));
    while (socket.bufferedAmount > 1024 * 1024) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await done; await twoFrames(); const durationMs = performance.now() - started; socket.close(); terminal.dispose(); host.remove();
  return { bytesSent: total, matchingBytesReceived: received, byteLoss: total - received, durationMs, mibPerSecond: total / 1024 / 1024 / (durationMs / 1000), maxAnimationFrameGapMs: maxFrameGapMs };
}

async function resizeStorm(terminalUrl: string, token: string, platform: string) {
  const socket = await connect(terminalUrl, token, platform); const session = 3; await spawnSession(socket, session); let acknowledgements = 0; let daemonRows = 0; let daemonCols = 0;
  const terminal = new Terminal({ cols: 80, rows: 20 });
  const done = new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("resize timeout")), 10000); socket.addEventListener("message", (event: MessageEvent<ArrayBuffer>) => { const frame = decodeFrame(event.data); if (frame.session === session && frame.kind === KIND_ACK && frame.payload.length === 4) { const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength); daemonRows = view.getUint16(0); daemonCols = view.getUint16(2); acknowledgements++; if (acknowledgements === 100) { clearTimeout(timeout); resolve(); } } }); });
  for (let index = 0; index < 100; index++) { const rows = 20 + index % 30, cols = 80 + index % 40; terminal.resize(cols, rows); const payload = new Uint8Array(4); const view = new DataView(payload.buffer); view.setUint16(0, rows); view.setUint16(2, cols); socket.send(encodeFrame(session, BigInt(index + 1), KIND_RESIZE, payload)); }
  await done; socket.close(); const result = { sent: 100, acknowledged: acknowledgements, daemonRows, daemonCols, rendererRows: terminal.rows, rendererCols: terminal.cols, matches: daemonRows === terminal.rows && daemonCols === terminal.cols }; terminal.dispose(); return result;
}

async function loadedLatency(terminalUrl: string, token: string, full: boolean, platform: string) {
  const socket = await connect(terminalUrl, token, platform); const interactive = 10; const peers = [11, 12, 13, 14, 15, 16, 17];
  for (const session of [interactive, ...peers]) await spawnSession(socket, session);
  const root = document.querySelector("#matrix")!; const terminals = new Map<number, Terminal>();
  for (const session of [interactive, ...peers]) { const host = document.createElement("div"); host.style.cssText = "width:400px;height:120px;display:inline-block"; root.append(host); const terminal = new Terminal({ cols: 80, rows: 8, scrollback: 100 }); terminal.open(host); try { terminal.loadAddon(new WebglAddon()); } catch {} terminals.set(session, terminal); }
  let interactiveResolve: (() => void) | undefined; const samples: number[] = []; let started = 0; let peerBytes = 0;
  socket.addEventListener("message", (event: MessageEvent<ArrayBuffer>) => { const frame = decodeFrame(event.data); if (frame.kind !== KIND_OUTPUT) return; const terminal = terminals.get(frame.session); if (frame.session !== interactive) { peerBytes += frame.payload.length; terminal?.write(frame.payload); return; } terminal?.write(frame.payload, async () => { await twoFrames(); samples.push(performance.now() - started); interactiveResolve?.(); interactiveResolve = undefined; }); });
  const iterations = full ? 100 : 20; const peerChunk = new Uint8Array(full ? 4096 : 512).fill(112);
  for (let index = 0; index < iterations; index++) { for (const peer of peers) socket.send(encodeFrame(peer, BigInt(index + 1), KIND_INPUT, peerChunk)); await new Promise<void>((resolve) => { interactiveResolve = resolve; started = performance.now(); socket.send(encodeFrame(interactive, BigInt(index + 1), KIND_INPUT, encoder.encode("i"))); }); }
  socket.close(); terminals.forEach((terminal) => terminal.dispose()); root.replaceChildren(); return { peers: peers.length, iterations, peerBytes, samples, p95: percentile(samples, .95), max: Math.max(...samples) };
}

async function main() {
  const config = await window.r0.config();
  const frameIntervalMs = await measuredFrameInterval();
  const matrix = await rendererMatrix(config.full);
  const latency = await ptyLatency(config.terminalUrl, config.token, config.full, config.platform);
  const throughput = await throughputTest(config.terminalUrl, config.token, config.full, config.platform);
  const resize = await resizeStorm(config.terminalUrl, config.token, config.platform);
  const underLoad = await loadedLatency(config.terminalUrl, config.token, config.full, config.platform);
  window.r0.result({ mode: config.full ? "full" : "smoke", frameIntervalMs, estimatedRefreshHz: 1000 / frameIntervalMs, matrix, latency, underLoad, throughput, resize, measurement: "key-send to PTY echo to xterm write callback plus two requestAnimationFrame" });
}

main().catch((error) => window.r0.result({ fatal: error instanceof Error ? error.stack : String(error) }));
