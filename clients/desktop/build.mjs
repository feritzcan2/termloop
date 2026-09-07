import { build } from "esbuild";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageManifest = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8"));
const gatewaySequence = releaseSequence(packageManifest.version);
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
  cp("src/assets/ghostty-light.conf", "dist/ghostty-light.conf"),
  cp("src/assets/fonts/OFL.txt", "dist/JetBrainsMono-OFL.txt")
]);

const mobileAccessDirectory = path.join(packageDirectory, "dist/mobile-access");
const mobileScriptsDirectory = path.join(checkout, "clients/mobile/scripts");
await mkdir(mobileAccessDirectory, { recursive: true });
await Promise.all([
  cp(path.join(mobileScriptsDirectory, "mobile-access.mjs"), path.join(mobileAccessDirectory, "mobile-access.mjs")),
  cp(path.join(mobileScriptsDirectory, "mobile-access-installer.mjs"), path.join(mobileAccessDirectory, "mobile-access-installer.mjs")),
]);
await execFile(process.execPath, [
  path.join(mobileScriptsDirectory, "mobile-access.mjs"),
  "--build-artifact",
  "--artifact-dir", mobileAccessDirectory,
  "--channel", "production",
  "--owner", "ai.termloop.desktop",
  "--sequence", String(gatewaySequence),
  "--release-version", packageManifest.version,
], { cwd: path.join(checkout, "clients/mobile") });

function releaseSequence(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Desktop version ${version} cannot produce a monotonic gateway sequence.`);
  return (Number(match[1]) * 1_000_000) + (Number(match[2]) * 1_000) + Number(match[3]);
}

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
