import { build } from "esbuild";
import { cp, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
const checkout = await realpath(path.resolve(packageDirectory, "../.."));
const gitMarker = await stat(path.join(checkout, ".git")).catch(() => undefined);
const compiledDevelopmentProfile = gitMarker?.isFile() ? developmentProfileId(checkout) : undefined;
const mainDefines = {
  TERMLOOP_COMPILED_DEV_PROFILE: JSON.stringify(compiledDevelopmentProfile ?? null),
};
const esmRequireBanner = `import { createRequire as __termloopCreateRequire } from "node:module";
const require = __termloopCreateRequire(import.meta.url);`;

await mkdir("dist", { recursive: true });
await Promise.all([
  build({ entryPoints: ["src/main.ts"], outfile: "dist/main.js", bundle: true, platform: "node", format: "esm", external: ["electron", "ws"], define: mainDefines, banner: { js: esmRequireBanner } }),
  build({ entryPoints: ["src/preload.ts"], outfile: "dist/preload.cjs", bundle: true, platform: "node", format: "cjs", external: ["electron"] }),
  build({ entryPoints: ["src/utility/terminal-gateway.ts"], outfile: "dist/terminal-gateway.js", bundle: true, platform: "node", format: "esm", external: ["electron", "ws"] }),
  build({ entryPoints: ["src/renderer/index.tsx"], outfile: "dist/renderer.js", bundle: true, platform: "browser", format: "esm", jsx: "automatic", loader: { ".css": "css", ".ttf": "file" }, assetNames: "[name]" }),
  cp("src/index.html", "dist/index.html"),
  cp(path.join(checkout, "resources/prompts"), "dist/prompts", { recursive: true }),
  cp("src/assets/termloop-main-icon.png", "dist/termloop-main-icon.png"),
  cp("src/assets/ghostty-embedded.conf", "dist/ghostty-embedded.conf"),
  cp("src/assets/fonts/OFL.txt", "dist/JetBrainsMono-OFL.txt")
]);

function developmentProfileId(checkoutPath) {
  const label = path.basename(checkoutPath)
    .replace(/[^\x00-\x7F]/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "") || "checkout";
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(checkoutPath)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return `${label}-${hash.toString(16).padStart(16, "0")}`;
}
