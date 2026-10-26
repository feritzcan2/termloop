// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { ProjectSwitcher } from "../src/renderer/ui/ProjectSwitcher.js";
import { STATUS_DOT, agentTone, dayRuler, lastJiraPull, nextStep, sprintDay, stepColumns, stepSections, ticketStep } from "../src/renderer/ui/format.js";
import { boardTicket, playbook, sprint, stepState } from "./fixtures.js";
import { render } from "./render.js";

const at = (year: number, month: number, day: number, hour = 12) => new Date(year, month - 1, day, hour).getTime();

describe("sprint day ruler", () => {
  // Mon 2 Nov 2026 to Sun 15 Nov 2026: fourteen days, two weekends.
  const twoWeeks = sprint({ activatedAtEpochMs: at(2026, 11, 2, 9), endsAtEpochMs: at(2026, 11, 15, 18) });

  it("draws one cell per sprint day with past, today, and weekends marked", () => {
    const days = dayRuler(twoWeeks, at(2026, 11, 9));
    expect(days).toHaveLength(14);
    expect(days.map((day) => day.label)).toEqual(["2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"]);
    expect(days.filter((day) => day.kind === "past")).toHaveLength(7);
    expect(days[7]).toMatchObject({ label: "9", kind: "today", weekend: false });
    expect(days.filter((day) => day.weekend).map((day) => day.label)).toEqual(["7", "8", "14", "15"]);
    expect(sprintDay(twoWeeks, at(2026, 11, 9))).toEqual({ day: 8, of: 14 });
  });

  it("is empty without an end date and counts a finished sprint as its last day", () => {
    expect(dayRuler(sprint({ endsAtEpochMs: null }), at(2026, 11, 9))).toEqual([]);
    expect(sprintDay(sprint({ endsAtEpochMs: null }), at(2026, 11, 9))).toBeUndefined();
    expect(dayRuler(twoWeeks, at(2026, 12, 1)).every((day) => day.kind === "past")).toBe(true);
    expect(sprintDay(twoWeeks, at(2026, 12, 1))).toEqual({ day: 14, of: 14 });
    expect(sprintDay(twoWeeks, at(2026, 10, 1))).toEqual({ day: 0, of: 14 });
  });

  it("falls back to the creation day and refuses spans too long to draw", () => {
    expect(dayRuler(sprint({ activatedAtEpochMs: null, createdAtEpochMs: at(2026, 11, 2), endsAtEpochMs: at(2026, 11, 4) }), at(2026, 11, 3))).toHaveLength(3);
    expect(dayRuler(sprint({ activatedAtEpochMs: at(2026, 1, 1), endsAtEpochMs: at(2026, 6, 1) }), at(2026, 3, 1))).toEqual([]);
  });
});

describe("sidebar tones", () => {
  it("maps ticket statuses and agent states to dot tones", () => {
    expect(STATUS_DOT).toEqual({ todo: "todo", inProgress: "progress", inReview: "inreview", done: "done" });
    expect(agentTone("running", "assistant")).toBe("working");
    expect(agentTone("running", "deliveryCheck")).toBe("review");
    expect(agentTone("starting", "assistant")).toBe("awaiting");
    expect(agentTone("exited", "deliveryCheck")).toBe("exited");
  });

  it("gives the board one column per step, Not started first, empty ones kept", () => {
    const standing = (position: number | null) => ({ playbook: { position, steps: [] } });
    const lane = [boardTicket({ id: "a" }, standing(2)), boardTicket({ id: "b" }, standing(null)), boardTicket({ id: "c" }, standing(4))];
    expect(stepColumns(lane, playbook()).map((column) => [column.title, column.tickets.map((entry) => entry.ticket.id)]))
      .toEqual([["Not started", ["b"]], ["In progress", []], ["In review", []], ["Merged", ["a"]], ["Live", []], ["Done", ["c"]]]);
  });

  it("splits a lane into Playbook sections, Not started first, skipping empty steps", () => {
    const standing = (position: number | null) => ({ playbook: { position, steps: [] } });
    const lane = [boardTicket({ id: "a" }, standing(2)), boardTicket({ id: "b" }, standing(null)), boardTicket({ id: "c" }, standing(2))];
    expect(stepSections(lane, playbook()).map((section) => [section.title, section.tickets.map((entry) => entry.ticket.id)]))
      .toEqual([["Not started", ["b"]], ["Merged", ["a", "c"]]]);
  });

  it("names the step a ticket passed and the one it works toward", () => {
    const merged = boardTicket({}, { playbook: { position: 2, steps: [stepState("started"), stepState("review"), stepState("merged"), stepState("live", { verdict: "blocked", evaluator: "agent", evidence: "Deploy failed" })] } });
    expect(ticketStep(playbook(), merged.delivery)?.title).toBe("Merged");
    expect(nextStep(playbook(), merged.delivery)?.step.id).toBe("live");
    const finished = boardTicket({}, { playbook: { position: 4, steps: [] } });
    expect(nextStep(playbook(), finished.delivery)).toBeUndefined();
  });

  it("finds the newest Jira pull on sprints and tickets", () => {
    expect(lastJiraPull([sprint()], [boardTicket()])).toBeUndefined();
    expect(lastJiraPull([sprint({ jiraPulledAtEpochMs: 5 })], [boardTicket({ jiraPulledAtEpochMs: 9 })])).toBe(9);
  });
});

describe("ProjectSwitcher", () => {
  it("opens a menu of projects and a New project form from the trigger", () => {
    const onSelectProject = vi.fn();
    const onCreateProject = vi.fn();
    const projects = [
      { id: "p1", name: "Nucleus", folder: null, createdAtEpochMs: 0 },
      { id: "p2", name: "Shop", folder: null, createdAtEpochMs: 0 },
    ];
    const { container, unmount } = render(
      <ProjectSwitcher projects={projects} projectId="p1" onSelectProject={onSelectProject} onCreateProject={onCreateProject} />,
    );
    const trigger = container.querySelector<HTMLButtonElement>(".project-trigger")!;
    expect(trigger.textContent).toBe("NNucleus");
    act(() => trigger.click());
    const items = [...container.querySelectorAll<HTMLButtonElement>('[role="menu"] button')];
    expect(items.map((item) => item.textContent)).toEqual(["NNucleus", "SShop", "New project"]);
    act(() => items[1]!.click());
    expect(onSelectProject).toHaveBeenCalledWith("p2");
    expect(container.querySelector('[role="menu"]')).toBeNull();
    act(() => trigger.click());
    act(() => [...container.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].at(-1)!.click());
    expect(container.querySelector('input[aria-label="Project name"]')).not.toBeNull();
    unmount();
  });
});
