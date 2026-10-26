// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { PmDataTier } from "@termloop/pm-contract/pm";
import { SprintOverview } from "../src/renderer/ui/SprintOverview.js";
import { SprintSidebar } from "../src/renderer/ui/SprintSidebar.js";
import { boardTicket, playbook, sprint } from "./fixtures.js";
import { render } from "./render.js";

const noop = () => undefined;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

function sidebar(tier: PmDataTier) {
  const view = render(
    <SprintSidebar
      sprints={[sprint()]}
      tickets={[boardTicket({ carryOverCount: 2 }, { checking: true, risks: [{ kind: "stepBlocked", detail: "Merged 3 days ago", sinceEpochMs: null }] })]}
      tier={tier}
      playbook={playbook()}
      selectedSprintId="sprint-1"
      selectedTicketId={undefined}
      onSelectSprint={noop}
      onSelectTicket={noop}
      onCreateSprint={noop}
      onCreateTicket={noop}
      onMoveTicket={noop}
    />,
  );
  cleanup = view.unmount;
  return view.container;
}

function overview(tier: PmDataTier) {
  const view = render(
    <SprintOverview
      sprint={sprint()}
      sprints={[sprint()]}
      tickets={[boardTicket({}, { facts: { recordedAtEpochMs: 0, stale: false, jiraStatus: null, jiraAssignee: null, pullRequests: 2, failedReads: [] } })]}
      tier={tier}
      playbook={playbook()}
      digest={[]}
      now={0}
      onOpenTicket={noop}
      onActivate={noop}
      onClose={noop}
      onDelete={noop}
      jiraBoardId={null}
    />,
  );
  cleanup = view.unmount;
  return view.container;
}

describe("data tiers", () => {
  it("shows the row's basics at every tier", () => {
    const row = sidebar("tickets").querySelector(".pm-ticket-item .row")!;
    expect(row.querySelector(".key")?.textContent).toBe("SHOP-7");
    expect(row.querySelector(".who")?.textContent).toBe("ada");
    expect(row.textContent).toContain("carried over ×2");
    expect(row.textContent).toContain("checking…");
  });

  it("sections the sprint by the step each ticket passed", () => {
    expect([...sidebar("tickets").querySelectorAll(".pm-status-head")].map((element) => element.firstChild?.textContent)).toEqual(["Merged"]);
  });

  it("shows linked pull requests on board cards from the code tier", () => {
    expect(overview("tickets").querySelector(".board-card .pr-chip")).toBeNull();
    expect(overview("code").querySelector(".board-card .pr-chip")?.textContent).toBe("PR·2");
  });
});
