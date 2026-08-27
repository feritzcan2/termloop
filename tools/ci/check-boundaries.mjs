import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { scan } from "./boundary-rules.mjs";

const ignored = new Set([".git", "node_modules", "target", "dist", "docs"]);
const rootArgument = process.argv.indexOf("--root");
const workspaceRoot = rootArgument >= 0 ? path.resolve(process.argv[rootArgument + 1]) : process.cwd();
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
const roots = ["modules", "apps", "clients", "contract/generated"].map((root) => path.join(workspaceRoot, root));
for (const file of (await Promise.all(roots.map(async (root) => { try { return await walk(root); } catch { return []; } }))).flat()) {
  const normalized = path.relative(workspaceRoot, file).replaceAll(path.sep, "/");
  if (!/\.(rs|tsx?|js|mjs)$/.test(normalized)) continue;
  const content = await readFile(file, "utf8");
  errors.push(...scan(normalized, content));
}
if (errors.length) { for (const error of errors) console.error(`${error.id}: ${error.file}: ${error.message}`); process.exit(1); }
console.log("BOUNDARIES_OK");
