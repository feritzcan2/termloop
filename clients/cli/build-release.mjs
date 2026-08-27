import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const outputArgument = process.argv.find((argument) => argument.startsWith("--outfile="));
if (!outputArgument) {
  throw new Error("usage: node build-release.mjs --outfile=<path>");
}

const outfile = resolve(outputArgument.slice("--outfile=".length));
await mkdir(dirname(outfile), { recursive: true });
await build({
  entryPoints: [resolve("src/index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
await chmod(outfile, 0o755);
