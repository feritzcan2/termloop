import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { evaluateCompatibility } from "./contract-compat.mjs";

// Fails when the working-tree control schema breaks wire compatibility with a
// released baseline without bumping `x-contract-major`. The baseline is the
// newest reachable release tag unless `--base=<git-ref>` or
// TERMLOOP_CONTRACT_BASE names another ref.
const SCHEMA = "contract/schema/control.current.schema.json";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const explicit = process.argv.find((arg) => arg.startsWith("--base="))?.slice("--base=".length) || process.env.TERMLOOP_CONTRACT_BASE;
let base = explicit;
if (!base) {
  try {
    base = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "HEAD");
  } catch {
    console.error("contract compat: no release tag is reachable from HEAD; fetch tags (git fetch --tags) or pass --base=<git-ref>");
    process.exit(1);
  }
}

let baseSchema;
try {
  baseSchema = JSON.parse(git("show", `${base}:${SCHEMA}`));
} catch (error) {
  console.error(`contract compat: cannot read ${SCHEMA} at ${base}: ${error.stderr?.toString().trim() || error.message}`);
  process.exit(1);
}
const headSchema = JSON.parse(await readFile(path.join(root, SCHEMA), "utf8"));
const result = evaluateCompatibility(baseSchema, headSchema);
const verbose = process.argv.includes("--verbose");

console.log(`contract compat vs ${base}: ${result.reason} (${result.additive.length} additive, ${result.breaking.length} breaking)`);
if (verbose) for (const change of result.additive) console.log(`  + ${change.path}: ${change.message}`);
if (!result.ok || verbose) for (const change of result.breaking) console.log(`  ! ${change.path}: ${change.message}`);
if (!result.ok) {
  console.error("Make the change additive (new fields optional, keep existing fields, methods, and enum values),");
  console.error(`or bump "x-contract-major" in ${SCHEMA} to knowingly break older peers.`);
  process.exit(1);
}
