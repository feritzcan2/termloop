import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const routes = new Map([["/", "index.html"], ["/src/releases.mjs", "src/releases.mjs"]]);
createServer(async (req, res) => {
  const file = routes.get(new URL(req.url, "http://localhost").pathname);
  if (!file) { res.writeHead(404).end("Not found"); return; }
  try {
    res.setHeader("Content-Type", file.endsWith(".mjs") ? "text/javascript" : "text/html");
    res.end(await readFile(new URL(file, import.meta.url)));
  } catch { res.writeHead(500).end("Unable to load demo"); }
}).listen(4173, "127.0.0.1", () => console.log("Launchpad demo ready at http://localhost:4173"));
