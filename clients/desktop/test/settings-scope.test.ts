import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConnectionProfileSummary } from "../src/connection-profile-types.js";
import { computerScopeName, hasRemoteComputers } from "../src/renderer/settings-scope.js";
import { SettingsScopeLabel } from "../src/renderer/ui/SettingsScopeLabel.js";
import { LibraryScopeHeader } from "../src/renderer/ui/LibraryScopeHeader.js";

const local: ConnectionProfileSummary = {
  id: "local", name: "MacBook Pro", transport: "local", scope: "local",
  endpoint: "", enabled: true, persistence: "local", state: "connected",
};

describe("settings scope", () => {
  it("keeps scope labels hidden for local-only use and disabled remote profiles", () => {
    expect(hasRemoteComputers([])).toBe(false);
    expect(hasRemoteComputers([local])).toBe(false);
    expect(hasRemoteComputers([local, { ...local, id: "remote", transport: "ssh", enabled: false }])).toBe(false);
    expect(renderToStaticMarkup(createElement(SettingsScopeLabel, {}))).toBe("");
  });

  it.each(["connecting", "connected", "offline"] as const)("retains scope for an enabled %s remote computer without Projects", (state) => {
    expect(hasRemoteComputers([local, { ...local, id: "remote", transport: "ssh", state }])).toBe(true);
  });

  it("distinguishes computer, project and app ownership", () => {
    const context = { computerName: "Netcup", projectName: "TermLoop" };
    const render = (scope: "app" | "computer" | "project") => renderToStaticMarkup(createElement(SettingsScopeLabel, { context, scope }));
    expect(render("computer")).toContain("Computer: Netcup");
    expect(render("project")).toContain("Project: TermLoop · Netcup");
    expect(render("app")).toContain("This app · This computer");
    expect(render("app")).not.toContain("Netcup");
    expect(computerScopeName("MacBook Pro", true)).toBe("MacBook Pro · This computer");
    expect(computerScopeName("This computer", true)).toBe("This computer");
    expect(computerScopeName("Netcup", false)).toBe("Netcup");
  });

  it.each(["agents", "mcp", "prompts", "skills", "context", "workspace"] as const)("omits the %s scope header during local-only use", (section) => {
    expect(renderToStaticMarkup(createElement(LibraryScopeHeader, { section }))).toBe("");
  });

  it("identifies the selected library's scope before an editor is opened", () => {
    const context = { computerName: "Felix’s Mac mini", projectName: "TermLoopMini" };
    const render = (section: Parameters<typeof LibraryScopeHeader>[0]["section"]) => renderToStaticMarkup(createElement(LibraryScopeHeader, { section, context }));
    for (const section of ["agents", "mcp"] as const) {
      expect(render(section)).toContain("Computer: Felix’s Mac mini");
      expect(render(section)).not.toContain("TermLoopMini");
    }
    expect(render("context")).toContain("Project: TermLoopMini · Felix’s Mac mini");
    expect(render("prompts")).toContain("Built-in prompts: This app · This computer");
    expect(render("prompts")).toContain("Project prompts: TermLoopMini · Felix’s Mac mini");
    expect(render("skills")).toContain("Personal &amp; provider skills: Felix’s Mac mini");
    expect(render("skills")).toContain("Project skills: TermLoopMini · Felix’s Mac mini");
    expect(render("workspace")).toBe("");
  });

  it("does not mislabel Context as computer-wide when there is no selected project", () => {
    const markup = renderToStaticMarkup(createElement(LibraryScopeHeader, { section: "context", context: { computerName: "MacBook Pro" } }));
    expect(markup).toContain("No project selected");
    expect(markup).not.toContain("Computer:");
  });
});
