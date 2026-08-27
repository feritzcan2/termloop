import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProjectCheckoutHeader, projectChangeSummary } from "../src/renderer/ui/ProjectCheckoutHeader.js";

describe("Project checkout header", () => {
  it("names the Project, states its checkout changes, and stays the relocation drop target", () => {
    const markup = renderToStaticMarkup(createElement(ProjectCheckoutHeader, {
      changes: { summary: { project_id: "project-1", checked_out_branch: "feature/sidebar", change_count: 3 }, open: () => {} },
      children: createElement("button", { type: "button", id: "project" }, "Termloop"),
    }));

    expect(markup).toContain('data-session-drop-target="project-root"');
    expect(markup).toContain('<span id="project-label" class="project-label">Project</span>');
    expect(markup).toContain('aria-label="Review 3 changes on feature/sidebar"');
    // The Project trigger it wraps keeps its place inside the same section.
    expect(markup.indexOf('class="project-label"')).toBeLessThan(markup.indexOf('id="project"'));
  });

  /// No Project selected means no checkout to review, so the action is absent
  /// rather than offering an empty diff.
  it("offers no change action while no Project is selected", () => {
    const markup = renderToStaticMarkup(createElement(ProjectCheckoutHeader, {
      children: createElement("button", { type: "button", id: "project" }, "No Project"),
    }));

    expect(markup).toContain('data-session-drop-target="project-root"');
    expect(markup).not.toContain("project-change-summary");
  });

  it("states the checkout's change count and keeps the editor reachable when clean", () => {
    const render = (summary: Parameters<typeof projectChangeSummary>[0]) =>
      renderToStaticMarkup(projectChangeSummary(summary, () => {}) as never);

    expect(render({ project_id: "project-1", checked_out_branch: "feature/sidebar", change_count: 3 }))
      .toContain('title="Review 3 changes on feature/sidebar" aria-label="Review 3 changes on feature/sidebar">3 changes</button>');
    expect(render({ project_id: "project-1", checked_out_branch: null, change_count: 1 }))
      .toContain('title="Review 1 change in the Project checkout" aria-label="Review 1 change in the Project checkout">1 change</button>');
    expect(render({ project_id: "project-1", checked_out_branch: "main", change_count: 0 }))
      .toContain('title="Review changes on main" aria-label="Review changes on main">Changes</button>');
    expect(render(undefined))
      .toContain('title="Review changes in the Project checkout" aria-label="Review changes in the Project checkout">Changes</button>');
  });

  it("opens the Project changes editor from the checkout change label", () => {
    const openChanges = vi.fn();
    for (const summary of [{
      project_id: "project-1",
      checked_out_branch: "feature/sidebar",
      change_count: 2,
    }, undefined]) {
      const detail = projectChangeSummary(summary, openChanges);
      expect(isValidElement<{ onClick(): void }>(detail)).toBe(true);
      if (!isValidElement<{ onClick(): void }>(detail)) throw new Error("expected change button");
      detail.props.onClick();
    }
    expect(openChanges).toHaveBeenCalledTimes(2);
  });
});
