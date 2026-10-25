// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PmTicketNote } from "@termloop/pm-contract/pm";
import { NoteDialog, noteUrlValid } from "../src/renderer/ui/NoteDialog.js";
import { TicketContextMenu, menuPosition } from "../src/renderer/ui/TicketContextMenu.js";
import { TicketNotes } from "../src/renderer/ui/TicketNotes.js";
import { render, typeInto } from "./render.js";

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

function note(overrides: Partial<PmTicketNote> = {}): PmTicketNote {
  return {
    id: "n1",
    ticketId: "t1",
    kind: "fact",
    text: "The client also wants CSV",
    url: null,
    sourceKey: null,
    author: "pm",
    createdAtEpochMs: 1_000,
    pending: true,
    ...overrides,
  };
}

const click = (element: Element) => act(() => { (element as HTMLElement).click(); });
const buttonNamed = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll("button")].find((button) => button.textContent === name)!;

function typeText(area: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ticket notes", () => {
  function mount(notes: PmTicketNote[] | undefined, canUpdate = true) {
    const handlers = { onAddNote: vi.fn(), onFollowSource: vi.fn(), onRemoveNote: vi.fn(), onOpenLink: vi.fn(), onUpdateDescription: vi.fn() };
    const view = render(<TicketNotes notes={notes} now={61_000} canUpdate={canUpdate} {...handlers} />);
    cleanup = view.unmount;
    return { view, ...handlers };
  }

  it("counts pending facts, marks them new, and lists followed sources apart", () => {
    const { view, onOpenLink } = mount([
      note(),
      note({ id: "n2", text: "Old fact", pending: false }),
      note({ id: "n3", kind: "source", text: "Slack #shop thread", url: "https://acme.slack.com/archives/C1/p1", author: "agent" }),
    ]);
    expect(view.container.querySelector("h3")!.textContent).toContain("1 not in the description yet");
    const facts = view.container.querySelectorAll("ul[aria-label='Notes'] li");
    expect(facts).toHaveLength(2);
    expect(facts[0]!.className).toBe("pending");
    expect(facts[0]!.textContent).toContain("new");
    expect(facts[1]!.textContent).not.toContain("new");
    click(buttonNamed(view.container, "Slack #shop thread"));
    expect(onOpenLink).toHaveBeenCalledWith("https://acme.slack.com/archives/C1/p1");
  });

  it("asks for a description update only when there is something to merge", () => {
    const empty = mount([note({ pending: false })]);
    expect(buttonNamed(empty.view.container, "Update description").disabled).toBe(true);
    empty.view.unmount();
    const pending = mount([note()]);
    click(buttonNamed(pending.view.container, "Update description"));
    expect(pending.onUpdateDescription).toHaveBeenCalled();
    pending.view.unmount();
    const noAssistant = mount([note()], false);
    expect(buttonNamed(noAssistant.view.container, "Update description").disabled).toBe(true);
  });

  it("adds a trimmed note from the add line and removes one", () => {
    const { view, onAddNote, onRemoveNote } = mount([note()]);
    const input = view.container.querySelector<HTMLInputElement>("input[aria-label='New note']")!;
    typeInto(input, "  Deadline moved to Friday ");
    act(() => { input.form!.requestSubmit(); });
    expect(onAddNote).toHaveBeenCalledWith("Deadline moved to Friday");
    click(view.container.querySelector("button[aria-label='Remove note']")!);
    expect(onRemoveNote).toHaveBeenCalledWith("n1");
  });
});

describe("note dialog", () => {
  it("records a fact with an optional https link and closes once stored", async () => {
    const onSubmit = vi.fn(async () => true);
    const onClose = vi.fn();
    const view = render(<NoteDialog kind="fact" ticketLabel="PM-12" onSubmit={onSubmit} onClose={onClose} />);
    cleanup = view.unmount;
    const add = buttonNamed(view.container, "Add note");
    expect(add.disabled).toBe(true);
    typeText(view.container.querySelector("textarea")!, " CSV too ");
    const link = view.container.querySelector<HTMLInputElement>("input[aria-label='Link']")!;
    typeInto(link, "http://acme.slack.com/x");
    expect(add.disabled).toBe(true);
    typeInto(link, "https://acme.slack.com/archives/C1/p1");
    await act(async () => { add.click(); });
    expect(onSubmit).toHaveBeenCalledWith({ kind: "fact", text: "CSV too", url: "https://acme.slack.com/archives/C1/p1" });
    expect(onClose).toHaveBeenCalled();
  });

  it("requires a link to follow a source and stays open when the store refuses", async () => {
    const onSubmit = vi.fn(async () => false);
    const onClose = vi.fn();
    const view = render(<NoteDialog kind="source" ticketLabel="PM-12" onSubmit={onSubmit} onClose={onClose} />);
    cleanup = view.unmount;
    const follow = buttonNamed(view.container, "Follow");
    typeInto(view.container.querySelector<HTMLInputElement>("input[aria-label='Label']")!, "Slack thread");
    expect(follow.disabled).toBe(true);
    typeInto(view.container.querySelector<HTMLInputElement>("input[aria-label='Link']")!, "https://acme.slack.com/archives/C1/p1");
    await act(async () => { follow.click(); });
    expect(onSubmit).toHaveBeenCalledWith({ kind: "source", text: "Slack thread", url: "https://acme.slack.com/archives/C1/p1" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("accepts only https links without userinfo", () => {
    expect(noteUrlValid("https://acme.slack.com/archives/C1/p1")).toBe(true);
    expect(noteUrlValid("https://user:pw@acme.slack.com/x")).toBe(false);
    expect(noteUrlValid("ftp://acme.slack.com/x")).toBe(false);
    expect(noteUrlValid("https://acme.slack.com/a b")).toBe(false);
  });
});

describe("ticket context menu", () => {
  it("runs a picked item, skips disabled ones, and closes", () => {
    const run = vi.fn();
    const onClose = vi.fn();
    const view = render(
      <TicketContextMenu
        at={{ x: 10, y: 10 }}
        label="PM-12 actions"
        items={[
          { kind: "action", label: "Update description from notes", disabled: true, run: vi.fn() },
          { kind: "separator" },
          { kind: "action", label: "Add note…", run },
        ]}
        onClose={onClose}
      />,
    );
    cleanup = view.unmount;
    expect(document.activeElement?.textContent).toBe("Add note…");
    click(buttonNamed(view.container, "Add note…"));
    expect(run).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape and on a click elsewhere", () => {
    const onClose = vi.fn();
    const view = render(<TicketContextMenu at={{ x: 0, y: 0 }} label="menu" items={[{ kind: "action", label: "Open", run: vi.fn() }]} onClose={onClose} />);
    cleanup = view.unmount;
    act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps the menu inside the window", () => {
    expect(menuPosition({ x: 990, y: 790 }, { width: 240, height: 100 }, { width: 1000, height: 800 })).toEqual({ x: 756, y: 696 });
    expect(menuPosition({ x: -5, y: 20 }, { width: 240, height: 100 }, { width: 1000, height: 800 })).toEqual({ x: 4, y: 20 });
  });
});
