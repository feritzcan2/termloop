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
  const retained = buffer.screen !== undefined || buffer.lines.some((line) => line.kind === "output")
    || buffer.pending.length > 0;
  if (progress) {
    return {
      label: retained ? "Updating terminal · saved output visible" : "Loading recent output",
      ...(progress.totalBytes > 0 ? {
        percent: Math.max(0, Math.min(100, Math.floor(progress.receivedBytes / progress.totalBytes * 100))),
      } : {}),
    };
  }
  if (buffer.ready) return undefined;
  if (retained) return { label: "Updating terminal · saved output visible" };
  return { label: buffer.stream === "attaching" ? "Connecting to terminal" : "Waiting for terminal" };
}
