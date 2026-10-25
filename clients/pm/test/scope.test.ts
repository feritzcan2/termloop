import { describe, expect, it } from "vitest";
import { criteriaBlock, scopeGrowth, ticketScope, type ScopeVersion } from "../src/renderer/ui/scope.js";
import { sprint, ticket } from "./fixtures.js";

const criteria = (...items: string[]) => `# Goal\n\nShip it.\n\n## Acceptance criteria\n\n${items.map((item) => `- ${item}`).join("\n")}\n\n## Notes\n\n- not a criterion`;
const version = (number: number, description: string, recordedAtEpochMs: number): ScopeVersion => ({ number, description, recordedAtEpochMs });
const START = 1_000;

describe("criteria block", () => {
  it("reads list items under an acceptance criteria heading up to the next heading", () => {
    expect(criteriaBlock(criteria("a", "b", "c"))).toEqual({ items: 3, chars: "- a - b - c".length });
    expect(criteriaBlock("**Acceptance criteria:**\n1. one\n2) two\n* [ ] three")?.items).toBe(3);
    expect(criteriaBlock("# Goal\n\n- a\n- b")).toBeUndefined();
  });
});

describe("scope growth", () => {
  it("finds nothing without an acceptance criteria section", () => {
    expect(scopeGrowth([version(1, "Just text", 0), version(2, "Longer text with many more words added", 2_000)], START)).toBeUndefined();
  });

  it("finds nothing when the criteria did not change materially", () => {
    expect(scopeGrowth([version(1, criteria("a", "b", "c"), 0), version(2, criteria("a", "b", "c", "d"), 2_000)], START)).toBeUndefined();
    expect(scopeGrowth([version(1, criteria("a", "b"), 0)], START)).toBeUndefined();
  });

  it("flags two or more added items since sprint start", () => {
    const growth = scopeGrowth([
      version(1, criteria("a"), 0),
      version(2, criteria("a", "b", "c"), 500),
      version(3, criteria("a", "b", "c", "d", "e", "f"), 2_000),
    ], START);
    expect(growth?.since).toBe("sprintStart");
    expect(growth?.explanation).toBe("Acceptance criteria grew from 3 to 6 items since sprint start");
  });

  it("flags 40% more criteria text with the same item count", () => {
    const growth = scopeGrowth([
      version(1, criteria("users can pay", "receipts are sent"), 0),
      version(2, criteria("users can pay by card, wallet, or invoice", "receipts are sent by email and SMS"), 2_000),
    ], START);
    expect(growth?.explanation).toMatch(/^Acceptance criteria text grew \d+% since sprint start$/u);
  });

  it("compares with the first version when the ticket was written after the sprint started", () => {
    const growth = scopeGrowth([version(2, criteria("a", "b", "c", "d"), 3_000), version(1, criteria("a"), 2_000)], START);
    expect(growth?.since).toBe("firstVersion");
    expect(growth?.explanation).toBe("Acceptance criteria grew from 1 to 4 items since its first version");
  });

  it("needs a started sprint and versions loaded up to the ticket's head", () => {
    const versions = [version(1, criteria("a"), 0), version(2, criteria("a", "b", "c"), 2_000)];
    const started = sprint({ activatedAtEpochMs: START });
    expect(ticketScope(ticket(), [started], versions)?.to.items).toBe(3);
    expect(ticketScope(ticket(), [sprint({ state: "planned", activatedAtEpochMs: null })], versions)).toBeUndefined();
    expect(ticketScope(ticket({ versions: { count: 3, headNumber: 3, headAuthor: "pm", headRecordedAtEpochMs: 0 } }), [started], versions)).toBeUndefined();
    expect(ticketScope(ticket(), [started], undefined)).toBeUndefined();
  });
});
