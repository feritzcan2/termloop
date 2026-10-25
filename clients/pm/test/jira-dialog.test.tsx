// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { JiraSyncDialog } from "../src/renderer/ui/JiraSyncDialog.js";
import { jiraDiff } from "./fixtures.js";
import { render } from "./render.js";

describe("JiraSyncDialog", () => {
  it("shows the new diff and a notice when the applied diff was stale", () => {
    const fresh = jiraDiff({ token: "diff-token-2", changes: [{ field: "summary", jira: "Renamed in Jira", ticket: "Checkout button" }] });
    const { container, unmount } = render(
      <JiraSyncDialog
        dialog={{ ticketId: "ticket-1", loading: false, diff: fresh, staleNotice: true, result: undefined, error: undefined }}
        onApply={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(container.textContent).toContain("Jira changed since this diff was read");
    expect(container.textContent).toContain("Renamed in Jira");
    expect(container.textContent).not.toContain("Old summary");
    const apply = [...container.querySelectorAll("button")].find((button) => button.textContent === "Apply");
    expect(apply?.disabled).toBe(false);
    unmount();
  });
});
