import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectSourceRefreshButton } from "../src/renderer/ui/ProjectSourceRefreshButton.js";

describe("Project source refresh", () => {
  it("renders a distinct accessible refresh action for the offline source", () => {
    const markup = renderToStaticMarkup(createElement(ProjectSourceRefreshButton, {
      sourceName: "Felix’s Mac mini",
      refresh: async () => undefined,
    }));

    expect(markup).toContain('class="project-source-refresh"');
    expect(markup).toContain('aria-label="Refresh Felix’s Mac mini"');
    expect(markup).toContain('title="Refresh Felix’s Mac mini"');
    expect(markup).toContain("<svg");
  });
});
