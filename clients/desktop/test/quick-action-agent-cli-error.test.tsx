// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QuickActionComposer } from "../src/renderer/ui/QuickActionComposer.js";
import { fullAgentCapability } from "./agent-capability-fixture.js";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const project = { id: "project-1", name: "TermNext", folder_path: "/tmp/termnext" };

async function renderWithPreviewFailure(message: string, openAgentAccounts?: () => void) {
  const preview = vi.fn(async () => { throw new Error(message); });
  await act(async () => root.render(<QuickActionComposer
    projects={[project]}
    selectedProject={project}
    capabilities={[fullAgentCapability("codex")]}
    profiles={[]}
    openAgentAccounts={openAgentAccounts}
    pasteImage={vi.fn()} restoreImage={vi.fn()} discardImage={vi.fn()} preview={preview as never} launch={vi.fn()} close={vi.fn()}
  />));
  const prompt = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "do the thing");
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
  expect(preview).toHaveBeenCalled();
  return host.querySelector<HTMLElement>(".quick-action-error");
}

describe("Quick Action launch errors", () => {
  it("explains a missing provider CLI and offers installation instead of the raw transport error", async () => {
    const openAgentAccounts = vi.fn();
    const notice = await renderWithPreviewFailure(
      "Error invoking remote method 'termloop:quick-action-preview': TermLoopControlError: terminal failed: agent CLI for codex was not found on the launch PATH",
      openAgentAccounts,
    );
    expect(notice?.textContent).toContain("Codex CLI isn’t installed");
    expect(notice?.textContent).toContain("codex");
    expect(notice?.textContent).not.toContain("Error invoking remote method");
    expect(notice?.textContent).not.toContain("launch PATH");
    const install = [...notice!.querySelectorAll("button")].find((button) => button.textContent?.includes("Install Codex CLI"));
    await act(async () => install!.click());
    expect(openAgentAccounts).toHaveBeenCalledOnce();
  });

  it("omits the install action when Agent accounts are unavailable", async () => {
    const notice = await renderWithPreviewFailure(
      "Error invoking remote method 'termloop:quick-action-preview': TermLoopControlError: terminal failed: agent CLI for codex exists but cannot be launched",
    );
    expect(notice?.textContent).toContain("Codex CLI can’t be started");
    expect(notice?.querySelector("button")).toBeNull();
  });

  it("shows other launch failures without the transport wrapper", async () => {
    const notice = await renderWithPreviewFailure(
      "Error invoking remote method 'termloop:quick-action-preview': TermLoopControlError: terminal failed: working directory is unavailable",
    );
    expect(notice?.textContent).toBe("working directory is unavailable");
  });
});
