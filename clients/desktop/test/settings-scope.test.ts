import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConnectionProfileSummary } from "../src/connection-profile-types.js";
import { computerScopeName, hasRemoteComputers } from "../src/renderer/settings-scope.js";
import { SettingsScopeLabel } from "../src/renderer/ui/SettingsScopeLabel.js";

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
});
