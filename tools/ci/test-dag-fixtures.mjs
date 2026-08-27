import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { allowedRust } from "./dag-rules.mjs";

const checker = path.resolve("tools/ci/check-dag.mjs");
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-dag-fixtures-"));
const baseline = () => ({ packages: [...allowedRust.keys()].map((name) => ({ name, dependencies: [] })) });
const cases = [
  ["DAG_FORBIDDEN_EDGE", (data) => data.packages.find((value) => value.name === "termloop-core").dependencies.push({ name: "termloop-contract", kind: null })],
  ["DAG_UNKNOWN_MODULE", (data) => data.packages.push({ name: "termloop-rogue", dependencies: [] })],
  ["DAG_CYCLE", (data) => { data.packages.find((value) => value.name === "termloop-domain").dependencies.push({ name: "termloop-core", kind: null }); data.packages.find((value) => value.name === "termloop-core").dependencies.push({ name: "termloop-domain", kind: null }); }],
  ["DAG_FORBIDDEN_EDGE", (data) => data.packages.find((value) => value.name === "termloop-core").dependencies.push({ name: "termloop-contract", kind: "dev" })]
];
try {
  for (let index = 0; index < cases.length; index++) { const [expected, mutate] = cases[index]; const data = baseline(); mutate(data); const file = path.join(temporary, `${index}.json`); await writeFile(file, JSON.stringify(data)); const result = spawnSync(process.execPath, [checker, "--metadata", file, "--rust-only"], { encoding: "utf8" }); const output = `${result.stdout}\n${result.stderr}`; if (result.status === 0 || !output.includes(expected)) throw new Error(`DAG fixture ${index} did not fail with ${expected}: ${output}`); }
  console.log(`DAG_FIXTURES_OK: ${cases.length} failures through real checker`);
} finally { await rm(temporary, { recursive: true, force: true }); }
