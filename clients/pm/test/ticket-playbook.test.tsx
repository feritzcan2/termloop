// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { PmController } from "../src/renderer/composition/pm-controller.js";
import { createPmStore } from "../src/renderer/state/presentation-store.js";
import { TicketPlaybook } from "../src/renderer/ui/TicketPlaybook.js";
import { boardTicket, fakeBridge, ok, playbook, stepState } from "./fixtures.js";
import { render } from "./render.js";

const MINUTE = 60_000;

/** Merged by facts; the agent found "Live" waiting and looks again in 20 minutes. */
function merged() {
  return boardTicket({}, {
    playbook: {
      position: 2,
      steps: [
        stepState("started", { implied: true }),
        stepState("review", { implied: true }),
        stepState("merged", { verdict: "passed", evaluator: "facts", evidence: "PR #12 merged" }),
        stepState("live", { verdict: "waiting", evaluator: "agent", evidence: "Not in the prod deploy log yet", decidedAtEpochMs: 0, nextAttemptAtEpochMs: 30 * MINUTE }),
        stepState("done"),
      ],
    },
  }).delivery;
}

describe("TicketPlaybook", () => {
  it("lists every step with who answered it, and checks or marks the next one", () => {
    const onCheck = vi.fn();
    const onMark = vi.fn();
    const { container, unmount } = render(<TicketPlaybook playbook={playbook()} delivery={merged()} now={10 * MINUTE} onCheck={onCheck} onMark={onMark} />);
    expect(container.querySelector("h3")?.textContent).toBe("Playbook 3 of 5 steps");
    const steps = [...container.querySelectorAll<HTMLElement>(".ticket-step")];
    expect(steps.map((step) => step.className.trim().replace(/\s+/g, " "))).toEqual([
      "ticket-step passed", "ticket-step passed", "ticket-step passed", "ticket-step waiting next", "ticket-step open",
    ]);
    expect(steps[0]!.textContent).toContain("Passed: a later step passed.");
    expect(steps[2]!.textContent).toContain("Facts: PR #12 merged");
    expect(steps[3]!.textContent).toContain("Agent: Not in the prod deploy log yet · 10m ago · looks again in 20m");
    // Facts re-derive, so only the agent's answer can be cleared.
    expect(steps[2]!.querySelector("button")).toBeNull();
    const live = (text: string) => [...steps[3]!.querySelectorAll("button")].find((button) => button.textContent === text)!;
    act(() => live("Check now").click());
    expect(onCheck).toHaveBeenCalled();
    act(() => live("Mark passed").click());
    act(() => live("Clear").click());
    expect(onMark.mock.calls).toEqual([["live", true], ["live", false]]);
    unmount();
  });

  it("marks a step through pm_playbook_step_mark and rereads the board", async () => {
    const board = { projectId: "project-1", sprints: [], tickets: [], playbook: playbook(), runningChecks: [], epics: [], epicBreakdowns: [], tracking: { jira: false, code: false, deploy: true, tier: "deploy" } };
    const bridge = fakeBridge((method) => (method === "pm_board_read" ? ok(board) : method === "pm_digest_read" ? ok({ projectId: "project-1", entries: [] }) : ok({})));
    await new PmController(bridge, createPmStore({ projectId: "project-1" })).markStep("ticket-1", "live", true);
    expect(bridge.calls[0]).toEqual({ method: "pm_playbook_step_mark", params: { ticketId: "ticket-1", stepId: "live", passed: true } });
    expect(bridge.calls.map((call) => call.method)).toContain("pm_board_read");
  });
});
