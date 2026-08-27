import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function readJsonVersion(relative) {
  const raw = await readFile(path.join(repoRoot, relative), "utf8");
  const { version } = JSON.parse(raw);
  return typeof version === "string" ? version : undefined;
}

async function readCargoWorkspaceVersion(relative) {
  const raw = await readFile(path.join(repoRoot, relative), "utf8");
  let inWorkspacePackage = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inWorkspacePackage = trimmed === "[workspace.package]";
      continue;
    }
    if (!inWorkspacePackage) continue;
    const match = trimmed.match(/^version\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  }
  return undefined;
}

const canonical = await readJsonVersion("package.json");
if (!canonical) {
  console.error("VERSION_SYNC: package.json: missing canonical version");
  process.exit(1);
}

const checks = [
  ["Cargo.toml", await readCargoWorkspaceVersion("Cargo.toml")],
  ["clients/desktop/package.json", await readJsonVersion("clients/desktop/package.json")],
  ["clients/cli/package.json", await readJsonVersion("clients/cli/package.json")],
  ["contract/generated/typescript/package.json", await readJsonVersion("contract/generated/typescript/package.json")],
];

const errors = checks.filter(([, version]) => version !== canonical);
if (errors.length) {
  for (const [file, version] of errors) {
    console.error(`VERSION_SYNC: ${file}: ${version ?? "missing"} (expected ${canonical})`);
  }
  process.exit(1);
}
console.log(`VERSION_SYNC_OK ${canonical}`);
