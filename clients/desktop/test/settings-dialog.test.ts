// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultNotificationPreferences } from "../src/notification-preferences.js";
import type { ConnectionProfileSummary, ConnectionSourceSummary } from "../src/connection-profile-types.js";
import { SettingsDialog } from "../src/renderer/ui/SettingsDialog.js";
import type { KeepAwakeStatusResult } from "@termloop/contract/current";

type SettingsDialogProps = ComponentProps<typeof SettingsDialog>;

const netcup: ConnectionProfileSummary = {
  id: "netcup",
  name: "Netcup",
  transport: "ssh",
  scope: "full",
  endpoint: "termloop-admin@89.58.14.155:43717",
  enabled: true,
  persistence: "encrypted",
  state: "offline",
  message: "Version mismatch: server old, desktop new",
};

const local: ConnectionProfileSummary = {
  id: "local", name: "MacBook Pro", transport: "local", scope: "local",
  endpoint: "", enabled: true, persistence: "local", state: "connected",
};
const awake: KeepAwakeStatusResult = {
  mode: "off", keepDisplayAwake: false, state: "inactive", eligibleAgentCount: 0,
  reason: "modeOff", expiresAtEpochMs: null, limitations: [],
};

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
    reconnect: vi.fn(async () => undefined),
    remove: vi.fn(async () => []),
    setEnabled: vi.fn(async () => []),
    subscribeStatus: vi.fn(() => () => undefined),
    appearancePreference: "system",
    changeAppearancePreference: vi.fn(),
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

  it("offers system, light, and dark appearance choices", async () => {
    const changeAppearancePreference = vi.fn();
    await act(async () => root.render(createElement(SettingsDialog, props({
      initialPage: "appearance",
      appearancePreference: "system",
      changeAppearancePreference,
    }))));

    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    const system = options.find((option) => option.textContent?.includes("System"));
    const light = options
      .find((option) => option.textContent?.includes("Light"));
    expect(options).toHaveLength(3);
    expect(system?.getAttribute("aria-checked")).toBe("true");
    expect(light?.getAttribute("aria-checked")).toBe("false");

    await act(async () => light?.click());
    expect(changeAppearancePreference).toHaveBeenCalledWith("light");
  });

  it("shows scope only when there is a remote computer", async () => {
    const settings = props({ initialPage: "appearance", localComputerName: "MacBook Pro" });
    await act(async () => root.render(createElement(SettingsDialog, settings)));
    expect(container.querySelector(".settings-scope-label")).toBeNull();
    expect(container.querySelector(".settings-nav-group")).toBeNull();
    await act(async () => root.render(createElement(SettingsDialog, { ...settings, showScope: true })));
    expect(container.querySelector(".settings-scope-label")?.textContent).toBe("This app · MacBook Pro");
    expect(container.querySelector(".settings-nav-group")?.textContent).toBe("This app");
  });

  it("pairs the local computer inside Settings while a remote project is selected", async () => {
    const prepare = vi.fn(async () => ({ ok: true as const, qrSvg: '<svg data-test="local-qr"></svg>' }));
    await act(async () => root.render(createElement(SettingsDialog, props({
      initialPage: "servers", initialProfileId: "netcup", list: async () => [local, netcup],
      showScope: true, localComputerName: local.name,
      mobile: {
        prepare, loadVoiceSettings: async () => ({ configured: false, transcriptionKeywords: "" }),
        saveVoiceCredentials: vi.fn(),
      },
    }))));
    const cards = [...container.querySelectorAll(".conn-card")];
    expect(cards[1]?.textContent).not.toContain("Pair phone");
    const pair = [...cards[0]!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Pair phone")!;
    await act(async () => pair.click());
    expect(prepare).toHaveBeenCalledOnce();
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(container.querySelector(".mobile-connect-settings")?.textContent).toContain("Pair your phone with MacBook Pro");
    expect(container.querySelector('[data-test="local-qr"]')).not.toBeNull();
  });

  it("pins power settings to the chosen computer when the active project changes", async () => {
    const load = vi.fn(async () => awake);
    const save = vi.fn(async () => awake);
    const settings = props({
      initialPage: "servers", initialProfileId: "netcup", list: async () => [local, { ...netcup, state: "connected" }],
      keepAwake: { load, save, refreshToken: 0 },
    });
    await act(async () => root.render(createElement(SettingsDialog, settings)));
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".conn-toggle button")].find((button) => button.textContent === "Keep Awake")!.click());
    expect(load).toHaveBeenCalledWith("netcup");
    expect(container.querySelector(".keep-awake-panel h2")?.textContent).toBe("Keep Netcup awake");
    await act(async () => root.render(createElement(SettingsDialog, { ...settings, initialProfileId: "local" })));
    const mode = container.querySelector<HTMLInputElement>('input[value="always"]')!;
    await act(async () => mode.click());
    expect(save).toHaveBeenCalledWith("netcup", { mode: "always", keepDisplayAwake: false, durationSeconds: null });
  });

  it("discards a late power read when explicitly switching computers", async () => {
    let finishRemote!: (value: KeepAwakeStatusResult) => void;
    let finishLocal!: (value: KeepAwakeStatusResult) => void;
    const save = vi.fn(async () => awake);
    await act(async () => root.render(createElement(SettingsDialog, props({
      initialPage: "servers", initialProfileId: "netcup", list: async () => [local, { ...netcup, state: "connected" }],
      keepAwake: {
        load: (id) => new Promise((resolve) => { if (id === "netcup") finishRemote = resolve; else finishLocal = resolve; }),
        save, refreshToken: 0,
      },
    }))));
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".conn-toggle button")].find((button) => button.textContent === "Keep Awake")!.click());
    const select = container.querySelector<HTMLSelectElement>(".agent-server-select select")!;
    await act(async () => { select.value = "local"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => finishRemote({ ...awake, mode: "always", keepDisplayAwake: true }));
    expect(container.querySelector<HTMLFieldSetElement>(".keep-awake-body fieldset")?.disabled).toBe(true);
    await act(async () => finishLocal(awake));
    expect(container.querySelector<HTMLInputElement>('input[value="off"]')?.checked).toBe(true);
    await act(async () => container.querySelector<HTMLInputElement>('input[value="always"]')!.click());
    expect(save).toHaveBeenCalledWith("local", { mode: "always", keepDisplayAwake: false, durationSeconds: null });
  });

  it("refreshes only the selected enabled server and preserves live status over a delayed snapshot", async () => {
    const disabled = { ...netcup, id: "disabled", name: "Disabled server", enabled: false };
    const other = { ...netcup, id: "other", name: "Other server", transport: "tailscale" as const };
    let finishReconnect!: () => void;
    let finishList!: (value: ConnectionProfileSummary[]) => void;
    let onStatus!: (summary: ConnectionSourceSummary) => void;
    const reconnect = vi.fn(() => new Promise<void>((resolve) => { finishReconnect = resolve; }));
    const list = vi.fn<SettingsDialogProps["list"]>()
      .mockResolvedValueOnce([netcup, disabled, other])
      .mockImplementationOnce(() => new Promise((resolve) => { finishList = resolve; }));
    const settings = props({
      initialPage: "servers", list, reconnect,
      subscribeStatus: (listener) => { onStatus = listener; return () => undefined; },
    });
    await act(async () => root.render(createElement(SettingsDialog, settings)));
    await act(async () => onStatus({ ...netcup, state: "offline" }));
    const refresh = container.querySelector<HTMLButtonElement>('[aria-label="Refresh Netcup connection"]')!;
    const disabledRefresh = container.querySelector<HTMLButtonElement>('[aria-label="Refresh Disabled server connection"]')!;
    const otherRefresh = container.querySelector<HTMLButtonElement>('[aria-label="Refresh Other server connection"]')!;
    const card = refresh.closest(".conn-card")!;
    expect(disabledRefresh.disabled).toBe(true);
    await act(async () => disabledRefresh.click());
    expect(reconnect).not.toHaveBeenCalled();

    await act(async () => refresh.click());
    expect(refresh.textContent).toBe("Refreshing…");
    expect(refresh.disabled).toBe(true);
    expect(refresh.getAttribute("aria-busy")).toBe("true");
    expect(otherRefresh.disabled).toBe(false);
    await act(async () => refresh.click());
    expect(reconnect).toHaveBeenCalledExactlyOnceWith(netcup.id);
    expect(settings.setEnabled).not.toHaveBeenCalled();
    expect(settings.connect).not.toHaveBeenCalled();

    const { message: _oldError, ...withoutError } = netcup;
    const connecting = { ...withoutError, state: "connecting" as const };
    await act(async () => onStatus(connecting));
    expect(card.textContent).toContain("Connecting…");
    expect(card.textContent).not.toContain("Version mismatch");
    await act(async () => finishReconnect());
    await act(async () => onStatus({ ...withoutError, state: "connected" }));
    await act(async () => finishList([connecting, disabled, other]));
    expect(card.textContent).toContain("Connected");
    expect(refresh.disabled).toBe(false);
    expect(refresh.textContent).toBe("Refresh");
    expect(disabledRefresh.disabled).toBe(true);
  });

  it("allows retry after refresh fails and replaces a cached error with the fresh snapshot", async () => {
    let onStatus!: (summary: ConnectionSourceSummary) => void;
    const { message: _oldError, ...withoutError } = netcup;
    const reconnect = vi.fn<SettingsDialogProps["reconnect"]>()
      .mockRejectedValueOnce(new Error("SSH unavailable"))
      .mockResolvedValueOnce(undefined);
    const list = vi.fn<SettingsDialogProps["list"]>()
      .mockResolvedValueOnce([netcup])
      .mockResolvedValueOnce([{ ...withoutError, state: "connected" }]);
    await act(async () => root.render(createElement(SettingsDialog, props({
      initialPage: "servers", list, reconnect,
      subscribeStatus: (listener) => { onStatus = listener; return () => undefined; },
    }))));
    const refresh = container.querySelector<HTMLButtonElement>('[aria-label="Refresh Netcup connection"]')!;
    await act(async () => refresh.click());
    expect(container.textContent).toContain("Could not refresh Netcup: SSH unavailable");
    expect(refresh.disabled).toBe(false);

    await act(async () => onStatus({ ...netcup, state: "offline" }));
    await act(async () => refresh.click());
    expect(reconnect).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("SSH unavailable");
    expect(container.textContent).not.toContain("Version mismatch");
    expect(refresh.closest(".conn-card")?.textContent).toContain("Connected");
  });

  it.each(["local", "tailscale", "ssh"] as const)("waits for connection status after a %s refresh is accepted", async (transport) => {
    const { message: _oldError, ...withoutError } = netcup;
    const reconnect = vi.fn(async () => undefined);
    const list = vi.fn<SettingsDialogProps["list"]>()
      .mockResolvedValueOnce([{ ...netcup, transport }])
      .mockResolvedValueOnce([{ ...withoutError, transport, state: "connecting" }]);
    await act(async () => root.render(createElement(SettingsDialog, props({ initialPage: "servers", list, reconnect }))));
    const refresh = container.querySelector<HTMLButtonElement>('[aria-label="Refresh Netcup connection"]')!;
    await act(async () => refresh.click());
    expect(reconnect).toHaveBeenCalledExactlyOnceWith(netcup.id);
    expect(refresh.closest(".conn-card")?.textContent).toContain("Connecting…");
    expect(refresh.closest(".conn-card")?.textContent).not.toContain("Connected");
    expect(refresh.disabled).toBe(false);
  });
});
