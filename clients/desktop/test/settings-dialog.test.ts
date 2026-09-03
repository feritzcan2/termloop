// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultNotificationPreferences } from "../src/notification-preferences.js";
import { SettingsDialog } from "../src/renderer/ui/SettingsDialog.js";

type SettingsDialogProps = ComponentProps<typeof SettingsDialog>;

function props(overrides: Partial<SettingsDialogProps> = {}): SettingsDialogProps {
  const hostStatus = {
    enabled: false,
    listening: false,
    port: null,
    serverFingerprint: "fingerprint",
    tailscale: { state: "idle" as const },
  };
  return {
    close: vi.fn(),
    connect: vi.fn(),
    disableHost: vi.fn(async () => hostStatus),
    discoverTailscaleServers: vi.fn(async () => ({ state: "ready" as const, servers: [] })),
    enableHost: vi.fn(async () => hostStatus),
    hostStatus: vi.fn(async () => hostStatus),
    list: vi.fn(async () => []),
    remove: vi.fn(async () => []),
    setEnabled: vi.fn(async () => []),
    subscribeStatus: vi.fn(() => () => undefined),
    loadNotificationPreferences: vi.fn(async () => ({ ...defaultNotificationPreferences })),
    saveNotificationPreferences: vi.fn(async (value) => value),
    ...overrides,
  };
}

describe("SettingsDialog", () => {
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

  it("loads notification preferences and persists switch changes", async () => {
    const saveNotificationPreferences = vi.fn(async (value) => value);
    await act(async () => root.render(createElement(SettingsDialog, props({ saveNotificationPreferences }))));

    const master = container.querySelector<HTMLButtonElement>('[aria-label="Agent attention notifications"]');
    const foreground = container.querySelector<HTMLButtonElement>('[aria-label="Show while TermLoop is active"]');
    const sound = container.querySelector<HTMLButtonElement>('[aria-label="Play notification sound"]');
    expect(master?.getAttribute("aria-checked")).toBe("true");
    expect(foreground?.getAttribute("aria-checked")).toBe("false");
    expect(sound?.getAttribute("aria-checked")).toBe("true");

    await act(async () => foreground?.click());
    expect(saveNotificationPreferences).toHaveBeenCalledWith({
      ...defaultNotificationPreferences,
      notifyWhenFocused: true,
    });
    expect(foreground?.getAttribute("aria-checked")).toBe("true");

    const mobileReview = container.querySelector<HTMLButtonElement>('[aria-label="iPhone: Agent ready for review"]');
    const mobileWhileActive = container.querySelector<HTMLButtonElement>('[aria-label="iPhone: Send while this Mac is active"]');
    const watchSteward = container.querySelector<HTMLButtonElement>('[aria-label="Apple Watch: Steward messages and approvals"]');
    const watchWhileActive = container.querySelector<HTMLButtonElement>('[aria-label="Apple Watch: Send while this Mac is active"]');
    expect(mobileReview?.getAttribute("aria-checked")).toBe("true");
    expect(mobileWhileActive?.getAttribute("aria-checked")).toBe("false");
    expect(watchSteward?.getAttribute("aria-checked")).toBe("true");
    expect(watchWhileActive?.getAttribute("aria-checked")).toBe("false");
    await act(async () => mobileWhileActive?.click());
    expect(saveNotificationPreferences).toHaveBeenLastCalledWith({
      ...defaultNotificationPreferences,
      notifyWhenFocused: true,
      mobile: {
        ...defaultNotificationPreferences.mobile,
        notifyWhenMacActive: true,
      },
    });
    await act(async () => mobileReview?.click());
    expect(saveNotificationPreferences).toHaveBeenLastCalledWith({
      ...defaultNotificationPreferences,
      notifyWhenFocused: true,
      mobile: {
        ...defaultNotificationPreferences.mobile,
        notifyWhenMacActive: true,
        agentReadyForReview: false,
      },
    });
    expect(mobileReview?.getAttribute("aria-checked")).toBe("false");
  });

  it("opens the existing server controls inside the Settings dialog", async () => {
    await act(async () => root.render(createElement(SettingsDialog, props({ initialPage: "servers" }))));

    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(container.querySelector(".settings-dialog")?.textContent).toContain("Settings");
    expect(container.querySelector(".settings-content")?.textContent).toContain("Your computers");
    expect(container.querySelector(".settings-content")?.textContent).toContain("Share this computer");
    expect(container.querySelector(".server-profiles-layer")).toBeNull();
  });
});
