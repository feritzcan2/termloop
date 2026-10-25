// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { PmDataTier } from "@termloop/pm-contract/pm";
import { SprintOverview } from "../src/renderer/ui/SprintOverview.js";
import { SprintSidebar } from "../src/renderer/ui/SprintSidebar.js";
import { boardTicket, sprint } from "./fixtures.js";
import { render } from "./render.js";

const noop = () => undefined;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

function sidebar(tier: PmDataTier) {
  const view = render(
    <SprintSidebar
      sprints={[sprint()]}
      tickets={[boardTicket({ carryOverCount: 2 }, { checking: true, risks: [{ kind: "mergedNotDeployed", detail: "Merged 3 days ago", sinceEpochMs: null }] })]}
      tier={tier}
      selectedSprintId="sprint-1"
      selectedTicketId={undefined}
      onSelectSprint={noop}
      onSelectTicket={noop}
      onCreateSprint={noop}
      onCreateTicket={noop}
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
      tickets={[boardTicket({}, { risks: [{ kind: "mergedNotDeployed", detail: "Merged 3 days ago", sinceEpochMs: null }] })]}
      tier={tier}
      digest={[]}
      now={0}
      onOpenTicket={noop}
      onActivate={noop}
      onClose={noop}
    />,
  );
  cleanup = view.unmount;
  return view.container;
}

describe("data tiers", () => {
  it("hides the ticket stage pill below the code tier", () => {
    const container = sidebar("tickets");
    expect(container.querySelector('[data-testid="stage-pill"]')).toBeNull();
    expect(container.textContent).toContain("SHOP-7 · ada");
    expect(container.textContent).toContain("↻2");
    expect(container.textContent).toContain("checking…");
  });

  it("shows the stage pill from the code tier up", () => {
    expect(sidebar("code").querySelector('[data-testid="stage-pill"]')?.textContent).toContain("Merged");
  });

  it("shows where-it-runs only at the deploy tier", () => {
    expect(overview("tickets").textContent).not.toContain("Where it runs is unknown");
    expect(overview("code").textContent).not.toContain("Where it runs is unknown");
    const deploy = overview("deploy");
    expect(deploy.textContent).toContain("Where it runs is unknown");
    expect(deploy.textContent).toContain("Needs attention");
  });
});
