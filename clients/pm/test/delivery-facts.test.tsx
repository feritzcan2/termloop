// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { PmBoardTicket, PmDataTier, PmFactsSummary } from "@termloop/pm-contract/pm";
import { SprintOverview } from "../src/renderer/ui/SprintOverview.js";
import { SprintSidebar } from "../src/renderer/ui/SprintSidebar.js";
import { TicketFields } from "../src/renderer/ui/TicketFields.js";
import { boardTicket, playbook, sprint, stepState } from "./fixtures.js";
import { render } from "./render.js";

const noop = () => undefined;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

function facts(overrides: Partial<PmFactsSummary> = {}): PmFactsSummary {
  return { recordedAtEpochMs: 0, stale: false, jiraStatus: null, jiraAssignee: null, pullRequests: 2, failedReads: [], ...overrides };
}

function sidebar(tier: PmDataTier, entry: PmBoardTicket, versions?: Record<string, { number: number; description: string; recordedAtEpochMs: number }[]>) {
  const view = render(
    <SprintSidebar
      sprints={[sprint()]} tickets={[entry]} tier={tier} playbook={playbook()} versions={versions ?? {}}
      selectedSprintId="sprint-1" selectedTicketId={undefined} now={0}
      onSelectSprint={noop} onSelectTicket={noop} onCreateSprint={noop} onCreateTicket={noop} onMoveTicket={noop}
    />,
  );
  cleanup = view.unmount;
  return view.container.querySelector<HTMLElement>(".pm-ticket-item .row-sub")!;
}

/** Merged; the agent found the "Live" step waiting. */
function waitingLive(): PmBoardTicket {
  return boardTicket({}, {
    facts: facts(),
    playbook: { position: 2, steps: [stepState("started"), stepState("review"), stepState("merged"), stepState("live", { verdict: "waiting", evaluator: "agent", evidence: "Not in the prod deploy log yet" }), stepState("done")] },
  });
}

describe("playbook steps", () => {
  it("pill a sidebar row whose next step an agent found waiting", () => {
    expect(sidebar("deploy", boardTicket({}, { facts: facts() })).querySelector('[data-testid="step-pill"]')).toBeNull();
    const pill = sidebar("deploy", waitingLive()).querySelector<HTMLElement>('[data-testid="step-pill"]')!;
    expect(pill.textContent).toBe("waiting · live");
    expect(pill.title).toBe("Not in the prod deploy log yet");
  });

  it("list tickets waiting at a step in the overview at the deploy tier", () => {
    const view = render(
      <SprintOverview sprint={sprint()} sprints={[sprint()]} tickets={[waitingLive()]} tier="deploy" playbook={playbook()} digest={[]} now={0}
        onOpenTicket={noop} onActivate={noop} onClose={noop} onDelete={noop} />,
    );
    cleanup = view.unmount;
    const section = view.container.querySelector<HTMLElement>('[aria-label="Waiting at a step"]')!;
    expect(section.textContent).toContain("Live");
    expect(section.textContent).toContain("Not in the prod deploy log yet");
  });
});

describe("pull requests", () => {
  it("chip the sidebar row from the code tier when there are any", () => {
    expect(sidebar("tickets", boardTicket({}, { facts: facts() })).querySelector(".pr-chip")).toBeNull();
    expect(sidebar("code", boardTicket({}, { facts: facts() })).querySelector(".pr-chip")?.textContent).toBe("PR·2");
    expect(sidebar("code", boardTicket({}, { facts: facts({ pullRequests: 0 }) })).querySelector(".pr-chip")).toBeNull();
  });

  function line(tier: PmDataTier, entry: PmBoardTicket) {
    const view = render(<TicketFields ticket={entry.ticket} delivery={entry.delivery} sprints={[sprint()]} tier={tier} now={0} onUpdate={noop} onMoveSprint={noop} />);
    cleanup = view.unmount;
    const text = view.container.querySelector('[data-testid="pr-line"]')?.textContent;
    view.unmount();
    cleanup = undefined;
    return text;
  }

  it("read as a line in the ticket fields from the code tier", () => {
    expect(line("tickets", boardTicket({}, { facts: facts() }))).toBeUndefined();
    expect(line("code", boardTicket({}, { facts: facts() }))).toBe("2 pull requests");
    expect(line("code", boardTicket({}, { facts: facts({ pullRequests: 0 }) }))).toBe("No pull request");
    expect(line("code", boardTicket({}, {
      facts: facts({ failedReads: ["gitHost"] }),
      risks: [{ kind: "readFailed", detail: "Pull requests could not be read: token expired", sinceEpochMs: null }],
    }))).toBe("Pull requests unavailable: token expired");
  });
});

describe("scope tag", () => {
  it("marks a sidebar row whose loaded versions show the criteria grew since sprint start", () => {
    const entry = boardTicket({}, { facts: facts() });
    expect(sidebar("tickets", entry).querySelector('[data-testid="scope-tag"]')).toBeNull();
    const row = sidebar("tickets", entry, {
      "ticket-1": [
        { number: 1, description: "## Acceptance criteria\n- a", recordedAtEpochMs: -1 },
        { number: 2, description: "## Acceptance criteria\n- a\n- b\n- c", recordedAtEpochMs: 5 },
      ],
    });
    expect(row.querySelector<HTMLElement>('[data-testid="scope-tag"]')?.title).toBe("Acceptance criteria grew from 1 to 3 items since sprint start");
  });
});
