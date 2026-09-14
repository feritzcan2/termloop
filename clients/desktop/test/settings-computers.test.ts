// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ConnectionProfileSummary } from "../src/connection-profile-types.js";

const { list, subscribe } = vi.hoisted(() => ({ list: vi.fn(), subscribe: vi.fn() }));
vi.mock("../src/renderer/transport/desktop-api.js", () => ({ desktopApi: { connectionProfileList: list } }));
vi.mock("../src/renderer/transport/connection-events.js", () => ({ onConnectionStatus: subscribe }));
import { useSettingsComputers } from "../src/renderer/composition/use-settings-computers.js";

it("refreshes computer scope on connection changes and ignores older profile lists", async () => {
  const remote: ConnectionProfileSummary = {
    id: "remote", name: "Netcup", transport: "ssh", scope: "full",
    endpoint: "", enabled: true, persistence: "encrypted", state: "connected",
  };
  const requests: Array<(profiles: ConnectionProfileSummary[]) => void> = [];
  const unsubscribe = vi.fn();
  let changed!: () => void;
  subscribe.mockImplementation((listener) => { changed = listener; return unsubscribe; });
  list.mockImplementation(() => new Promise((resolve) => requests.push(resolve)));
  const container = document.createElement("div");
  const root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  function Probe() {
    const { profiles } = useSettingsComputers();
    return createElement("span", null, profiles.map((profile) => profile.name).join(","));
  }
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => changed());
    await act(async () => requests[1]!([remote]));
    expect(container.textContent).toBe("Netcup");
    await act(async () => requests[0]!([]));
    expect(container.textContent).toBe("Netcup");
    await act(async () => changed());
    await act(async () => requests[2]!([]));
    expect(container.textContent).toBe("");
  } finally {
    await act(async () => root.unmount());
    expect(unsubscribe).toHaveBeenCalledOnce();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
