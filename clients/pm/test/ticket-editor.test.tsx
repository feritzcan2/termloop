// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PmBoardTicket } from "@termloop/pm-contract/pm";
import { PmController } from "../src/renderer/composition/pm-controller.js";
import { createPmStore } from "../src/renderer/state/presentation-store.js";
import { MarkdownEditor } from "../src/renderer/ui/MarkdownEditor.js";
import { TicketEditor, type TicketEditorProps } from "../src/renderer/ui/TicketEditor.js";
import { TicketFields } from "../src/renderer/ui/TicketFields.js";
import {
  assigneeUpdate,
  descriptionEdited,
  isSaveShortcut,
  jiraUrlUpdate,
  sprintChoices,
  titleUpdate,
} from "../src/renderer/ui/ticket-edit.js";
import { boardTicket, fakeBridge, ok, sprint, ticket } from "./fixtures.js";
import { render, rerender, typeInto } from "./render.js";

const noop = () => undefined;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

describe("ticket edit rules", () => {
  it("counts only a touched description that differs from the editor's own baseline as an edit", () => {
    expect(descriptionEdited({ text: "- a\n", baseline: "* a", touched: false })).toBe(false);
    expect(descriptionEdited({ text: "- a\n", baseline: "- a", touched: true })).toBe(false);
    expect(descriptionEdited({ text: "- b", baseline: "- a", touched: true })).toBe(true);
  });

  it("recognises the save shortcut on either platform but not with Alt", () => {
    const key = (overrides: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }>) =>
      isSaveShortcut({ key: "s", metaKey: false, ctrlKey: false, altKey: false, ...overrides });
    expect(key({ metaKey: true })).toBe(true);
    expect(key({ ctrlKey: true, key: "S" })).toBe(true);
    expect(key({ metaKey: true, altKey: true })).toBe(false);
    expect(key({})).toBe(false);
  });

  it("turns committed inputs into one field update, or none when unchanged", () => {
    const current = ticket({ title: "Checkout", assignee: "ada", jiraUrl: null });
    expect(titleUpdate("  Checkout ", current)).toBeUndefined();
    expect(titleUpdate(" ", current)).toBeUndefined();
    expect(titleUpdate("Pay", current)).toEqual({ title: "Pay" });
    expect(assigneeUpdate("ada", current)).toBeUndefined();
    expect(assigneeUpdate("  ", current)).toEqual({ assignee: null });
    expect(jiraUrlUpdate("", current)).toBeUndefined();
    expect(jiraUrlUpdate("https://acme.atlassian.net/browse/SHOP-9", current)).toEqual({ jiraUrl: "https://acme.atlassian.net/browse/SHOP-9" });
    expect(jiraUrlUpdate("SHOP-9", current)).toBe("invalid");
    expect(jiraUrlUpdate("", ticket())).toEqual({ jiraUrl: null });
  });

  it("offers open sprints and the ticket's own closed one", () => {
    const sprints = [sprint({ id: "a", state: "closed" }), sprint({ id: "b", state: "active" }), sprint({ id: "c", state: "closed" })];
    expect(sprintChoices(sprints, "a").map((item) => item.id)).toEqual(["a", "b"]);
    expect(sprintChoices(sprints, null).map((item) => item.id)).toEqual(["b"]);
  });
});

describe("ticket fields", () => {
  it("dispatches one update per changed field and moves sprints through the move intent", () => {
    const onUpdate = vi.fn();
    const onMoveSprint = vi.fn();
    const view = render(
      <TicketFields
        ticket={ticket()}
        delivery={boardTicket().delivery}
        sprints={[sprint(), sprint({ id: "sprint-2", name: "Sprint 13", state: "planned" })]}
        tier="tickets"
        now={0}
        onUpdate={onUpdate}
        onMoveSprint={onMoveSprint}
      />,
    );
    cleanup = view.unmount;
    const select = (label: string, value: string) => {
      const element = view.container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
      act(() => {
        element.value = value;
        element.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };
    select("Priority", "highest");
    select("Status", "done");
    select("Sprint", "sprint-2");
    select("Sprint", "");
    const assignee = view.container.querySelector<HTMLInputElement>('input[aria-label="Assignee"]')!;
    typeInto(assignee, "grace");
    act(() => assignee.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    const jira = view.container.querySelector<HTMLInputElement>('input[aria-label="Jira issue link"]')!;
    typeInto(jira, "not a link");
    act(() => jira.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(onUpdate.mock.calls.map(([fields]) => fields)).toEqual([{ priority: "highest" }, { status: "done" }, { assignee: "grace" }]);
    expect(onMoveSprint.mock.calls).toEqual([["sprint-2"], [null]]);
    expect(jira.getAttribute("aria-invalid")).toBe("true");
  });
});

function editor(entry: PmBoardTicket, overrides: Partial<TicketEditorProps> = {}): TicketEditorProps {
  return {
    entry, sprints: [sprint()], tier: "tickets", jiraConfigured: false, playbook: undefined, proposals: [], versions: [], now: 0,
    onUpdate: noop, onMoveSprint: noop, onSaveDescription: async () => ({ kind: "failed" }), onLoadVersions: noop,
    onAddCriterion: noop, onSetCriterionDone: noop, onRemoveCriterion: noop, onAddBlocker: noop, onRemoveBlocker: noop,
    onAcceptProposal: noop, onRejectProposal: noop, onOpenLink: noop, onWriteToJira: noop, onStartCheck: noop, onMarkStep: noop, onAskAgent: noop,
    ...overrides,
  };
}

const doc = (container: HTMLElement) => container.querySelector<HTMLElement>('[aria-label="Description"][role="textbox"]')!;

describe("markdown editor", () => {
  it("reports its own Markdown as the baseline and replaces content only on a new reset key", () => {
    const onBaseline = vi.fn();
    const onChange = vi.fn();
    const props = { label: "Description", placeholder: "", onBaseline, onChange };
    const view = render(<MarkdownEditor {...props} value={"# Goal\n\n* one"} resetKey="t:0" />);
    cleanup = view.unmount;
    expect(doc(view.container).querySelector("h1")?.textContent).toBe("Goal");
    expect(onBaseline).toHaveBeenLastCalledWith(expect.stringContaining("# Goal"));
    expect(onBaseline.mock.lastCall![0]).toMatch(/- one/u);
    expect(onChange).not.toHaveBeenCalled();

    rerender(view.root, <MarkdownEditor {...props} value="ignored" resetKey="t:0" />);
    expect(doc(view.container).textContent).toContain("Goal");
    rerender(view.root, <MarkdownEditor {...props} value="Newer **saved** text" resetKey="t:1" />);
    expect(doc(view.container).querySelector("strong")?.textContent).toBe("saved");
    expect(onBaseline).toHaveBeenLastCalledWith("Newer **saved** text");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("round-trips task lists and tables through Markdown", () => {
    const onBaseline = vi.fn();
    const source = "- [ ] open\n- [x] done\n\n| a | b |\n| --- | --- |\n| 1 | 2 |";
    const view = render(<MarkdownEditor label="Description" placeholder="" value={source} resetKey="k" onBaseline={onBaseline} onChange={noop} />);
    cleanup = view.unmount;
    expect(doc(view.container).querySelectorAll('li[data-checked="true"]')).toHaveLength(1);
    expect(doc(view.container).querySelector("table")).not.toBeNull();
    const markdown = onBaseline.mock.lastCall![0] as string;
    expect(markdown).toContain("- [ ] open");
    expect(markdown).toContain("- [x] done");
    expect(markdown).toMatch(/\| a\s*\| b\s*\|/u);
  });
});

describe("ticket editor", () => {
  it("warns beside the risks when the acceptance criteria grew since sprint start", () => {
    const versions = [
      { ticketId: "ticket-1", number: 1, description: "## Acceptance criteria\n- a", author: "pm" as const, recordedAtEpochMs: -1 },
      { ticketId: "ticket-1", number: 2, description: "## Acceptance criteria\n- a\n- b\n- c", author: "pm" as const, recordedAtEpochMs: 5 },
    ];
    const view = render(<TicketEditor {...editor(boardTicket(), { versions })} />);
    cleanup = view.unmount;
    expect(view.container.querySelector('[data-testid="scope-grew"]')?.textContent).toBe("Scope grew Acceptance criteria grew from 1 to 3 items since sprint start.");
  });

  it("shows no unsaved state for an untouched description and adopts a newer saved version", () => {
    const view = render(<TicketEditor {...editor(boardTicket({ description: "* one\n* two" }))} />);
    cleanup = view.unmount;
    expect(view.container.querySelector(".description-foot")).toBeNull();
    const newer = boardTicket({ description: "Rewritten", versions: { count: 3, headNumber: 3, headAuthor: "agent", headRecordedAtEpochMs: 0 } });
    rerender(view.root, <TicketEditor {...editor(newer)} />);
    expect(doc(view.container).textContent).toBe("Rewritten");
    expect(view.container.querySelector(".description-foot")).toBeNull();
    expect(view.container.querySelector(".banner")).toBeNull();
  });

  it("treats a loaded older version as an edit and saves it on the head with ⌘S", async () => {
    const onSaveDescription = vi.fn(async () => ({ kind: "saved" as const, headVersion: 3 }));
    const versions = [
      { ticketId: "ticket-1", number: 1, description: "First draft", author: "pm" as const, recordedAtEpochMs: 0 },
      { ticketId: "ticket-1", number: 2, description: "Old text", author: "agent" as const, recordedAtEpochMs: 0 },
    ];
    const view = render(<TicketEditor {...editor(boardTicket(), { versions, onSaveDescription })} />);
    cleanup = view.unmount;
    const restore = view.container.querySelector<HTMLButtonElement>(".versions .restore")!;
    act(() => restore.click());
    expect(doc(view.container).textContent).toBe("First draft");
    expect(view.container.querySelector(".description-foot")).not.toBeNull();
    await act(async () => {
      view.container.querySelector("section")!.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }));
    });
    expect(onSaveDescription).toHaveBeenCalledWith("First draft", 2);
    expect(view.container.querySelector(".description-foot")).toBeNull();
  });

  it("offers to load the newer version or overwrite it after a conflict", async () => {
    const onSaveDescription = vi.fn(async () => ({ kind: "conflict" as const }));
    const view = render(<TicketEditor {...editor(boardTicket(), {
      versions: [{ ticketId: "ticket-1", number: 1, description: "Mine", author: "pm", recordedAtEpochMs: 0 }],
      onSaveDescription,
    })} />);
    cleanup = view.unmount;
    act(() => view.container.querySelector<HTMLButtonElement>(".versions .restore")!.click());
    await act(async () => view.container.querySelector<HTMLButtonElement>(".description-foot .pri")!.click());
    // The daemon refused v2 as the base; the board now says v3.
    const newer = boardTicket({ description: "Theirs", versions: { count: 3, headNumber: 3, headAuthor: "agent", headRecordedAtEpochMs: 0 } });
    rerender(view.root, <TicketEditor {...editor(newer, { onSaveDescription })} />);
    expect(view.container.querySelector(".banner")?.textContent).toContain("v3 was saved while you were editing. Saving yours would replace it.");
    expect(doc(view.container).textContent).toBe("Mine");
    const overwrite = [...view.container.querySelectorAll<HTMLButtonElement>(".banner button")].find((button) => button.textContent === "Save mine anyway")!;
    await act(async () => overwrite.click());
    expect(onSaveDescription).toHaveBeenLastCalledWith("Mine", 3);
    const loadNewer = [...view.container.querySelectorAll<HTMLButtonElement>(".banner button")].find((button) => button.textContent === "Load v3")!;
    act(() => loadNewer.click());
    expect(doc(view.container).textContent).toBe("Theirs");
    expect(view.container.querySelector(".banner")).toBeNull();
  });
});

describe("description save outcome", () => {
  it("reports a stale base as a conflict without a notice and a save with its new head", async () => {
    let refuse = true;
    const bridge = fakeBridge((method) => {
      if (method === "pm_ticket_description_save") {
        return refuse
          ? { ok: false, error: { code: "conflict", message: "conflict with a newer change" } } as never
          : ok(ticket({ versions: { count: 4, headNumber: 4, headAuthor: "pm", headRecordedAtEpochMs: 0 } }));
      }
      return ok({ projectId: "project-1", sprints: [], tickets: [], environments: [], probes: [], runningChecks: [], epics: [], epicBreakdowns: [], tracking: { jira: false, code: false, deploy: false, tier: "tickets" } });
    });
    const controller = new PmController(bridge, createPmStore({ projectId: "project-1" }));
    expect(await controller.saveDescription("ticket-1", "text", 2)).toEqual({ kind: "conflict" });
    expect(controller.state.notice).toBeUndefined();
    refuse = false;
    expect(await controller.saveDescription("ticket-1", "text", 3)).toEqual({ kind: "saved", headVersion: 4 });
  });
});
