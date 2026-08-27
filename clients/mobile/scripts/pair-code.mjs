import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const runtimeFile = option("--runtime") ?? defaultRuntimeFile();
const name = option("--name") ?? os.hostname();
const discovery = JSON.parse(await readFile(runtimeFile, "utf8"));
requireString(discovery.protocolVersion, "protocolVersion");
requireString(discovery.controlUrl, "controlUrl");
requireString(discovery.terminalUrl, "terminalUrl");
requireString(discovery.readOnlyToken, "readOnlyToken");
requireString(discovery.terminalToken, "terminalToken");

const control = new URL(discovery.controlUrl);
const terminal = new URL(discovery.terminalUrl);
if (control.hostname !== "127.0.0.1" || terminal.hostname !== "127.0.0.1"
  || control.port !== terminal.port || control.pathname !== "/control"
  || terminal.pathname !== "/terminal") {
  throw new Error("The runtime discovery endpoints are not the expected shared loopback port.");
}

const payload = {
  version: 1,
  connectionId: `mac-${createHash("sha256").update(name).digest("hex").slice(0, 16)}`,
  name,
  protocolVersion: discovery.protocolVersion,
  controlUrl: discovery.controlUrl,
  controlToken: discovery.readOnlyToken,
  terminalUrl: discovery.terminalUrl,
  terminalToken: discovery.terminalToken,
};

console.error(`Before connecting, keep an SSH local forward open on the phone: ${control.port} -> 127.0.0.1:${control.port} on ${name}`);
console.error("The next line contains temporary credentials. Paste it only into TermLoop Mobile.");
console.log(`TLMP1:${JSON.stringify(payload)}`);

function defaultRuntimeFile() {
  if (process.env.TERMLOOP_RUNTIME_FILE) return process.env.TERMLOOP_RUNTIME_FILE;
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData/Local"), "termloop-next", "runtime.json");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library/Application Support/termloop-next/runtime.json");
  }
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return path.join(process.env.XDG_RUNTIME_DIR ?? path.join(os.tmpdir(), `termloop-next-${uid}`), "termloop-next", "runtime.json");
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Runtime discovery is missing ${name}.`);
  }
}
