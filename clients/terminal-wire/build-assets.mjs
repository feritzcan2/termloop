import { rm as removeGeneratedDirectory } from "node:fs/promises";
if (process.argv.includes("--clean")) { await removeGeneratedDirectory("dist", {recursive:true, force:true}); process.exit(0); }
import { cp } from "node:fs/promises";
await cp("../../LICENSE", "dist/LICENSE");
