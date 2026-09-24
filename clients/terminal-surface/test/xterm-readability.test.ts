import { afterEach, describe, expect, it, vi } from "vitest";
import type { ITerminalOptions } from "@xterm/xterm";

const { terminalOptions } = vi.hoisted(() => ({ terminalOptions: vi.fn() }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor(options: ITerminalOptions) { terminalOptions(options); }
    loadAddon = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    attachCustomWheelEventHandler = vi.fn();
    onData = vi.fn();
    onResize = vi.fn();
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("xterm readability", () => {
  it("uses regular-weight body text and a readable contrast floor", async () => {
    vi.stubGlobal("document", {
      createElement: () => ({ addEventListener: vi.fn() }),
    });
    const { XtermSurface } = await import("../src/renderer/terminal/xterm/xterm-surface.js");
    new XtermSurface(vi.fn(), vi.fn(), vi.fn());

    const options = terminalOptions.mock.calls[0]![0] as ITerminalOptions;
    expect(Number(options.fontWeight)).toBeGreaterThanOrEqual(400);
    expect(Number(options.fontWeightBold)).toBeGreaterThan(Number(options.fontWeight));
    expect(options.minimumContrastRatio).toBeGreaterThanOrEqual(4.5);
  });

  it("preloads the actual regular, bold, and italic faces used by the terminal", async () => {
    const load = vi.fn().mockResolvedValue([]);
    vi.stubGlobal("document", {
      fonts: { load },
      createElement: () => ({ addEventListener: vi.fn() }),
    });
    const { XtermSurface } = await import("../src/renderer/terminal/xterm/xterm-surface.js");
    new XtermSurface(vi.fn(), vi.fn(), vi.fn());

    const options = terminalOptions.mock.calls[0]![0] as ITerminalOptions;
    for (const weight of [options.fontWeight, options.fontWeightBold]) {
      for (const style of ["", "italic "]) {
        expect(load).toHaveBeenCalledWith(
          `${style}${weight} ${options.fontSize}px ${options.fontFamily}`,
        );
      }
    }
    expect(load).toHaveBeenCalledTimes(4);
  });
});
