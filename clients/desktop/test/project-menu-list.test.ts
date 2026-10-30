import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../src/renderer/model.js";
import { ProjectMenuList } from "../src/renderer/ui/ProjectMenuList.js";

function project(id: string, name: string): Project {
  return {
    id,
    name,
    folder_path: `/work/${id}`,
    connectionProfileId: "local",
    connectionProfileName: "This computer",
    connectionState: "connected",
  } as unknown as Project;
}

describe("Project menu list", () => {
  it("labels each Project with the shortcut of its arranged position", () => {
    const projects = [project("b", "Beta"), project("a", "Alpha")];
    const markup = renderToStaticMarkup(createElement(ProjectMenuList, {
      projects,
      groups: [{ profileId: "local", name: "This computer", projects }],
      showGroups: false,
      selectedProjectId: "a",
      platform: "mac",
      select: vi.fn(),
      reorder: vi.fn(),
    }));
    const beta = markup.indexOf("Beta");
    const alpha = markup.indexOf("Alpha");
    expect(beta).toBeGreaterThan(-1);
    expect(beta).toBeLessThan(alpha);
    expect(markup).toContain("⌘1</kbd>");
    expect(markup).toContain("⌘2</kbd>");
    expect(markup).toContain('data-project-option-id="a" data-project-selected="true"');
    expect(markup).toContain('role="menuitem"');
    expect(markup).not.toContain('aria-roledescription');
  });

  it("names a version mismatch instead of a generic offline source", () => {
    const remote = (id: string, connectionMessage: string): Project => ({
      ...project(id, id),
      connectionProfileId: "remote",
      connectionProfileName: "Server",
      connectionState: "offline",
      connectionMessage,
    });
    const projects = [
      remote("mismatched", "Version mismatch: server termloop.v2, desktop termloop.v3"),
      remote("unreachable", "Connection lost; reconnecting"),
    ];
    const markup = renderToStaticMarkup(createElement(ProjectMenuList, {
      projects,
      groups: [{ profileId: "remote", name: "Server", projects }],
      showGroups: true,
      selectedProjectId: undefined,
      platform: "mac",
      select: vi.fn(),
      reorder: vi.fn(),
    }));
    expect(markup).toContain("Server · Version mismatch</small>");
    expect(markup).toContain("Server · Offline</small>");
    expect(markup.match(/data-connection-state="offline"/g)).toHaveLength(2);
  });
});
