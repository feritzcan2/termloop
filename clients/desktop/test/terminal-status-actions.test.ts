// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalStatus } from "../src/renderer/ui/TerminalStatus.js";
import type { TerminalPresentation, TerminalPresentationPort } from "../src/renderer/terminal-presentation.js";

let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; host?.remove(); });
async function mount(reconnect: (id: string) => Promise<void>) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  let state: TerminalPresentation = { phase: "reconnecting" };
  let notify = () => {};
  const port: TerminalPresentationPort = {
    subscribe: (listener) => { notify = listener; return () => {}; },
    snapshot: () => state, read: vi.fn(), recover: vi.fn(), reconnect,
  };
  await act(async () => root!.render(createElement(TerminalStatus, { sessionId: "remote-session", port })));
  return { port, live: () => { state = { phase: "live" }; notify(); } };
}

it("sends one reconnect for the exact session, disables duplicates and clears the banner on recovery", async () => {
  let finish!: () => void;
  const reconnect = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const f = await mount(reconnect);
  const button = host.querySelector<HTMLButtonElement>(".terminal-reconnect-button")!;
  await act(async () => { button.click(); button.click(); });
  expect(reconnect).toHaveBeenCalledExactlyOnceWith("remote-session");
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe("Reconnecting…");
  expect(f.port.recover).not.toHaveBeenCalled();
  await act(async () => { finish(); f.live(); });
  expect(host.textContent).toBe("");
});

it("keeps a reconnect error visible beside a usable retry button", async () => {
  const reconnect = vi.fn().mockRejectedValueOnce(new Error("Computer offline")).mockResolvedValueOnce(undefined);
  await mount(reconnect);
  await act(async () => host.querySelector<HTMLButtonElement>(".terminal-reconnect-button")!.click());
  expect(host.textContent).toContain("Could not reconnect: Computer offline");
  const button = host.querySelector<HTMLButtonElement>(".terminal-reconnect-button")!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(reconnect).toHaveBeenCalledTimes(2);
  expect(host.textContent).not.toContain("Could not reconnect");
});
