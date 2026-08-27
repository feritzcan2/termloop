import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") {
  throw new Error("the Ghostty native host can only be built on macOS");
}

const hostDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(hostDir, "..", "..");
const repositoryDir = path.resolve(desktopDir, "..", "..");
const ghosttyDir = path.join(repositoryDir, "vendor", "ghostty");
const addon = path.join(hostDir, "build", "Release", "ghostty_host.node");
const scratch = mkdtempSync(path.join(tmpdir(), "termloop-ghostty-universal-"));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${String(result.status)}`);
  }
}

function buildAddon(arch, destination) {
  run("node-gyp", [
    "rebuild",
    `--arch=${arch}`,
    "--target=43.3.0",
    "--dist-url=https://electronjs.org/headers",
  ], hostDir);
  copyFileSync(addon, destination);
}

try {
  run("zig", [
    "build",
    "-Demit-xcframework",
    "-Demit-macos-app=false",
    "-Dxcframework-target=universal",
    "-Doptimize=ReleaseFast",
  ], ghosttyDir);

  const arm64 = path.join(scratch, "ghostty_host-arm64.node");
  const x64 = path.join(scratch, "ghostty_host-x64.node");
  buildAddon("arm64", arm64);
  buildAddon("x64", x64);
  mkdirSync(path.dirname(addon), { recursive: true });
  run("lipo", ["-create", "-output", addon, arm64, x64], hostDir);
  run("lipo", ["-info", addon], hostDir);
  run("lipo", ["-info", path.join(ghosttyDir, "zig-out", "lib", "libghostty.dylib")], hostDir);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
