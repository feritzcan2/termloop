import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await Promise.all([
  build({ entryPoints: ["src/main.ts"], outfile: "dist/main.js", bundle: true, platform: "node", format: "esm", external: ["electron"] }),
  build({ entryPoints: ["src/preload.ts"], outfile: "dist/preload.cjs", bundle: true, platform: "node", format: "cjs", external: ["electron"] }),
  build({ entryPoints: ["src/renderer.ts"], outfile: "dist/renderer.js", bundle: true, platform: "browser", format: "esm", loader: { ".css": "css" } }),
  cp("src/index.html", "dist/index.html")
]);
