import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.resolve(process.argv[2] ?? path.join(root, "work/engine-packages"));
await mkdir(output, { recursive: true });
function run(args, cwd = root) {
  const result = spawnSync("pnpm", args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Package command failed (${result.status}): ${args.join(" ")}`);
}
if (process.platform === "darwin") run(["--filter", "@termloop/ghostty-host", "native:dev"]);
const packages = [];
for (const name of ["terminal-wire", "terminal-surface", "ghostty-host"]) {
  const cwd = path.join(root, "clients", name);
  const manifest = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
  run(["build"], cwd);
  run(["pack", "--pack-destination", output], cwd);
  const filename = `termloop-${name}-${manifest.version}.tgz`;
  const bytes = await readFile(path.join(output, filename));
  packages.push({ name: manifest.name, version: manifest.version, filename, sha256: createHash("sha256").update(bytes).digest("hex") });
}
await writeFile(path.join(output, "engine-packages.json"), JSON.stringify({ format: 1, platform: process.platform, architecture: process.arch, electron: "43.3.0", packages }, null, 2) + "\n");
console.log(`ENGINE_PACKAGES_READY: ${output}`);
