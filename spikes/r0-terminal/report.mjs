import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const input = path.resolve("artifacts/evidence/r0/local.json");
const output = path.resolve("artifacts/evidence/r0/REPORT.md");
const data = JSON.parse(await readFile(input, "utf8"));
const result = data.result ?? {};
const fatal = result.fatal;
const contextFailure = result.matrix?.some((row) => row.contextLosses > 0 || row.webglLoaded < row.count);
const frame = result.frameIntervalMs;
const latencyBudget = frame ? { p50: frame * 2 + 5, p95: frame * 3 + 5, p99: frame * 4 + 5 } : undefined;
const latencyFailure = !latencyBudget || result.latency?.p50 > latencyBudget.p50 || result.latency?.p95 > latencyBudget.p95 || result.latency?.p99 > latencyBudget.p99;
const dataFailure = result.throughput?.byteLoss !== 0 || result.resize?.acknowledged !== 100 || result.resize?.matches !== true;
const loadedFailure = !result.underLoad || result.underLoad.p95 > 35;
const status = fatal || contextFailure || latencyFailure || dataFailure || loadedFailure ? "NO-GO" : data.physicalPixelLatencyMeasured ? "GO" : "PROVISIONAL-GO";
const report = `# R0 local report\n\n- Status: **${status}**\n- Captured: ${data.capturedAt}\n- Host: ${data.host.platform}/${data.host.arch} ${data.host.osRelease}\n- Electron/Chromium/xterm: ${data.runtime.electron}/${data.runtime.chromium}/${data.runtime.xterm}\n- Window shown: ${data.runtime.windowShown}\n- Mode: ${result.mode ?? "failed"}\n- Measured frame interval / estimated refresh: ${frame ? `${frame.toFixed(2)} ms / ${(1000 / frame).toFixed(1)} Hz` : "unavailable"}\n- Software proxy p50/p95/p99: ${result.latency ? `${result.latency.p50.toFixed(2)} / ${result.latency.p95.toFixed(2)} / ${result.latency.p99.toFixed(2)} ms` : "unavailable"}\n- Threshold p50/p95/p99: ${latencyBudget ? `${latencyBudget.p50.toFixed(2)} / ${latencyBudget.p95.toFixed(2)} / ${latencyBudget.p99.toFixed(2)} ms` : "unavailable"}\n- Interactive p95 with 7 output-producing peers: ${result.underLoad ? `${result.underLoad.p95.toFixed(2)} ms (threshold 35 ms)` : "unavailable"}\n- Throughput: ${result.throughput ? `${(result.throughput.bytesSent / 1024 / 1024).toFixed(1)} MiB, ${result.throughput.mibPerSecond.toFixed(1)} MiB/s, loss ${result.throughput.byteLoss}, max rAF gap ${result.throughput.maxAnimationFrameGapMs.toFixed(1)} ms` : "unavailable"}\n- Resize storm: ${result.resize ? `${result.resize.acknowledged}/${result.resize.sent}, daemon ${result.resize.daemonRows}x${result.resize.daemonCols}, renderer ${result.resize.rendererRows}x${result.resize.rendererCols}, match ${result.resize.matches}` : "unavailable"}\n- Physical pixel measurement: ${data.physicalPixelLatencyMeasured ? "yes" : "no — required before final GO"}\n- Fatal: ${fatal ?? "none"}\n\n## Renderer construction and initial-write matrix\n\n\`\`\`json\n${JSON.stringify(result.matrix ?? [], null, 2)}\n\`\`\`\n\nPROVISIONAL-GO permits S0 infrastructure work, not final runtime-stack sign-off. Three named reference-host runs and physical-pixel evidence remain required.\n`;
await writeFile(output, report);
console.log(output);
