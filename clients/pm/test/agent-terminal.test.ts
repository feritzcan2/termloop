// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { TerminalSurface } from "@termloop/terminal-surface/surface";
import { mountAgentTerminal } from "../src/renderer/terminal/agent-terminal.js";
import type { PmApi, PmTerminalMessage } from "../src/pm-api.js";

const SESSION = "0d2c6c4e-58a4-4e0c-9a8c-1d4b1f0f7a11";

function fakes(measured: { rows: number; cols: number }) {
  const calls: string[] = [];
  let listener: ((message: PmTerminalMessage) => void) | undefined;
  const written: string[] = [];
  const terminal: PmApi["terminal"] = {
    attach: vi.fn(async (_id: string, rows: number, cols: number) => { calls.push(`attach ${rows}x${cols}`); }),
    detach: vi.fn(),
    input: vi.fn(),
    resize: vi.fn((_id: string, rows: number, cols: number) => { calls.push(`resize ${rows}x${cols}`); }),
    credit: vi.fn(),
    onMessage: (next) => { listener = next; return () => { listener = undefined; }; },
  };
  let onResize: ((rows: number, cols: number) => void) | undefined;
  const surface: TerminalSurface = {
    // A real surface fits during mount and reports the pane grid.
    mount: () => onResize?.(measured.rows, measured.cols),
    unmount: () => undefined,
    write: (data, done) => { written.push(new TextDecoder().decode(data)); done(); },
    writeln: (message) => written.push(message),
    focus: () => undefined,
    probe: () => undefined,
    dispose: () => undefined,
  };
  const factory = (_input: (data: string) => void, resize: (rows: number, cols: number) => void) => {
    onResize = resize;
    return surface;
  };
  return { calls, terminal, factory, written, emit: (message: PmTerminalMessage) => listener?.(message), resize: (r: number, c: number) => onResize?.(r, c) };
}

describe("agent terminal adapter", () => {
  it("attaches with the grid the surface measured and forwards later resizes as rows, cols", () => {
    const fake = fakes({ rows: 38, cols: 61 });
    const dispose = mountAgentTerminal(fake.terminal, document.createElement("div"), SESSION, fake.factory);
    fake.resize(40, 72);
    expect(fake.calls).toEqual(["attach 38x61", "resize 40x72"]);
    dispose();
    expect(fake.terminal.detach).toHaveBeenCalledWith(SESSION);
  });

  it("stages announced replay and writes it once complete, crediting every byte", () => {
    vi.useFakeTimers();
    const fake = fakes({ rows: 24, cols: 80 });
    mountAgentTerminal(fake.terminal, document.createElement("div"), SESSION, fake.factory);
    // TLRA: two frames, six bytes.
    const ack = new Uint8Array([84, 76, 82, 65, 0, 0, 0, 2, 0, 0, 0, 6]);
    fake.emit({ sessionId: SESSION, type: "attached", ack });
    fake.emit({ sessionId: SESSION, type: "output", data: new TextEncoder().encode("abc"), replay: true });
    expect(fake.written).toEqual([]);
    fake.emit({ sessionId: SESSION, type: "output", data: new TextEncoder().encode("def"), replay: true });
    vi.runAllTimers();
    expect(fake.written.join("")).toBe("abcdef");
    expect(fake.terminal.credit).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
