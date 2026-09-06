// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { McpToolSettingsResult } from "@termloop/contract/current";
import type { PromptAsset } from "../src/renderer/prompt-settings.js";
import { McpRail } from "../src/renderer/ui/McpRail.js";
import { PromptsRail } from "../src/renderer/ui/PromptsRail.js";

const settings: McpToolSettingsResult = {
  stateRevision: 3,
  tools: [
    { name: "ask_to", title: "Ask another agent", canonicalDescription: "Canonical", effectiveDescription: "Ask another agent for help.", customized: true, roles: ["interactive"] },
    { name: "reply_to_request", title: "Reply to a request", canonicalDescription: "Canonical", effectiveDescription: "Answer the agent that asked.", customized: false, roles: ["helper"] },
    { name: "project_read", title: "Read the Project", canonicalDescription: "Canonical", effectiveDescription: "Read Project projections.", customized: false, roles: ["steward"] },
  ],
};

const prompts: PromptAsset[] = [
  { id: "builtin.agent.interactive", title: "Interactive agent", category: "Agent", version: 7, canonicalBody: "Agent", effectiveBody: "Agent", customized: false, source: "builtIn" },
  { id: "builtin.agent.quick", title: "Quick Action", category: "Agent", version: 2, canonicalBody: "Quick", effectiveBody: "Quick", customized: true, source: "builtIn" },
  { id: "runtime.steward.protected", title: "TermLoop instructions", category: "Steward", version: undefined, canonicalBody: "Protected", effectiveBody: "Protected", customized: false, source: "project", editable: false },
];

describe("Settings rails", () => {
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

  const groups = () => [...container.querySelectorAll<HTMLElement>(".rail-group")];
  const groupLabels = () => groups().map((group) => group.querySelector(".rail-group-head span")?.textContent);

  it("lists MCP tools under every profile that sees them, Interactive open first", async () => {
    const openTool = vi.fn();
    await act(async () => root.render(createElement(McpRail, {
      settings,
      error: undefined,
      loading: false,
      selectedTool: undefined,
      openTool,
      reload: vi.fn(),
    })));

    expect(groupLabels()).toEqual(["Interactive", "Helper", "Steward", "Worker"]);
    const [interactive, helper, steward] = groups();
    expect(interactive?.querySelector("button.rail-group-head")?.getAttribute("aria-expanded")).toBe("true");
    expect(interactive?.textContent).toContain("Ask another agent");
    // A customized description is marked without opening the tool.
    expect(interactive?.querySelector(".rail-row-mark")).not.toBeNull();
    expect(helper?.querySelectorAll(".rail-row")).toHaveLength(0);
    expect(steward?.querySelectorAll(".rail-row")).toHaveLength(0);

    await act(async () => helper?.querySelector<HTMLButtonElement>("button.rail-group-head")?.click());
    expect(helper?.querySelectorAll(".rail-row")).toHaveLength(1);

    await act(async () => interactive?.querySelector<HTMLButtonElement>(".rail-row-open")?.click());
    expect(openTool).toHaveBeenCalledWith("ask_to");
  });

  it("searches MCP tools across every profile and opens the matches", async () => {
    await act(async () => root.render(createElement(McpRail, {
      settings,
      error: undefined,
      loading: false,
      selectedTool: "project_read",
      openTool: vi.fn(),
      reload: vi.fn(),
    })));

    const input = container.querySelector<HTMLInputElement>(".rail-search input");
    await act(async () => {
      if (!input) throw new Error("search input missing");
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(input, "projections");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(groupLabels()).toEqual(["Steward", "Worker"]);
    const rows = [...container.querySelectorAll<HTMLElement>(".rail-row")];
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.classList.contains("selected"))).toBe(true);
    expect(rows[0]?.querySelector(".rail-row-open")?.getAttribute("aria-current")).toBe("true");
  });

  it("groups prompts by category and opens one by id", async () => {
    const openPrompt = vi.fn();
    await act(async () => root.render(createElement(PromptsRail, {
      prompts,
      error: undefined,
      loading: false,
      selectedId: undefined,
      openPrompt,
      reload: vi.fn(),
    })));

    expect(groupLabels()).toEqual(["Agent", "Steward"]);
    const [agent, steward] = groups();
    expect(agent?.querySelectorAll(".rail-row")).toHaveLength(2);
    // Later categories stay collapsed until asked for.
    expect(steward?.querySelector("button.rail-group-head")?.getAttribute("aria-expanded")).toBe("false");
    expect(agent?.textContent).toContain("Built-in template");

    await act(async () => steward?.querySelector<HTMLButtonElement>("button.rail-group-head")?.click());
    await act(async () => steward?.querySelector<HTMLButtonElement>(".rail-row-open")?.click());
    expect(openPrompt).toHaveBeenCalledWith("runtime.steward.protected");
  });

  it("offers Improve with agent on the entries an agent may rewrite", async () => {
    const improveTool = vi.fn();
    await act(async () => root.render(createElement(McpRail, {
      settings,
      error: undefined,
      loading: false,
      selectedTool: undefined,
      openTool: vi.fn(),
      improveTool,
      reload: vi.fn(),
    })));

    const improve = container.querySelector<HTMLButtonElement>('[aria-label="Improve Ask another agent with agent"]');
    await act(async () => improve?.click());
    expect(improveTool).toHaveBeenCalledWith("ask_to", "Ask another agent");

    const improvePrompt = vi.fn();
    await act(async () => root.render(createElement(PromptsRail, {
      prompts: [
        { ...prompts[0]!, overridePath: "/profile/prompt-overrides/builtin.agent.interactive.md" },
        prompts[2]!,
      ],
      error: undefined,
      loading: false,
      selectedId: undefined,
      openPrompt: vi.fn(),
      improvePrompt,
      reload: vi.fn(),
    })));

    await act(async () => container
      .querySelector<HTMLButtonElement>('[aria-label="Improve Interactive agent with agent"]')?.click());
    expect(improvePrompt).toHaveBeenCalledWith(expect.objectContaining({ id: "builtin.agent.interactive" }));

    // A runtime projection has no improver: nothing may rewrite it.
    const stewardGroup = groups()[1];
    await act(async () => stewardGroup?.querySelector<HTMLButtonElement>("button.rail-group-head")?.click());
    expect(stewardGroup?.querySelector(".rail-row-improve")).toBeNull();
  });

  it("reports a failed load and offers a reload", async () => {
    const reload = vi.fn();
    await act(async () => root.render(createElement(PromptsRail, {
      prompts: undefined,
      error: "daemon unavailable",
      loading: false,
      selectedId: undefined,
      openPrompt: vi.fn(),
      reload,
    })));

    expect(container.querySelector(".settings-rail-error")?.textContent).toContain("daemon unavailable");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Reload prompts"]')?.click());
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
