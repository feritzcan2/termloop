import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const discovery = path.resolve("artifacts/evidence/r0/runtime.json");
const executable = path.resolve("target/debug", process.platform === "win32" ? "termloop-r0-server.exe" : "termloop-r0-server");
await mkdir(path.dirname(discovery), { recursive: true });
await rm(discovery, { force: true });
const build = spawnSync("cargo", ["build", "-p", "termloop-r0-server"], { stdio: "inherit" });
if (build.status !== 0 || !existsSync(executable)) process.exit(build.status ?? 1);
const server = spawn(executable, [], { env: { ...process.env, TERMLOOP_R0_DISCOVERY: discovery }, stdio: ["ignore", "pipe", "pipe"] });
let stderr = ""; server.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

async function wait() {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { JSON.parse(await readFile(discovery, "utf8")); return; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  throw new Error(`R0 server discovery timeout: ${stderr}`);
}

try {
  await wait();
  const full = process.argv.includes("--full");
  const shown = process.argv.includes("--shown");
  const benchmark = spawnSync("pnpm", ["--filter", "@termloop/r0-terminal", "benchmark"], {
    env: { ...process.env, TERMLOOP_R0_DISCOVERY: discovery, TERMLOOP_R0_FULL: full ? "1" : "0", TERMLOOP_R0_HEADLESS: shown ? "0" : "1" },
    encoding: "utf8", timeout: process.platform === "win32" ? 240000 : 120000, shell: process.platform === "win32"
  });
  process.stdout.write(benchmark.stdout ?? ""); process.stderr.write(benchmark.stderr ?? "");
  if (benchmark.error) console.error(`R0 benchmark failed to launch: ${benchmark.error.message}`);
  if (benchmark.status !== 0) process.exitCode = benchmark.status ?? 1;
} finally {
  server.kill("SIGTERM");
}
if (!process.exitCode) {
  const report = spawnSync("node", ["spikes/r0-terminal/report.mjs"], { stdio: "inherit" });
  process.exitCode = report.status ?? 1;
}
