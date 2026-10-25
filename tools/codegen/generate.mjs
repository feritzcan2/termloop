import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadContractModel } from "./model.mjs";
import { controlTarget } from "./target-control.mjs";
import { pmTarget } from "./target-pm.mjs";

// Each contract target is one schema (plus companion schemas) and the Rust and
// TypeScript sources generated from it. `--check` reports drift in every target.
const targets = [controlTarget, pmTarget];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputs = [];
for (const target of targets) {
  outputs.push(...target.render(await loadContractModel(root, target)));
}

let drift = false;
for (const [relative, content] of outputs) {
  const output = path.join(root, relative);
  let existing = "";
  try {
    existing = await readFile(output, "utf8");
  } catch {}
  if (process.argv.includes("--check")) {
    if (existing !== content) {
      console.error(`generated drift: ${relative}`);
      drift = true;
    }
  } else if (existing !== content) {
    // Only write on a real change. Rewriting byte-identical output still moves
    // the file's mtime, and these outputs sit at the base of the crate graph, so
    // an unconditional write makes Cargo rebuild the entire workspace after
    // every codegen run.
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, content);
  }
}
if (drift) process.exit(1);
