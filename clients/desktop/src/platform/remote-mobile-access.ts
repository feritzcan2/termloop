import { CONTRACT_IDENTITY } from "@termloop/contract/current";
import type { MobileAccessPairingResult } from "../renderer/mobile-access.js";
import { mobilePairingQr } from "./mobile-access.js";
import { runSshCommand, type SshTunnelRequest } from "./ssh-runtime.js";

export const remoteMobileAccessCommand = String.raw`set -eu
if test "$(uname -s)" != Linux; then
  printf '%s\n' '{"ok":false,"errorCode":"linuxRequired"}'
  exit 0
fi
export PATH="$HOME/.local/share/termloop-node/bin:$HOME/.local/bin:$PATH"
export XDG_RUNTIME_DIR="${"${"}XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
p="${"${"}XDG_DATA_HOME:-$HOME/.local/share}/termloop-server/current"
if ! test -f "$p/server-package.json" || ! test -f "$p/termloop-server-manager.mjs"; then
  printf '%s\n' '{"ok":false,"errorCode":"packageMissing"}'
  exit 0
fi
if ! command -v node >/dev/null; then
  printf '%s\n' '{"ok":false,"errorCode":"nodeMissing"}'
  exit 0
fi
if ! node -e 'if (JSON.parse(require("fs").readFileSync(process.argv[1])).mobileAccess !== 1) process.exit(1)' "$p/server-package.json"; then
  printf '%s\n' '{"ok":false,"errorCode":"packageMissing"}'
  exit 0
fi
exec node "$p/termloop-server-manager.mjs" mobile-pair`;

const failureMessages: Record<string, string> = {
  linuxRequired: "Remote mobile setup currently supports Linux servers. On a Mac, use Connect Mobile in that computer’s TermLoop app.",
  packageMissing: "This server package does not include Mobile Access yet. Update the Linux server to a release with Mobile Access, then try again.",
  nodeMissing: "Node.js is unavailable in the SSH session. Install Node.js 22 or newer for the TermLoop server user.",
  tailscaleMissing: "Install Tailscale on this server and sign in to the same network as your phone, then try again.",
  tailscaleOffline: "Tailscale is not connected on this server. Sign it in to the same network as your phone, then try again.",
  tailscalePermission: "The server user cannot configure Tailscale Serve. An administrator must run sudo tailscale set --operator=<server-user> on the server, then try again.",
  tailscaleServe: "Enable HTTPS and Tailscale Serve for this server in the Tailscale admin console, then try again.",
  daemonUnavailable: "The TermLoop server is not ready. Start its service, refresh the server connection, then try again.",
  diskFull: "The server has run out of disk space. Free some space, then try again.",
  serviceFailed: "Mobile Access could not start its background service. Check the server user’s systemd services, then try again.",
  timedOut: "Mobile Access setup timed out. Check the server’s Tailscale connection and whether HTTPS/Serve needs approval, then try again.",
  pairingFailed: "Mobile Access could not be prepared on this server. Check Tailscale and the TermLoop server service, then try again.",
};

export async function prepareRemoteMobileAccess(
  connection: SshTunnelRequest,
  run = runSshCommand,
): Promise<MobileAccessPairingResult> {
  try {
    const output = await run(connection, remoteMobileAccessCommand);
    const result = JSON.parse(output) as { ok?: unknown; errorCode?: unknown; pairingCode?: unknown };
    if (result.ok !== true) {
      return { ok: false, error: failureMessages[typeof result.errorCode === "string" ? result.errorCode : ""] ?? failureMessages.pairingFailed! };
    }
    const code = result.pairingCode;
    if (typeof code !== "string" || code.length > 8 * 1024 || !code.startsWith("TLMP1:")) throw new Error("invalid pairing code");
    const payload = JSON.parse(code.slice(6));
    if (payload.version !== 1 || payload.protocolVersion !== CONTRACT_IDENTITY) {
      return { ok: false, error: "The server and desktop use different protocols. Update them to matching builds before pairing your phone." };
    }
    if (typeof payload.connectionId !== "string" || typeof payload.name !== "string"
      || !/^[a-f0-9]{64}$/.test(payload.controlToken) || !/^[a-f0-9]{64}$/.test(payload.terminalToken)) throw new Error("invalid pairing identity");
    const control = new URL(payload.controlUrl);
    const terminal = new URL(payload.terminalUrl);
    if (control.protocol !== "wss:" || !control.hostname.endsWith(".ts.net")
      || control.username || control.password || control.search || control.hash || control.pathname !== "/control"
      || terminal.href !== `${control.origin}/terminal`) throw new Error("invalid pairing endpoint");
    return { ok: true, qrSvg: await mobilePairingQr(code) };
  } catch {
    // Neither a remote response nor execFile's error text may reveal tokens.
    return { ok: false, error: "Mobile Access could not be prepared over SSH. Refresh this server’s connection and try again." };
  }
}
