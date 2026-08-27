import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("TerminalAttachment byte input", () => {
  it("queues Uint8Array input without text decoding or re-encoding", async () => {
    const windowStub = {
      termloop: {},
      addEventListener: vi.fn(),
    };
    vi.stubGlobal("window", windowStub);
    const { TerminalAttachment } = await import("../src/renderer/transport/terminal-port.js");
    const sent: unknown[] = [];
    const port = {
      onmessage: undefined as ((event: MessageEvent) => void) | undefined,
      start: vi.fn(),
      postMessage: vi.fn((message: unknown) => sent.push(message)),
      close: vi.fn(),
    };
    const attachment = new TerminalAttachment(port as unknown as MessagePort);
    const input = new Uint8Array([0, 0xff, 0xc3, 0x28, 10]);

    expect(attachment.input(input)).toBe(true);
    port.onmessage?.({ data: { type: "inputCredit", bytes: input.byteLength } } as MessageEvent);

    const message = sent[0] as { type: string; data: ArrayBuffer };
    expect(message.type).toBe("input");
    expect([...new Uint8Array(message.data)]).toEqual([...input]);
  });
});
