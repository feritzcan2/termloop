import { rm as removeGeneratedDirectory } from "node:fs/promises";
if (process.argv.includes("--clean")) { await removeGeneratedDirectory("dist", {recursive:true, force:true}); process.exit(0); }
import { cp } from "node:fs/promises";
await cp("src/assets", "dist/assets", { recursive: true });
await cp("src/renderer/terminal/xterm/ghostty-font.css", "dist/renderer/terminal/xterm/ghostty-font.css");

await cp("../../LICENSE", "dist/LICENSE");
