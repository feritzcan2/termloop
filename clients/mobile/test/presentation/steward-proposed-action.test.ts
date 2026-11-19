import { describe, expect, it } from "vitest";

import { stewardProposedActionView } from "../../src/presentation/steward-proposed-action";

describe("stewardProposedActionView", () => {
  it("maps a typed action to its fixed title and evidence", () => {
    expect(stewardProposedActionView({ kind: "taskClose", evidence: ["Jira: Done"] }))
      .toEqual({ title: "Close task", evidence: ["Jira: Done"] });
    expect(stewardProposedActionView({ kind: "taskAgentStart" }))
      .toEqual({ title: "Start task agent", evidence: [] });
  });

  it("leaves other, unknown, and missing actions to the Steward's text", () => {
    expect(stewardProposedActionView({ kind: "other", evidence: ["x"] })).toBeNull();
    expect(stewardProposedActionView({ kind: "futureKind" } as never)).toBeNull();
    expect(stewardProposedActionView(undefined)).toBeNull();
  });
});
