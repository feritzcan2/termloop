import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const next = process.argv[2];
if (!next || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(next)) {
  console.error("usage: node tools/release/set-version.mjs <semver>");
  process.exit(1);
}

const jsonFiles = [
  "package.json",
  "clients/desktop/package.json",
  "clients/cli/package.json",
  "contract/generated/typescript/package.json",
];

async function setJsonVersion(relative) {
  const absolute = path.join(repoRoot, relative);
  const raw = await readFile(absolute, "utf8");
  const updated = raw.replace(/^(\s*"version"\s*:\s*)"[^"]+"/m, `$1"${next}"`);
  if (updated === raw && !raw.includes(`"version": "${next}"`)) {
    throw new Error(`${relative}: no version field found`);
  }
  await writeFile(absolute, updated);
}

async function setCargoWorkspaceVersion(relative) {
  const absolute = path.join(repoRoot, relative);
  const raw = await readFile(absolute, "utf8");
  const lines = raw.split("\n");
  let inWorkspacePackage = false;
  let replaced = false;
  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inWorkspacePackage = trimmed === "[workspace.package]";
      return line;
    }
    if (inWorkspacePackage && !replaced && /^version\s*=\s*"[^"]+"/.test(trimmed)) {
      replaced = true;
      return line.replace(/version\s*=\s*"[^"]+"/, `version = "${next}"`);
    }
    return line;
  });
  if (!replaced) throw new Error(`${relative}: [workspace.package] version not found`);
  await writeFile(absolute, updated.join("\n"));
}

for (const file of jsonFiles) await setJsonVersion(file);
await setCargoWorkspaceVersion("Cargo.toml");

const cargoLockSync = spawnSync("cargo", ["update", "--workspace", "--offline"], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (cargoLockSync.status !== 0) {
  console.warn("set-version: cargo lockfile sync failed; run `cargo update --workspace` manually");
}

const verify = spawnSync(process.execPath, ["tools/release/check-version-sync.mjs"], {
  cwd: repoRoot,
  stdio: "inherit",
});
process.exit(verify.status ?? 1);
