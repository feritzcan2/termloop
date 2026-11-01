import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { findGhosttySdk, withGhosttySdk } from "./macos-sdk.mjs";

const temporary = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sdk() {
  const directory = mkdtempSync(path.join(tmpdir(), "termloop-sdk-test-"));
  temporary.push(directory);
  mkdirSync(path.join(directory, "usr/lib"), { recursive: true });
  writeFileSync(path.join(directory, "usr/lib/libSystem.tbd"), "targets: [ x86_64-macos, arm64e-macos ]\n");
  return directory;
}

test("honors an installed TERMLOOP_GHOSTTY_SDK override, including arm64e-only stubs, and rejects a missing one", () => {
  const original = process.env.TERMLOOP_GHOSTTY_SDK;
  try {
    const installed = sdk();
    process.env.TERMLOOP_GHOSTTY_SDK = installed;
    assert.equal(findGhosttySdk(), installed);
    process.env.TERMLOOP_GHOSTTY_SDK = path.join(installed, "missing");
    assert.throws(() => findGhosttySdk(), /not an installed macOS SDK/);
  } finally {
    if (original === undefined) delete process.env.TERMLOOP_GHOSTTY_SDK;
    else process.env.TERMLOOP_GHOSTTY_SDK = original;
  }
});

test("scopes SDK discovery to the child and removes the override even on failure", () => {
  const originalPath = process.env.PATH;
  const originalSdk = process.env.SDKROOT;
  let shim = "";
  assert.throws(() => withGhosttySdk("/SDK's folder/MacOSX.sdk", (env) => {
    shim = path.join(env.PATH.split(path.delimiter)[0], "xcrun");
    assert.match(readFileSync(shim, "utf8"), /exec \/usr\/bin\/xcrun/);
    assert.equal(env.SDKROOT, "/SDK's folder/MacOSX.sdk");
    assert.equal(process.env.SDKROOT, originalSdk);
    throw new Error("build failed");
  }), /build failed/);
  assert.equal(existsSync(shim), false);
  assert.equal(process.env.PATH, originalPath);
});
