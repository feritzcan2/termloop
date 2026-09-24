import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const workflow = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
function script(name) {
  const step = workflow.split(`      - name: ${name}\n`)[1]?.split(/\n      - /)[0];
  assert.ok(step, `missing release step: ${name}`);
  return step.split("        run: |\n")[1].replace(/^          /gm, "");
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "termloop-release-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("Windows installer assembly does not require Unix server binaries", async (t) => {
  const root = await fixture(t);
  const out = path.join(root, "clients/desktop/out");
  await mkdir(out, { recursive: true });
  const assets = ["termloop-desktop-windows-x64-2.0.7.exe", "termloop-desktop-windows-x64-2.0.7.exe.blockmap", "latest.yml"];
  for (const asset of assets) await writeFile(path.join(out, asset), "fixture");
  const result = spawnSync("bash", ["-e", "-c", script("Assemble release assets")
    .replaceAll("${{ matrix.os }}", "windows").replaceAll("${{ matrix.arch }}", "x64")], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, RUNNER_OS: "Windows", RUNNER_TEMP: root, TERMLOOP_VERSION: "2.0.7" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual((await readdir(path.join(root, "release-assets"))).sort(), assets.sort());
});

test("update publication uploads Windows payload before any latest manifest", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "release-assets"));
  const result = spawnSync("bash", ["-e", "-c", `aws() { printf '%s\n' "$3"; }\n${script("Publish desktop update feed atomically")}`], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, TERMLOOP_RELEASE_TAG: "v2.0.7", CLOUDFLARE_ACCOUNT_ID: "fixture",
      R2_BUCKET_NAME: "termloop-updates", UPDATE_BASE_URL: "https://updates.termloop.ai/stable",
      AWS_ACCESS_KEY_ID: "fixture", AWS_SECRET_ACCESS_KEY: "fixture" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const uploads = result.stdout.trim().split("\n");
  const windows = uploads.indexOf("release-assets/termloop-desktop-windows-x64-2.0.7.exe");
  assert.ok(windows >= 0);
  for (const manifest of ["latest-mac.yml", "latest-linux.yml", "latest.yml"]) {
    assert.ok(uploads.indexOf(`release-assets/${manifest}`) > windows);
  }
});

test("publication refuses an incomplete Windows release", async (t) => {
  const root = await fixture(t);
  const assets = path.join(root, "release-assets");
  await mkdir(assets);
  for (const name of [
    "termloop-server-macos-universal-2.0.7.tar.gz", "termloop-desktop-macos-universal-2.0.7.dmg",
    "termloop-desktop-macos-universal-2.0.7.zip", "termloop-server-linux-x64-2.0.7.tar.gz",
    "termloop-desktop-linux-x86_64-2.0.7.AppImage", "termloop-desktop-linux-amd64-2.0.7.deb",
    "latest-mac.yml", "latest-linux.yml",
  ]) await writeFile(path.join(assets, name), "fixture");
  for (const missing of ["termloop-desktop-windows-x64-2.0.7.exe", "latest.yml"]) {
    const result = spawnSync("bash", ["-e", "-c", script("Verify and checksum assets")], {
      cwd: root, encoding: "utf8", env: { ...process.env, TERMLOOP_RELEASE_TAG: "v2.0.7" },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stderr.includes(`missing release asset: ${missing}`));
    await writeFile(path.join(assets, missing), "fixture");
  }
});
