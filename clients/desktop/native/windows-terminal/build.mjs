import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const directory = path.dirname(fileURLToPath(import.meta.url));
const version = "1.24.11911.0";
const hashes = {
  x64: "7691efeb71c8dd0b95536c84e366fa4cf809a42c534912f9cefa1056534383bd",
  arm64: "d794a881d4b4e151d79366fac85d1cbe7e21e90fa69f4157796377c13f1ea844",
};

export async function buildWindowsTerminal() {
  if (process.platform !== "win32") return;
  const arch = process.env.npm_config_arch ?? process.arch;
  if (!hashes[arch]) throw new Error(`Windows Terminal build does not support ${arch}`);
  const output = path.join(directory, "build/Release");
  const electron = require("electron/package.json").version;
  const inputs = ["build.mjs", "binding.gyp", "host.cpp", "paste-mode.hpp", "snapshot.cpp", "snapshot.hpp", "test-driver.cpp"];
  const hash = createHash("sha256").update(JSON.stringify({ version, arch, electron }));
  for (const file of inputs) hash.update(await readFile(path.join(directory, file)));
  const fingerprint = hash.digest("hex");
  const previous = await readFile(path.join(output, "engine.json"), "utf8").then(JSON.parse).catch(() => undefined);
  const artifacts = ["windows_terminal.node", "windows_terminal_test.node", "Microsoft.Terminal.Control.dll", "CascadiaMono.ttf", "Windows-Terminal-NOTICE.html"];
  if (previous?.fingerprint === fingerprint && await Promise.all(artifacts.map(file => access(path.join(output, file)).then(() => true, () => false))).then(results => results.every(Boolean))) return;
  const cache = path.resolve(directory, "../../../../target/windows-terminal/vendor");
  await mkdir(cache, { recursive: true });
  const archive = path.join(cache, `terminal-${version}-${arch}.zip`);
  let bytes = await readFile(archive).catch(() => undefined);
  if (!bytes || createHash("sha256").update(bytes).digest("hex") !== hashes[arch]) {
    const url = `https://github.com/microsoft/terminal/releases/download/v${version}/Microsoft.WindowsTerminal_${version}_${arch}.zip`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Windows Terminal download: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== hashes[arch]) throw new Error("Windows Terminal checksum mismatch");
    await writeFile(archive, bytes);
  }
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Expand-Archive -LiteralPath $env:TERMLOOP_WT_ARCHIVE -DestinationPath $env:TERMLOOP_WT_VENDOR -Force"], {
    TERMLOOP_WT_ARCHIVE: archive, TERMLOOP_WT_VENDOR: cache,
  });
  run(process.execPath, [require.resolve("node-gyp/bin/node-gyp.js"), "rebuild",
    `--directory=${directory}`, `--target=${electron}`, "--dist-url=https://electronjs.org/headers", `--arch=${arch}`]);
  await mkdir(output, { recursive: true });
  const vendor = path.join(cache, `terminal-${version}`);
  await cp(path.join(vendor, "Microsoft.Terminal.Control.dll"), path.join(output, "Microsoft.Terminal.Control.dll"));
  await cp(path.join(vendor, "CascadiaMono.ttf"), path.join(output, "CascadiaMono.ttf"));
  // The official portable release includes the license and third-party notices.
  await cp(path.join(vendor, "NOTICE.html"), path.join(output, "Windows-Terminal-NOTICE.html"));
  await writeFile(path.join(output, "engine.json"), JSON.stringify({ version, arch, electron, fingerprint, sha256: hashes[arch] }) + "\n");
}

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd: directory, env: { ...process.env, ...extraEnv }, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildWindowsTerminal();
