// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StewardPanel, type StewardPanelProps } from "../src/renderer/ui/StewardPanel.js";
import { render } from "./render.js";

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

const session = { sessionId: "steward-1", label: "Steward", state: "running" as const, assistant: true, provider: "claude" as const, detail: "project", focusTicketId: null };

function panel(overrides: Partial<StewardPanelProps> = {}) {
  const props: StewardPanelProps = {
    session: undefined, canStart: true, resumable: false, focusLabel: undefined,
    mountTerminal: vi.fn(() => () => {}),
    onStart: vi.fn(), onStop: vi.fn(), onNewConversation: vi.fn(),
    ...overrides,
  };
  const view = render(<StewardPanel {...props} />);
  cleanup = view.unmount;
  return { props, view };
}

const buttons = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>("button")];

describe("Steward panel", () => {
  it("offers to resume Steward's kept conversation or start a new one", () => {
    const { props, view } = panel({ resumable: true, focusLabel: "PM-7" });
    const [newConversation, resume] = buttons(view.container);
    expect(resume!.textContent).toBe("Resume Steward on PM-7");
    act(() => resume!.click());
    expect(props.onStart).toHaveBeenCalled();
    act(() => newConversation!.click());
    expect(props.onNewConversation).toHaveBeenCalled();
  });

  it("shows a fresh project only how to start Steward", () => {
    const { view } = panel();
    expect(buttons(view.container).map((button) => button.textContent)).toEqual(["Start Steward"]);
  });

  it("mounts the running Steward's terminal and stops it", () => {
    const { props, view } = panel({ session });
    expect(props.mountTerminal).toHaveBeenCalledWith(expect.any(HTMLElement), "steward-1");
    const stop = buttons(view.container).find((button) => button.textContent === "Stop")!;
    act(() => stop.click());
    expect(props.onStop).toHaveBeenCalledWith("steward-1");
  });
});
