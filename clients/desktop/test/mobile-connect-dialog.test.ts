// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileConnectDialog } from "../src/renderer/ui/MobileConnectDialog.js";

describe("mobile connection dialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("renders the main-process QR and pairing directions", async () => {
    await act(async () => root.render(createElement(MobileConnectDialog, {
      close: vi.fn(),
      prepare: async () => ({ ok: true as const, qrSvg: '<svg data-test="qr"></svg>' }),
    })));
    await act(async () => undefined);

    expect(container.querySelector(".mobile-connect-qr svg")?.getAttribute("data-test")).toBe("qr");
    expect(container.textContent).toContain("Pair a computer");
    expect(container.textContent).not.toContain("TLMP1:");
  });

  it("offers an in-place retry after setup fails", async () => {
    const prepare = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, error: "Tailscale is not connected." })
      .mockResolvedValueOnce({ ok: true as const, qrSvg: "<svg></svg>" });
    await act(async () => root.render(createElement(MobileConnectDialog, { close: vi.fn(), prepare })));
    await act(async () => undefined);
    expect(container.textContent).toContain("Tailscale is not connected.");

    await act(async () => (container.querySelector(".mobile-connect-error button") as HTMLButtonElement).click());
    await act(async () => undefined);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".mobile-connect-qr svg")).not.toBeNull();
  });
});
