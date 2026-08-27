import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") {
  throw new Error("the Ghostty native host can only be built on macOS");
}

const scriptPath = fileURLToPath(import.meta.url);
const hostDir = path.dirname(scriptPath);
const desktopDir = path.resolve(hostDir, "..", "..");
const repositoryDir = path.resolve(desktopDir, "..", "..");
const ghosttyDir = path.join(repositoryDir, "vendor", "ghostty");
const ghosttyHeader = path.join(ghosttyDir, "include", "ghostty.h");
const dylib = path.join(ghosttyDir, "zig-out", "lib", "libghostty.dylib");
const resources = path.join(ghosttyDir, "zig-out", "share", "ghostty");
const addon = path.join(hostDir, "build", "Release", "ghostty_host.node");
const stamp = path.join(hostDir, "build", ".termloop-ghostty-dev.json");
const packageJson = JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8"));
const electronVersion = packageJson.devDependencies.electron;
const nativeArch = process.arch === "x64" ? "x86_64" : process.arch;
const nodeGyp = path.join(desktopDir, "node_modules", ".bin", "node-gyp");

function execute(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? `: ${(result.stderr || result.stdout).trim()}` : "";
    throw new Error(`${command} exited with status ${String(result.status)}${detail}`);
  }
  return capture ? result.stdout.trim() : "";
}

function collectFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const candidate = path.join(directory, entry.name);
      return entry.isDirectory() ? collectFiles(candidate) : [candidate];
    })
    .sort();
}

function hashInputs(values, files) {
  const hash = createHash("sha256");
  for (const value of values) hash.update(value).update("\0");
  for (const file of files) {
    hash.update(path.relative(repositoryDir, file)).update("\0");
    hash.update(readFileSync(file)).update("\0");
  }
  return hash.digest("hex");
}

function hasArchitecture(file) {
  if (!existsSync(file)) return false;
  const result = spawnSync("lipo", [file, "-verify_arch", nativeArch], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

const expectedGhosttyCommit = execute(
  "git",
  ["rev-parse", "HEAD:vendor/ghostty"],
  repositoryDir,
  true,
);
if (!existsSync(ghosttyHeader)) {
  console.log("Initializing the pinned Ghostty submodule...");
  execute(
    "git",
    ["submodule", "update", "--init", "--depth", "1", "--", "vendor/ghostty"],
    repositoryDir,
  );
}
if (!existsSync(ghosttyHeader)) {
  throw new Error("the pinned Ghostty submodule is unavailable after initialization");
}

const actualGhosttyCommit = execute("git", ["rev-parse", "HEAD"], ghosttyDir, true);
if (actualGhosttyCommit !== expectedGhosttyCommit) {
  throw new Error(
    `vendor/ghostty is at ${actualGhosttyCommit}, expected ${expectedGhosttyCommit}; `
      + "resolve the submodule checkout before launching TermLoop",
  );
}

const zigVersion = execute("zig", ["version"], repositoryDir, true);
if (zigVersion !== "0.15.2") {
  throw new Error(`Ghostty requires Zig 0.15.2, found ${zigVersion}`);
}
if (!existsSync(nodeGyp)) {
  throw new Error("the pinned node-gyp dependency is unavailable; run pnpm install");
}
const nodeGypVersion = execute(nodeGyp, ["--version"], hostDir, true);
const xcodeVersion = execute("xcodebuild", ["-version"], repositoryDir, true);
const ghosttyDiff = execute("git", ["diff", "--binary", "HEAD", "--"], ghosttyDir, true);
const fingerprint = hashInputs(
  [
    expectedGhosttyCommit,
    ghosttyDiff,
    process.arch,
    electronVersion,
    zigVersion,
    nodeGypVersion,
    xcodeVersion,
  ],
  [
    scriptPath,
    path.join(hostDir, "binding.gyp"),
    ...collectFiles(path.join(hostDir, "src")),
  ],
);

let previousFingerprint;
try {
  previousFingerprint = JSON.parse(readFileSync(stamp, "utf8")).fingerprint;
} catch {
  previousFingerprint = undefined;
}
if (
  previousFingerprint === fingerprint
  && hasArchitecture(addon)
  && hasArchitecture(dylib)
  && existsSync(resources)
) {
  console.log(`Ghostty native host is current (${process.arch}).`);
  process.exit(0);
}

console.log(`Building Ghostty native host for Electron ${electronVersion} (${process.arch})...`);
execute(
  "zig",
  [
    "build",
    "-Demit-xcframework",
    "-Demit-macos-app=false",
    "-Dxcframework-target=native",
    "-Doptimize=ReleaseFast",
  ],
  ghosttyDir,
);
execute(
  nodeGyp,
  [
    "rebuild",
    `--arch=${process.arch}`,
    `--target=${electronVersion}`,
    "--dist-url=https://electronjs.org/headers",
  ],
  hostDir,
);
if (!hasArchitecture(addon) || !hasArchitecture(dylib) || !existsSync(resources)) {
  throw new Error("Ghostty native build completed without the required runtime artifacts");
}
mkdirSync(path.dirname(stamp), { recursive: true });
writeFileSync(stamp, `${JSON.stringify({ fingerprint }, null, 2)}\n`, { mode: 0o600 });
console.log(`Ghostty native host is ready (${process.arch}).`);
