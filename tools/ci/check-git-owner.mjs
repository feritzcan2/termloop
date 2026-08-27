import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { rules } from "./boundary-rules.mjs";

const rule = rules.find(({ id }) => id === "GIT_SUBPROCESS_OWNER");
if (!rule) throw new Error("GIT_SUBPROCESS_OWNER rule is missing");

const ignored = new Set([".git", "node_modules", "target", "dist", "docs"]);
async function walk(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walk(full));
    else found.push(full);
  }
  return found;
}

const errors = [];
for (const root of ["modules", "apps", "clients", "contract/generated"]) {
  for (const file of await walk(root)) {
    const normalized = file.replaceAll(path.sep, "/");
    if (!rule.applies(normalized)) continue;
    const content = await readFile(file, "utf8");
    if (rule.pattern.test(content)) errors.push(normalized);
  }
}

if (errors.length) {
  for (const file of errors) console.error(`GIT_SUBPROCESS_OWNER: ${file}: ${rule.message}`);
  process.exit(1);
}
console.log("GIT_OWNER_OK");
