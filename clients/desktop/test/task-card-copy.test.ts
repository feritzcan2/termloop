import { describe, expect, it } from "vitest";
import { compactBranchName, plainTaskBrief, taskCardStatus, taskCardTitle } from "../src/renderer/task-card-copy.js";
import type { TaskIntegration, TaskStage } from "../src/renderer/task-presentation.js";

const ready: TaskStage = { id: "ready", tone: "quiet", flag: undefined, summary: "Ready to run agents.", note: undefined };

function integration(overrides: Partial<TaskIntegration>): TaskIntegration {
  return { tone: "quiet", label: "Open", title: "open", action: undefined, pullRequest: undefined, ...overrides };
}

describe("Task card title", () => {
  it("pulls the issue key and a leading scope tag out of the title", () => {
    expect(taskCardTitle("[Users service] Replace regex filter", "NUCLEUS-2651")).toEqual({
      key: "NUCLEUS-2651",
      scope: "Users service",
      title: "Replace regex filter",
    });
    expect(taskCardTitle("NUCLEUS-2651: [Users] Fix search", "NUCLEUS-2651")).toEqual({
      key: "NUCLEUS-2651",
      scope: "Users",
      title: "Fix search",
    });
    expect(taskCardTitle("Plain title", undefined)).toEqual({ key: undefined, scope: undefined, title: "Plain title" });
  });

  it("keeps the original words when nothing but a key or scope remains", () => {
    expect(taskCardTitle("[Users]", undefined).title).toBe("[Users]");
    expect(taskCardTitle("ABC-1", "ABC-1").title).toBe("ABC-1");
  });
});

describe("Task card brief", () => {
  it("flattens Jira wiki markup into one readable line", () => {
    expect(plainTaskBrief("*Component:* Nucleus.Services.Users / {{GET /api/v1/search/users}}\nh2. Details\n* first [docs|https://x.test]"))
      .toBe("Component: Nucleus.Services.Users / GET /api/v1/search/users Details first docs");
    expect(plainTaskBrief("{code:java}int x;{code} done")).toBe("int x; done");
    expect(plainTaskBrief("   ")).toBeUndefined();
    expect(plainTaskBrief(null)).toBeUndefined();
  });
});

describe("Task card branch", () => {
  it("shows the last branch segment", () => {
    expect(compactBranchName("feature/users-search-regex")).toBe("users-search-regex");
    expect(compactBranchName("main")).toBe("main");
    expect(compactBranchName("weird/")).toBe("weird/");
  });
});

describe("Task card status", () => {
  const base = { stage: ready, attention: undefined, integration: undefined, hasLocalChanges: false, hasOpenPullRequest: false, attentionShownElsewhere: false };

  it("prefers a waiting agent unless the card's action already names it", () => {
    const attention = { sessionId: "s", label: "Needs input", agent: "Claude", tone: "attention" as const };
    expect(taskCardStatus({ ...base, attention })?.label).toBe("Needs input");
    expect(taskCardStatus({ ...base, attention, attentionShownElsewhere: true })).toBeUndefined();
    const working = { ...attention, label: "Working", tone: "working" as const };
    expect(taskCardStatus({ ...base, attention: working, attentionShownElsewhere: true })?.tone).toBe("working");
  });

  it("summarises delivery as In review or Done", () => {
    expect(taskCardStatus({ ...base, integration: integration({ tone: "done", label: "In base" }) })?.label).toBe("Done");
    expect(taskCardStatus({ ...base, hasLocalChanges: true, integration: integration({ tone: "done" }) })).toBeUndefined();
    expect(taskCardStatus({ ...base, integration: integration({ action: "pullRequest" }) })).toMatchObject({ label: "In review", tone: "review" });
    expect(taskCardStatus({ ...base, integration: integration({ action: "pullRequest", tone: "attention" }) })?.tone).toBe("attention");
    expect(taskCardStatus({ ...base, integration: integration({ tone: "attention", action: "commits" }) })).toBeUndefined();
    /// An open pull request outranks a local "in base" verdict.
    expect(taskCardStatus({ ...base, hasOpenPullRequest: true, integration: integration({ tone: "done", label: "In base" }) }))
      .toMatchObject({ label: "In review", tone: "review" });
  });

  it("leaves structural trouble to the meta-line flag", () => {
    const blocked: TaskStage = { ...ready, id: "repair", tone: "blocked", flag: "Needs repair" };
    expect(taskCardStatus({ ...base, stage: blocked, integration: integration({ tone: "done" }) })).toBeUndefined();
  });
});
