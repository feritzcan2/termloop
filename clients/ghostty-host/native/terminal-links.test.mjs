import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { findGhosttySdk } from "./macos-sdk.mjs";

test("terminal web links open locally without sending clicks to a mouse-capturing PTY", {
  skip: process.platform !== "darwin", timeout: 300_000,
}, () => {
  const host = path.dirname(fileURLToPath(import.meta.url));
  const vendor = path.resolve(host, "../../../vendor/ghostty");
  execFileSync(process.execPath, [path.join(host, "build-dev.mjs")], { stdio: "pipe" });
  const directory = mkdtempSync(path.join(tmpdir(), "termloop-terminal-links-"));
  try {
    const binary = path.join(directory, "terminal-links");
    const library = path.join(vendor, "zig-out/lib");
    execFileSync("xcrun", ["clang++", "-std=c++17", "-fobjc-arc", "-isysroot", findGhosttySdk(),
      "-framework", "AppKit", "-I", path.join(vendor, "include"), path.join(host, "terminal-links.mm"),
      "-L", library, "-lghostty", `-Wl,-rpath,${library}`, "-o", binary], { stdio: "pipe" });
    const result = spawnSync(binary, [], { encoding: "utf8", timeout: 30_000,
      env: { ...process.env, GHOSTTY_RESOURCES_DIR: path.join(vendor, "zig-out/share/ghostty") } });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
