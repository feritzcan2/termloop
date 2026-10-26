// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { DeleteProjectCard } from "../src/renderer/ui/SettingsPage.js";
import { SprintOverview } from "../src/renderer/ui/SprintOverview.js";
import { boardTicket, playbook, sprint } from "./fixtures.js";
import { render } from "./render.js";

const noop = () => undefined;
const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === text);

describe("deleting", () => {
  it("deletes a sprint only after the PM confirms, saying where its tickets go", () => {
    const onDelete = vi.fn();
    const { container, unmount } = render(
      <SprintOverview sprint={sprint()} sprints={[sprint()]} tickets={[boardTicket({ id: "t1" }), boardTicket({ id: "t2" })]} tier="tickets"
        playbook={playbook()} digest={[]} now={0} onOpenTicket={noop} onActivate={noop} onClose={noop} onDelete={onDelete} />,
    );
    act(() => button(container, "Delete sprint")!.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Delete sprint"]')!;
    expect(dialog.textContent).toContain("Its 2 tickets move to No sprint");
    act(() => button(dialog, "Cancel")!.click());
    expect(onDelete).not.toHaveBeenCalled();
    act(() => button(container, "Delete sprint")!.click());
    act(() => button(container.querySelector<HTMLElement>('[role="dialog"]')!, "Delete sprint")!.click());
    expect(onDelete).toHaveBeenCalledWith("sprint-1");
    unmount();
  });

  it("deletes a project only after the PM confirms", () => {
    const onDelete = vi.fn();
    const { container, unmount } = render(<DeleteProjectCard projectName="Shop" onDelete={onDelete} />);
    act(() => button(container, "Delete project…")!.click());
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Delete Shop and everything stored for it?");
    expect(onDelete).not.toHaveBeenCalled();
    act(() => button(container, "Delete project")!.click());
    expect(onDelete).toHaveBeenCalledOnce();
    unmount();
  });
});
