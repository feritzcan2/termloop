import { rm as removeGeneratedDirectory } from "node:fs/promises";
if (process.argv.includes("--clean")) { await removeGeneratedDirectory("dist", {recursive:true, force:true}); process.exit(0); }
import { cp, mkdir, access, writeFile } from "node:fs/promises";
await mkdir("dist/native", { recursive: true });
await cp("native/src/ghostty_host.mm", "dist/native/ghostty_host.mm");
await cp("assets/ghostty-embedded.conf", "dist/ghostty-embedded.conf");
await cp("assets/ghostty-light.conf", "dist/ghostty-light.conf");
const available = await access("native/build/Release/ghostty_host.node").then(() => true, () => false);
if (available) {
  await cp("native/build/Release/ghostty_host.node", "dist/native/ghostty_host.node");
  await cp("../../vendor/ghostty/zig-out/lib/libghostty.dylib", "dist/native/libghostty.dylib");
  await cp("../../vendor/ghostty/zig-out/share/ghostty", "dist/ghostty", { recursive: true });
  await writeFile("dist/ghostty/engine-resources.json", JSON.stringify({format: 1}));
}

await cp("../../LICENSE", "dist/LICENSE");
if (available) await cp("../../vendor/ghostty/LICENSE", "dist/Ghostty-LICENSE");
