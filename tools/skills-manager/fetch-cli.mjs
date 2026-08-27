#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const VERSION = "1.34.2";
const RELEASE_BASE = `https://github.com/xingkongliang/skills-manager/releases/download/v${VERSION}`;
const ASSETS = new Map([
  ["darwin-arm64", { name: "skills-manager-cli-macOS-arm64", size: 15_385_632, sha256: "7704c497d05cd756ceca44499c823692311dfb57fde644b17a08f9699f7d4ce6" }],
  ["darwin-x64", { name: "skills-manager-cli-macOS-x64", size: 16_790_896, sha256: "0c5b540e0f128273b084e3d17e46be21d4b8c8e94f80ee8f111cc662d438781f" }],
  ["linux-x64", { name: "skills-manager-cli-Linux-x64", size: 25_080_864, sha256: "cada91bf43947e762b8b47a54b31459c4c02affdf59a9d2e79f3ecd132e41132" }],
  ["win32-x64", { name: "skills-manager-cli-Windows-x64.exe", size: 12_092_416, sha256: "41969fb55d52770039256d0e45ef69011720b5584a7c62d1cdc3f0772f3ae71a" }],
]);

function argumentsOf(argv) {
  const values = { platform: process.platform, arch: process.env.TERMLOOP_SKILLS_MANAGER_ARCH || process.arch };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--output", "--platform", "--arch"].includes(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`missing value for ${flag}`);
    index += 1;
    if (flag === "--output") values.output = value;
    if (flag === "--platform") values.platform = value;
    if (flag === "--arch") values.arch = value;
  }
  if (!values.output) throw new Error("--output is required");
  if (values.platform === "win32" && !values.output.toLowerCase().endsWith(".exe")) values.output += ".exe";
  return values;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function existingDigest(file) {
  try {
    return digest(await readFile(file));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function download(asset) {
  const response = await fetch(`${RELEASE_BASE}/${asset.name}`, { redirect: "follow" });
  if (!response.ok) throw new Error(`skills-manager download failed with HTTP ${response.status}`);
  if (!response.body) throw new Error("skills-manager download returned no body");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > asset.size) throw new Error(`skills-manager download exceeded the pinned size for ${asset.name}`);
    chunks.push(Buffer.from(chunk));
  }
  if (size !== asset.size) throw new Error(`skills-manager size mismatch for ${asset.name}`);
  const bytes = Buffer.concat(chunks, size);
  const actual = digest(bytes);
  if (actual !== asset.sha256) throw new Error(`skills-manager checksum mismatch for ${asset.name}`);
  return bytes;
}

async function publish(bytes, output) {
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  await writeFile(temporary, bytes, { mode: 0o755 });
  await chmod(temporary, 0o755);
  await rm(output, { force: true });
  await rename(temporary, output);
}

async function prepareSingle(platform, arch, output) {
  const asset = ASSETS.get(`${platform}-${arch}`);
  if (!asset) throw new Error(`skills-manager has no pinned CLI for ${platform}-${arch}`);
  if (await existingDigest(output) === asset.sha256) return;
  await publish(await download(asset), output);
}

async function universalManifestIsCurrent(output, manifestPath) {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    return manifest.version === VERSION
      && manifest.arm64 === ASSETS.get("darwin-arm64").sha256
      && manifest.x64 === ASSETS.get("darwin-x64").sha256
      && manifest.output === await existingDigest(output);
  } catch {
    return false;
  }
}

async function prepareUniversalMac(output) {
  const manifestPath = `${output}.source.json`;
  if (await universalManifestIsCurrent(output, manifestPath)) return;
  const scratch = await mkdtemp(path.join(os.tmpdir(), "termloop-skills-manager-"));
  try {
    const arm64 = path.join(scratch, "skills-manager-cli-arm64");
    const x64 = path.join(scratch, "skills-manager-cli-x64");
    await publish(await download(ASSETS.get("darwin-arm64")), arm64);
    await publish(await download(ASSETS.get("darwin-x64")), x64);
    await mkdir(path.dirname(output), { recursive: true });
    const temporary = `${output}.tmp-${process.pid}`;
    execFileSync("lipo", ["-create", arm64, x64, "-output", temporary], { stdio: "inherit" });
    execFileSync("lipo", [temporary, "-verify_arch", "arm64", "x86_64"], { stdio: "inherit" });
    await chmod(temporary, 0o755);
    await rm(output, { force: true });
    await rename(temporary, output);
    await writeFile(manifestPath, `${JSON.stringify({
      version: VERSION,
      arm64: ASSETS.get("darwin-arm64").sha256,
      x64: ASSETS.get("darwin-x64").sha256,
      output: await existingDigest(output),
    })}\n`, { mode: 0o600 });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const options = argumentsOf(process.argv.slice(2));
const output = path.resolve(options.output);
if (options.arch === "universal") {
  if (options.platform !== "darwin") throw new Error("universal skills-manager CLI is macOS-only");
  await prepareUniversalMac(output);
} else {
  await prepareSingle(options.platform, options.arch, output);
}
process.stdout.write(`skills-manager-cli v${VERSION} ready\n`);
