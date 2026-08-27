import { describe, expect, it } from "vitest";
import { applicationMenuTemplate, shouldRemoveApplicationMenu } from "../src/platform/application-menu.js";

describe("application menu policy", () => {
  it("keeps the default menu only on macOS", () => {
    expect(shouldRemoveApplicationMenu("darwin")).toBe(false);
  });

  it("removes the default menu on Windows and Linux so terminal keys reach the PTY", () => {
    expect(shouldRemoveApplicationMenu("win32")).toBe(true);
    expect(shouldRemoveApplicationMenu("linux")).toBe(true);
  });

  it("keeps macOS editing roles without reserving Cmd+R for reload", () => {
    const template = applicationMenuTemplate("darwin");
    const roles = template.flatMap((item) => Array.isArray(item.submenu) ? item.submenu : [])
      .map((item) => "role" in item ? item.role : undefined)
      .filter((role) => role !== undefined);

    expect(roles).toContain("copy");
    expect(roles).toContain("paste");
    expect(roles).not.toContain("reload");
  });
});
