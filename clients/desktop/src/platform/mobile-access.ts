import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import QRCode from "qrcode/lib/browser.js";

const run = promisify(execFile);
const MAX_BOOTSTRAP_OUTPUT_BYTES = 32 * 1024;

export function mobileAccessScriptPath(bundleDirectory: string, checkout?: string): string {
  return checkout
    ? path.join(checkout, "clients", "mobile", "scripts", "mobile-access.mjs")
    : path.resolve(bundleDirectory, "../../mobile/scripts/mobile-access.mjs");
}

export function mobileAccessNodeExecutable(configured?: string): string {
  return configured?.trim() || "node";
}

/// Starts the existing owner-mobile gateway without exposing its raw credentials to
/// the renderer. Only the rendered QR geometry crosses IPC.
export async function prepareMobileAccessQr(
  scriptPath: string,
  nodeExecutable = "node",
): Promise<string> {
  const { stdout } = await run(nodeExecutable, [scriptPath, "--print"], {
    maxBuffer: MAX_BOOTSTRAP_OUTPUT_BYTES,
    timeout: 30_000,
  });
  const code = stdout.split(/\r?\n/).find((line) => line.startsWith("TLMP1:"));
  if (!code || code.length > 8 * 1024) {
    throw new Error("Mobile Access did not produce a valid pairing code.");
  }
  const svg = await QRCode.toString(code, {
    type: "svg",
    errorCorrectionLevel: "L",
    margin: 2,
    width: 340,
    color: { dark: "#111517", light: "#ffffff" },
  });
  // The desktop icon system gives every SVG rounded 1.5px strokes. QRCode's SVG
  // renderer relies on the SVG defaults (square 1px strokes), so keep those
  // geometry-critical values self-contained instead of inheriting app chrome CSS.
  return svg.replace(
    "<svg ",
    '<svg style="stroke-linecap:butt;stroke-linejoin:miter;stroke-width:1" ',
  );
}
