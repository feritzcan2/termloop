import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { selectCompatibleSdk, withGhosttySdk } from "./macos-sdk.mjs";

const temporary = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sdk(targets) {
  const directory = mkdtempSync(path.join(tmpdir(), "termloop-sdk-test-"));
  temporary.push(directory);
  mkdirSync(path.join(directory, "usr/lib"), { recursive: true });
  writeFileSync(path.join(directory, "usr/lib/libSystem.tbd"), `targets: [ ${targets} ]\n`);
  return directory;
}

test("selects an installed SDK with both universal architectures and rejects arm64e-only stubs", () => {
  const incompatible = sdk("x86_64-macos, arm64e-macos");
  const compatible = sdk("x86_64-macos, arm64-macos, arm64e-macos");
  assert.equal(selectCompatibleSdk([incompatible, compatible]), compatible);
  assert.throws(() => selectCompatibleSdk([incompatible]), /arm64-macos/);
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
