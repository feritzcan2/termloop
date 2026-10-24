// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectModeResult, ProjectModeSetParams } from "@termloop/contract/current";

import { PROFILED_DESKTOP_OPERATIONS, isProfiledIpcChannel } from "../src/source-operations.js";
import {
  projectManagerModeEnabled,
  readProjectManagerModeFlag,
  setProjectManagerModeEnabled,
  subscribeProjectManagerModeFlag,
} from "../src/renderer/project-manager-mode-flag.js";
import { ProjectModeMenuItems, type ProjectModeActions } from "../src/renderer/ui/ProjectModeMenuItems.js";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

function memoryStorage(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [["termloop.experimental.projectManagerMode.v1", initial]]);
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

/// A daemon double: reads return the stored mode at the current revision, and
/// a write against any other revision is refused as the core would.
function daemon(initial: ProjectModeResult["mode"] = "developer") {
  let mode = initial;
  let revision = 7;
  const saves: ProjectModeSetParams[] = [];
  const actions: ProjectModeActions = {
    load: async (projectId) => ({ projectId, mode, stateRevision: revision }),
    save: async (params) => {
      saves.push(params);
      if (params.expectedRevision !== revision) throw new Error("conflict");
      mode = params.mode;
      revision += 1;
      return { projectId: params.projectId, mode, stateRevision: revision };
    },
  };
  return { actions, saves, bump: () => { revision += 1; } };
}

const radios = () => [...host.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]')];

describe("Project Manager mode flag", () => {
  it("is off unless this computer turned it on", () => {
    expect(readProjectManagerModeFlag(memoryStorage())).toBe(false);
    expect(readProjectManagerModeFlag(memoryStorage("off"))).toBe(false);
    expect(readProjectManagerModeFlag(memoryStorage("on"))).toBe(true);
    expect(readProjectManagerModeFlag({ getItem: () => { throw new Error("blocked"); } })).toBe(false);
  });

  it("notifies subscribers and remembers the choice", () => {
    const storage = memoryStorage();
    let notified = 0;
    const unsubscribe = subscribeProjectManagerModeFlag(() => { notified += 1; });
    setProjectManagerModeEnabled(true, storage);
    expect(projectManagerModeEnabled()).toBe(true);
    expect(readProjectManagerModeFlag(storage)).toBe(true);
    setProjectManagerModeEnabled(false, storage);
    expect(projectManagerModeEnabled()).toBe(false);
    expect(notified).toBe(2);
    unsubscribe();
  });
});

describe("Project mode menu", () => {
  it("allowlists the two Project mode operations as source-targeted channels", () => {
    expect(PROFILED_DESKTOP_OPERATIONS.projectModeGet).toBe("termloop:project-mode-get");
    expect(PROFILED_DESKTOP_OPERATIONS.projectModeSet).toBe("termloop:project-mode-set");
    expect(isProfiledIpcChannel("termloop:project-mode-get")).toBe(true);
    expect(isProfiledIpcChannel("termloop:project-mode-set")).toBe(true);
  });

  it("shows the stored mode and switches against a freshly read revision", async () => {
    const { actions, saves, bump } = daemon();
    await act(async () => root.render(<ProjectModeMenuItems projectId="project-1" disabled={false} actions={actions} />));
    expect(radios().map((button) => [button.textContent, button.getAttribute("aria-checked")])).toEqual([
      ["Developer", "true"],
      ["Project Manager", "false"],
    ]);
    bump();
    await act(async () => radios()[1]!.click());
    expect(saves).toEqual([{ projectId: "project-1", mode: "projectManager", expectedRevision: 8 }]);
    expect(radios()[1]!.getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not write when the current mode is chosen again and reports a refused write", async () => {
    const { actions, saves } = daemon("projectManager");
    const refusing: ProjectModeActions = { load: actions.load, save: async () => { throw new Error("Project not found"); } };
    await act(async () => root.render(<ProjectModeMenuItems projectId="project-1" disabled={false} actions={refusing} />));
    await act(async () => radios()[1]!.click());
    expect(saves).toEqual([]);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => radios()[0]!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Project not found");
    expect(radios()[1]!.getAttribute("aria-checked")).toBe("true");
  });
});
