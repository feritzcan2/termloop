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
      loadVoiceSettings: async () => ({ configured: false }),
      saveVoiceCredentials: async () => ({ configured: true }),
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
    await act(async () => root.render(createElement(MobileConnectDialog, {
      close: vi.fn(),
      prepare,
      loadVoiceSettings: async () => ({ configured: true }),
      saveVoiceCredentials: async () => ({ configured: true }),
    })));
    await act(async () => undefined);
    expect(container.textContent).toContain("Tailscale is not connected.");

    await act(async () => (container.querySelector(".mobile-connect-error button") as HTMLButtonElement).click());
    await act(async () => undefined);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".mobile-connect-qr svg")).not.toBeNull();
  });

  it("keeps the dialog rendered when setup rejects", async () => {
    await act(async () => root.render(createElement(MobileConnectDialog, {
      close: vi.fn(),
      prepare: async () => { throw new Error("Pairing service unavailable."); },
      loadVoiceSettings: async () => ({ configured: false }),
      saveVoiceCredentials: async () => ({ configured: true }),
    })));
    await act(async () => undefined);

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain("Pairing service unavailable.");
  });

  it("keeps the dialog rendered when setup throws synchronously", async () => {
    await act(async () => root.render(createElement(MobileConnectDialog, {
      close: vi.fn(),
      prepare: () => { throw new Error("Pairing bridge unavailable."); },
      loadVoiceSettings: async () => ({ configured: false }),
      saveVoiceCredentials: async () => ({ configured: true }),
    })));
    await act(async () => undefined);

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain("Pairing bridge unavailable.");
  });

  it("shows only secure OpenAI credential presence and never the stored key", async () => {
    await act(async () => root.render(createElement(MobileConnectDialog, {
      close: vi.fn(),
      prepare: async () => ({ ok: true as const, qrSvg: "<svg></svg>" }),
      loadVoiceSettings: async () => ({ configured: true }),
      saveVoiceCredentials: async () => ({ configured: true }),
    })));
    await act(async () => undefined);

    expect(container.textContent).toContain("Ready — the API key is stored");
    expect((container.querySelector('input[aria-label="OpenAI API key"]') as HTMLInputElement).type).toBe("password");
    expect(container.textContent).not.toContain("sk-proj-secret");
  });
});
