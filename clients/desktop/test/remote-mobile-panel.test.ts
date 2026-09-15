// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ConnectionProfilesDialog } from "../src/renderer/ui/ConnectionProfilesDialog.js";

it("pairs the chosen SSH server and discards its QR when selecting another computer", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const prepare = vi.fn(async () => ({ ok: true as const, qrSvg: '<svg data-server="netcup"></svg>' }));
  const local = { id: "local", name: "This computer", transport: "local" as const, scope: "local" as const, endpoint: "local", enabled: true, persistence: "local" as const };
  const remote = { ...local, id: "netcup", name: "Netcup", transport: "ssh" as const, scope: "full" as const };
  try {
    await act(async () => root.render(createElement(ConnectionProfilesDialog, {
      close: vi.fn(), connect: vi.fn(), disableHost: vi.fn(),
      discoverTailscaleServers: async () => ({ state: "ready" as const, servers: [] }),
      enableHost: vi.fn(), hostStatus: async () => ({ enabled: false, listening: false, port: null, serverFingerprint: "", tailscale: { state: "idle" as const } }), list: async () => [local, remote, { ...remote, id: "read-only", name: "Read only", scope: "readOnly" as const }],
      reconnect: vi.fn(), remove: vi.fn(), setEnabled: vi.fn(), subscribeStatus: () => () => {}, prepareRemoteMobileAccess: prepare,
    })));
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent === "Connect Mobile");
    expect(buttons).toHaveLength(2);
    expect(buttons[1]!.disabled).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
    await act(async () => buttons[0]!.click());
    expect(prepare).toHaveBeenCalledExactlyOnceWith("netcup");
    expect(container.textContent).toContain("Your phone connects directly to Netcup");
    expect(container.querySelector('svg[data-server="netcup"]')).not.toBeNull();
    const select = container.querySelector("select")!;
    await act(async () => { select.value = "local"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelector('svg[data-server="netcup"]')).toBeNull();
    expect(prepare).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
