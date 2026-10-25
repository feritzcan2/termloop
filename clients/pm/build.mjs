import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const esmRequireBanner = `import { createRequire as __termloopCreateRequire } from "node:module";
const require = __termloopCreateRequire(import.meta.url);`;

await mkdir("dist", { recursive: true });
await Promise.all([
  build({ entryPoints: ["src/main.ts"], outfile: "dist/main.js", bundle: true, platform: "node", format: "esm", external: ["electron", "ws"], banner: { js: esmRequireBanner } }),
  build({ entryPoints: ["src/preload.ts"], outfile: "dist/preload.cjs", bundle: true, platform: "node", format: "cjs", external: ["electron"] }),
  build({ entryPoints: { renderer: "src/renderer/index.tsx" }, outdir: "dist", bundle: true, platform: "browser", format: "esm", jsx: "automatic", loader: { ".css": "css", ".ttf": "file" }, assetNames: "[name]" }),
  cp("src/index.html", "dist/index.html"),
  cp(require.resolve("@termloop/ghostty-host/embedded-config"), "dist/ghostty-embedded.conf"),
  cp(require.resolve("@termloop/terminal-surface/font-license"), "dist/JetBrainsMono-OFL.txt"),
]);
