import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findGhosttySdk } from "./macos-sdk.mjs";

test("external IO starts with the native VT grid at 1x/2x before any resize; fallback and PTY defaults stay intact", {
  skip: process.platform !== "darwin" ? "AppKit surface creation requires macOS" : false,
  timeout: 300_000,
}, () => {
  const host = path.dirname(fileURLToPath(import.meta.url));
  const desktop = path.resolve(host, "..");
  const vendor = path.resolve(desktop, "../../vendor/ghostty");
  execFileSync(process.execPath, [path.join(host, "build-dev.mjs")], { cwd: desktop, stdio: "pipe" });
  const temporary = mkdtempSync(path.join(tmpdir(), "termloop-initial-size-"));
  try {
    const binary = path.join(temporary, "initial-size");
    const library = path.join(vendor, "zig-out/lib");
    execFileSync("clang", [
      "-fobjc-arc", "-isysroot", findGhosttySdk(), "-framework", "Cocoa",
      "-I", path.join(vendor, "include"), path.join(host, "initial-size.m"),
      "-L", library, "-lghostty", `-Wl,-rpath,${library}`, "-o", binary,
    ], { stdio: "pipe" });
    const result = spawnSync(binary, [], {
      encoding: "utf8", timeout: 30_000,
      env: { ...process.env, GHOSTTY_RESOURCES_DIR: path.join(vendor, "zig-out/share/ghostty") },
    });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
