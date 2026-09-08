import { describe, expect, it } from "vitest";
import { terminalLoading } from "../../src/presentation/terminal-loading";
import { emptyTerminalBuffer, reduceTerminalEvent } from "../../src/presentation/terminal-buffer";

const options = { decode: (bytes: Uint8Array) => new TextDecoder().decode(bytes) };
describe("terminal loading", () => {
  it("shows phases without inventing a percentage", () => {
    expect(terminalLoading(emptyTerminalBuffer())).toEqual({ label: "Connecting to terminal" });
    expect(terminalLoading({ ...emptyTerminalBuffer(), stream: "live" })).toEqual({ label: "Waiting for terminal" });
  });
  it("reports the negotiated replay byte fraction", () => {
    const buffer = reduceTerminalEvent(emptyTerminalBuffer(), { type: "replayProgress", receivedBytes: 128, totalBytes: 512 }, options);
    expect(terminalLoading(buffer)).toEqual({ label: "Loading recent output", percent: 25 });
  });
  it("reveals an empty ready terminal and clears stale progress", () => {
    const buffer = reduceTerminalEvent({ ...emptyTerminalBuffer(), stream: "live", replayProgress: { receivedBytes: 0, totalBytes: 0 } }, { type: "ready" }, options);
    expect(terminalLoading(buffer)).toBeUndefined();
    expect(buffer.lines).toEqual([]);
  });
  it("keeps cached output visible while a new attachment loads its suffix", () => {
    let buffer = reduceTerminalEvent(emptyTerminalBuffer(), { type: "replay", bytes: new TextEncoder().encode("Cached output\n") }, options);
    buffer = reduceTerminalEvent(buffer, { type: "state", state: "connecting" }, options);
    expect(terminalLoading(buffer)?.label).toBe("Updating terminal · saved output visible");
    buffer = reduceTerminalEvent(buffer, { type: "replayProgress", receivedBytes: 128, totalBytes: 512 }, options);
    expect(terminalLoading(buffer)).toEqual({ label: "Updating terminal · saved output visible", percent: 25 });
    expect(buffer.lines[0]?.text).toBe("Cached output");
  });
  it("shows reconnection even if a cached screen was ready", () => {
    expect(terminalLoading({ ...emptyTerminalBuffer(), ready: true, stream: "reconnecting" })?.label).toContain("Reconnecting");
  });
  it("names a proven gateway reachability failure", () => {
    expect(terminalLoading({
      ...emptyTerminalBuffer(),
      stream: "reconnecting",
      connectionIssue: "gatewayUnreachable",
    })?.label).toBe("Mac unreachable · check Tailscale · last output retained");
  });
});
