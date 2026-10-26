// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PmPlaybookProposal } from "@termloop/pm-contract/pm";
import { PlaybookPanel, type PlaybookPanelProps } from "../src/renderer/ui/PlaybookPanel.js";
import { boardTicket, playbook, stepState } from "./fixtures.js";
import { render } from "./render.js";

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

function props(overrides: Partial<PlaybookPanelProps> = {}): PlaybookPanelProps {
  return {
    playbook: playbook(), proposal: null, tickets: [], now: 0, repository: "/work/shop",
    onOpenTicket: vi.fn(), onEdit: vi.fn(), onSetUp: vi.fn(), onApplyProposal: vi.fn(async () => true), onDiscardProposal: vi.fn(),
    ...overrides,
  };
}

const button = (container: HTMLElement, text: string) => [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));

describe("PlaybookPanel", () => {
  it("shows no steps until an agent created the Playbook, and starts that agent", () => {
    const onSetUp = vi.fn();
    const view = render(<PlaybookPanel {...props({ playbook: playbook({ revision: 0 }), onSetUp })} />);
    cleanup = view.unmount;
    expect(view.container.textContent).toContain("No Playbook yet");
    expect(view.container.querySelector(".playbook-rail")).toBeNull();
    expect(button(view.container, "Edit")).toBeUndefined();
    act(() => button(view.container, "Create with the agent")!.click());
    expect(onSetUp).toHaveBeenCalledOnce();
  });

  it("asks for the repository first when the project has none", () => {
    const view = render(<PlaybookPanel {...props({ playbook: playbook({ revision: 0 }), repository: null })} />);
    cleanup = view.unmount;
    expect(button(view.container, "Choose repository…")).toBeDefined();
  });

  it("offers the agent's proposal for review before any Playbook exists", () => {
    const proposal: PmPlaybookProposal = { projectId: "project-1", summary: "From the deploy pipeline.", steps: playbook().steps, createdAtEpochMs: 0 };
    const view = render(<PlaybookPanel {...props({ playbook: playbook({ revision: 0 }), proposal })} />);
    cleanup = view.unmount;
    expect(view.container.textContent).toContain("proposed 5 steps");
    act(() => button(view.container, "Review proposal")!.click());
    expect(document.querySelector('[aria-label="Set up the Playbook"]')).not.toBeNull();
  });

  it("lists the steps with how each passes, how many tickets stand at it, and who waits on it", () => {
    const onOpenTicket = vi.fn();
    const waiting = boardTicket({ id: "t-1", title: "Checkout button" }, {
      playbook: {
        position: 2,
        steps: [stepState("started"), stepState("review"), stepState("merged"), stepState("live", { verdict: "waiting", evaluator: "agent", evidence: "Not deployed" }), stepState("done")],
      },
    });
    const fresh = boardTicket({ id: "t-2" }, { playbook: { position: null, steps: [] } });
    const view = render(<PlaybookPanel {...props({ tickets: [waiting, fresh], onOpenTicket })} />);
    cleanup = view.unmount;
    const steps = [...view.container.querySelectorAll<HTMLElement>(".playbook-rail-step")];
    expect(steps.map((step) => step.querySelector("b")!.textContent)).toEqual(["Not started", "In progress", "In review", "Merged", "Live", "Done"]);
    expect(steps.map((step) => step.querySelector(".n")!.textContent)).toEqual(["1", "0", "0", "1", "0", "0"]);
    expect(steps[4]!.textContent).toContain("an agent checks");
    act(() => button(steps[4]!, "Checkout button")!.click());
    expect(onOpenTicket).toHaveBeenCalledWith("t-1");
  });
});
