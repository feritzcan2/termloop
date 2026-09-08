import type { TerminalBuffer } from "./terminal-buffer";

export function terminalLoading(buffer: TerminalBuffer): { label: string; percent?: number } | undefined {
  if (buffer.stream === "exited" || buffer.stream === "detached") return undefined;
  if (buffer.stream === "reconnecting") {
    return {
      label: buffer.connectionIssue === "gatewayUnreachable"
        ? "Mac unreachable · check Tailscale · last output retained"
        : "Reconnecting · last output retained",
    };
  }
  const progress = buffer.replayProgress;
  if (progress) {
    return {
      label: "Loading recent output",
      ...(progress.totalBytes > 0 ? {
        percent: Math.max(0, Math.min(100, Math.floor(progress.receivedBytes / progress.totalBytes * 100))),
      } : {}),
    };
  }
  if (buffer.ready) return undefined;
  return { label: buffer.stream === "attaching" ? "Connecting to terminal" : "Waiting for terminal" };
}
