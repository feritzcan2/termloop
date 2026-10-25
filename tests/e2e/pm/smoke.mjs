// PM daemon smoke: start termloop-pm-daemon on private temporary directories,
// read its discovery file, and drive the planning flow through the generated
// @termloop/pm-contract client, which validates every result.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const { TermLoopPmClient } = await import(join(root, "contract/generated/pm-typescript/dist/pm.js"));
const cargoTargetDirectory = resolve(root, process.env.CARGO_TARGET_DIR ?? "target");
const binary = join(cargoTargetDirectory, "debug", process.platform === "win32" ? "termloop-pm-daemon.exe" : "termloop-pm-daemon");

const scratch = mkdtempSync(join(tmpdir(), "termloop-pm-smoke-"));
const daemon = spawn(binary, [], {
  env: {
    ...process.env,
    TERMLOOP_RUNTIME_DIR: join(scratch, "runtime"),
    TERMLOOP_STATE_DIR: join(scratch, "state"),
    RUST_LOG: "warn",
  },
  stdio: ["ignore", "pipe", "inherit"],
});

function fail(message) {
  console.error(`pm-smoke: FAIL ${message}`);
  process.exitCode = 1;
}

async function discoveryPath() {
  const lines = createInterface({ input: daemon.stdout });
  const timeout = setTimeout(() => daemon.kill(), 20_000);
  try {
    for await (const line of lines) {
      if (line.trim().endsWith("discovery.json")) return line.trim();
    }
  } finally {
    clearTimeout(timeout);
  }
  throw new Error("the daemon exited before writing its discovery file");
}

try {
  const path = await discoveryPath();
  const discovery = JSON.parse(readFileSync(path, "utf8"));
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
    fail("the discovery file is readable by other users");
  }
  console.log(`pm-smoke: discovery ${JSON.stringify({ ...discovery, token: "<redacted>" })}`);

  const client = new TermLoopPmClient(discovery.controlUrl, discovery.token, (url) => new WebSocket(url));
  const version = await client.call("pm_system_version", {});
  console.log(`pm-smoke: pm_system_version ${JSON.stringify(version)}`);

  const project = await client.call("pm_project_create", { name: "Smoke shop" });
  console.log(`pm-smoke: pm_project_create ${project.id}`);
  const sprint = await client.call("pm_sprint_create", { projectId: project.id, name: "Sprint 1", goal: "Ship checkout" });
  console.log(`pm-smoke: pm_sprint_create ${sprint.id} state=${sprint.state}`);
  const ticket = await client.call("pm_ticket_create", { projectId: project.id, title: "Checkout button", sprintId: sprint.id });
  console.log(`pm-smoke: pm_ticket_create ${ticket.id} status=${ticket.status}`);
  const board = await client.call("pm_board_read", { projectId: project.id });
  console.log(`pm-smoke: pm_board_read sprints=${board.sprints.length} tickets=${board.tickets.length}`);
  if (board.sprints.length !== 1 || board.tickets.length !== 1 || board.tickets[0].ticket.id !== ticket.id) {
    fail("the board does not show the created sprint and ticket");
  }

  const rejected = new TermLoopPmClient(discovery.controlUrl, "0".repeat(64), (url) => new WebSocket(url));
  try {
    await rejected.call("pm_system_version", {});
    fail("a wrong bearer was accepted");
  } catch (error) {
    console.log(`pm-smoke: wrong bearer rejected code=${error.code}`);
    if (error.code !== "unauthenticated") fail(`expected unauthenticated, got ${error.code}`);
  }
  client.close?.();
  rejected.close?.();
  if (!process.exitCode) console.log("pm-smoke: PASS");
} catch (error) {
  fail(error?.stack ?? String(error));
} finally {
  daemon.kill("SIGTERM");
  await new Promise((done) => {
    if (daemon.exitCode !== null) return done();
    daemon.once("exit", done);
    setTimeout(done, 5_000);
  });
  rmSync(scratch, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
