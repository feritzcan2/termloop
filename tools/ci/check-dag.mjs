import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { allowedRust, findCycle, validateEdge } from "./dag-rules.mjs";

const metadataArgument = process.argv.indexOf("--metadata");
const metadata = metadataArgument >= 0
  ? JSON.parse(await readFile(process.argv[metadataArgument + 1], "utf8"))
  : JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], { encoding: "utf8" }));
const errors = [];
const actual = new Set(metadata.packages.map((pkg) => pkg.name));
for (const expected of allowedRust.keys()) if (!actual.has(expected)) errors.push(`DAG_MISSING_MODULE: ${expected}`);
for (const name of actual) if (name.startsWith("termloop-") && !allowedRust.has(name)) errors.push(`DAG_UNKNOWN_MODULE: ${name}`);
const graph = new Map();
for (const pkg of metadata.packages) {
  graph.set(pkg.name, pkg.dependencies.filter((dep) => actual.has(dep.name)).map((dep) => dep.name));
  for (const dep of pkg.dependencies) {
    const error = validateEdge(pkg.name, dep.name);
    if (error) errors.push(error);
  }
}
const cycle = findCycle(graph);
if (cycle) errors.push(`DAG_CYCLE: ${cycle.join(" -> ")}`);

const packagePaths = ["contract/generated/typescript", "clients/cli", "clients/desktop", "spikes/r0-terminal/desktop"];
for (const packagePath of process.argv.includes("--rust-only") ? [] : packagePaths) {
  const manifest = JSON.parse(await readFile(path.join(packagePath, "package.json"), "utf8"));
  const internal = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((name) => name.startsWith("@termloop/"));
  if (manifest.name !== "@termloop/contract" && !manifest.name.includes("r0") && internal.some((name) => name !== "@termloop/contract")) {
    errors.push(`DAG_FORBIDDEN_JS_EDGE: ${manifest.name} -> ${internal.join(",")}`);
  }
}

if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log(`DAG_OK: ${metadata.packages.length} Rust packages, ${packagePaths.length} JS packages`);
