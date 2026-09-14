// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SshSetupWizard } from "../src/renderer/ui/SshSetupWizard.js";
import type { SshSetupActions, SshSetupState } from "../src/ssh-setup-types.js";

const identity: SshSetupState = { id: "setup-id", name: "Netcup", host: "89.58.51.102", user: "root", sshPort: 22, fingerprint: "SHA256:verified-by-user", phase: "identity", message: "Verify the server fingerprint.", steps: [] };
const review: SshSetupState = { ...identity, phase: "review", message: "Install TermLoop and connect.", steps: ["Create SSH key access", "Install TermLoop", "Verify compatibility"] };
const profile = { id: "new-profile", name: "Netcup", transport: "ssh" as const, scope: "full" as const, endpoint: "termloop-admin@89.58.51.102:43717", enabled: true, persistence: "encrypted" as const };
let container: HTMLDivElement;
let root: Root;
let actions: SshSetupActions;
let connected: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  actions = {
    current: vi.fn(async () => null),
    start: vi.fn(async () => identity), login: vi.fn(async () => review),
    install: vi.fn(async () => ({ ...review, phase: "installing" as const })),
    status: vi.fn(async () => ({ ...review, phase: "ready" as const })),
    connect: vi.fn(async () => ({ profile })), cancel: vi.fn(async () => undefined),
    choosePackage: vi.fn(async () => review),
  };
  connected = vi.fn(async () => undefined);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

async function mount() { await act(async () => root.render(createElement(SshSetupWizard, { actions, connected }))); }
function button(label: string) {
  const result = [...container.querySelectorAll("button")].find((button) => button.textContent === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function type(selector: string, value: string) {
  const field = container.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function begin() {
  await mount();
  await type('input[placeholder="ssh root@203.0.113.10"]', "ssh root@89.58.51.102");
  await click("Continue");
}
async function trustAndLogin() {
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await click("Verify and sign in");
}

describe("SSH setup wizard", () => {
  it("requires host confirmation before submitting credentials and clears the password immediately", async () => {
    await begin();
    expect(container.textContent).toContain(identity.fingerprint);
    expect(button("Verify and sign in").disabled).toBe(true);
    await type('input[type="password"]', "test-only-secret");
    await trustAndLogin();
    expect(actions.login).toHaveBeenCalledWith({ id: identity.id, fingerprint: identity.fingerprint, password: "test-only-secret" });
    expect(container.innerHTML).not.toContain("test-only-secret");
    expect(actions.install).not.toHaveBeenCalled();
    expect(button("Install and connect")).toBeTruthy();
  });

  it("checks installation progress and automatically connects only after verification", async () => {
    await begin();
    await trustAndLogin();
    await click("Install and connect");
    expect(actions.connect).not.toHaveBeenCalled();
    expect(container.textContent).toContain("You can close Settings");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(actions.status).toHaveBeenCalledWith(identity.id);
    expect(actions.connect).toHaveBeenCalledTimes(1);
    expect(connected).toHaveBeenCalledWith({ profile });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(actions.connect).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed final connection retryable without rerunning the installation", async () => {
    vi.mocked(actions.connect).mockRejectedValueOnce(new Error("Error invoking remote method 'termloop:ssh-setup-connect': Error: Server is reconnecting"));
    await begin(); await trustAndLogin(); await click("Install and connect");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Server is reconnecting");
    expect(connected).not.toHaveBeenCalled();
    await click("Retry connection");
    expect(actions.install).toHaveBeenCalledTimes(1);
    expect(actions.connect).toHaveBeenCalledTimes(2);
    expect(connected).toHaveBeenCalledTimes(1);
  });

  it("shows failed installation and allows a matching development package without connecting", async () => {
    vi.mocked(actions.status).mockResolvedValue({ ...review, phase: "error", message: "The server build is not compatible." });
    await begin(); await trustAndLogin(); await click("Install and connect");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(container.textContent).toContain("not compatible");
    expect(container.textContent).toContain("Continue from your terminal");
    expect(container.textContent).toContain("same build in Advanced options");
    expect(actions.connect).not.toHaveBeenCalled();
    await click("Choose server package…");
    expect(actions.choosePackage).toHaveBeenCalledWith(identity.id);
    expect(button("Install and connect")).toBeTruthy();
  });

  it("keeps a start response available when its window closed while waiting", async () => {
    let resolve!: (state: SshSetupState) => void;
    vi.mocked(actions.start).mockReturnValue(new Promise((done) => { resolve = done; }));
    await mount();
    await type('input[placeholder="ssh root@203.0.113.10"]', "server.example");
    await click("Continue");
    await act(async () => root.unmount());
    await act(async () => resolve(identity));
    expect(actions.cancel).not.toHaveBeenCalled();
    root = createRoot(container);
  });

  it("guides unsupported computers to sharing and the existing-server form", async () => {
    vi.mocked(actions.current).mockResolvedValue({ ...identity, phase: "error", message: "Automatic setup currently supports Linux x64 servers with systemd." });
    const useExisting = vi.fn();
    await act(async () => root.render(createElement(SshSetupWizard, { actions, connected, useExisting })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Linux x64");
    expect(container.textContent).toContain("Settings → Servers → Share this computer");
    await click("Connect to an already installed server");
    expect(useExisting).toHaveBeenCalledTimes(1);
    expect(actions.install).not.toHaveBeenCalled();
    expect(actions.cancel).not.toHaveBeenCalled();
  });

  it("resumes installation after closing Settings without cancelling or starting it again", async () => {
    await begin(); await trustAndLogin(); await click("Install and connect");
    await act(async () => root.unmount());
    expect(actions.cancel).not.toHaveBeenCalled();
    vi.mocked(actions.current).mockResolvedValue({ ...review, phase: "installing", busy: true });
    root = createRoot(container);
    await mount();
    expect(container.textContent).toContain("You can close Settings");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(actions.install).toHaveBeenCalledTimes(1);
    expect(actions.start).toHaveBeenCalledTimes(1);
    expect(actions.connect).toHaveBeenCalledTimes(1);
  });

  it("clears an address-derived username when switching to an SSH alias", async () => {
    await mount();
    await type('input[placeholder="ssh root@203.0.113.10"]', "root@server-a");
    await type('input[placeholder="ssh root@203.0.113.10"]', "server-b");
    await click("Continue");
    expect(actions.start).toHaveBeenCalledWith({ address: "server-b" });
  });

  it("keeps an explicitly chosen username when the address changes", async () => {
    await mount();
    await type('input[placeholder="From SSH config"]', "admin");
    await type('input[placeholder="ssh root@203.0.113.10"]', "server-b");
    await click("Continue");
    expect(actions.start).toHaveBeenCalledWith({ address: "server-b", user: "admin" });
  });

  it("retains the address and clears previous trust when restarting setup", async () => {
    await begin();
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await click("Back");
    expect(actions.cancel).toHaveBeenCalledWith(identity.id);
    expect(container.querySelector<HTMLInputElement>('input[placeholder="ssh root@203.0.113.10"]')?.value).toBe("ssh root@89.58.51.102");
    await click("Continue");
    expect(button("Verify and sign in").disabled).toBe(true);
  });
});
