// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseUpdateStatus, type UpdateStatus } from "../src/update-status.js";
import { UpdateNotice, UpdateSettings, updateStatusText, type AppUpdateControls } from "../src/renderer/ui/AppUpdate.js";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function controls(status: UpdateStatus): AppUpdateControls {
  return { snapshot: { currentVersion: "2.0.10", status }, check: vi.fn(), install: vi.fn() };
}

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  if (!match) throw new Error(`missing button ${label}`);
  return match;
}

describe("application update presentation", () => {
  it("keeps quiet states out of the sidebar", () => {
    for (const status of [{ state: "idle" }, { state: "checking" }, { state: "current" }, { state: "failed", version: null, reason: null }] as UpdateStatus[]) {
      act(() => root.render(createElement(UpdateNotice, { update: controls(status) })));
      expect(container.innerHTML).toBe("");
    }
  });

  it("shows download progress in the sidebar", () => {
    act(() => root.render(createElement(UpdateNotice, {
      update: controls({ state: "downloading", version: "2.0.11", percent: 42 }),
    })));

    expect(container.textContent).toContain("Downloading update");
    expect(container.textContent).toContain("TermLoop 2.0.11 · 42%");
    expect(container.querySelector("progress")?.value).toBe(42);
  });

  it("restarts from the sidebar once the update is ready", () => {
    const update = controls({ state: "ready", version: "2.0.11" });
    act(() => root.render(createElement(UpdateNotice, { update })));

    expect(container.textContent).toContain("Update ready");
    act(() => button("Restart").click());
    expect(update.install).toHaveBeenCalledTimes(1);
  });

  it("retries a failed download from the sidebar", () => {
    const update = controls({ state: "failed", version: "2.0.11", reason: null });
    act(() => root.render(createElement(UpdateNotice, { update })));

    act(() => button("Retry").click());
    expect(update.check).toHaveBeenCalledTimes(1);
  });

  it("shows the version and a manual check in Settings", () => {
    const update = controls({ state: "current" });
    act(() => root.render(createElement(UpdateSettings, { update })));

    expect(container.textContent).toContain("2.0.10");
    expect(container.textContent).toContain("TermLoop is up to date.");
    act(() => button("Check for updates").click());
    expect(update.check).toHaveBeenCalledTimes(1);
  });

  it("names the failure code and the automatic retry", () => {
    expect(updateStatusText({ state: "failed", version: null, reason: "ENOENT" }))
      .toBe("The update check failed (ENOENT). TermLoop retries in a few minutes.");
    expect(updateStatusText({ state: "failed", version: "2.0.12", reason: null }))
      .toBe("Downloading TermLoop 2.0.12 failed. TermLoop retries automatically.");
  });

  it("offers no update actions in a build without an update feed", () => {
    act(() => root.render(createElement(UpdateSettings, { update: controls({ state: "unsupported" }) })));

    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("installed macOS and Windows app");
  });

  it("accepts only well-formed status messages from the bridge", () => {
    expect(parseUpdateStatus({ state: "downloading", version: "2.0.11", percent: 5 }))
      .toEqual({ state: "downloading", version: "2.0.11", percent: 5 });
    expect(parseUpdateStatus({ state: "failed" })).toEqual({ state: "failed", version: null, reason: null });
    expect(parseUpdateStatus({ state: "failed", reason: "net::ERR_NAME_NOT_RESOLVED" }))
      .toEqual({ state: "failed", version: null, reason: "net::ERR_NAME_NOT_RESOLVED" });
    expect(parseUpdateStatus({ state: "failed", reason: "https://updates.termloop.ai/stable/latest.yml failed" }))
      .toEqual({ state: "failed", version: null, reason: null });
    expect(parseUpdateStatus({ state: "ready" })).toBeUndefined();
    expect(parseUpdateStatus({ state: "unknown" })).toBeUndefined();
    expect(parseUpdateStatus(null)).toBeUndefined();
  });
});
