import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  applyUntaggedApplicationIcon,
  developmentApplicationName,
  developmentWindowStartMode,
  desktopUserDataPath,
  desktopUserDataOverride,
  linkedWorktreeProfileStartupError,
  prioritizeDevelopmentProject,
} from "../src/platform/dev-profile.js";

describe("linked-worktree development profile startup", () => {
  it("shows a validated feature tag in the development application name", () => {
    expect(developmentApplicationName("fix-delete")).toBe("TermLoop Next — fix-delete");
    expect(developmentApplicationName(undefined)).toBe("TermLoop Next");
    expect(developmentApplicationName("bad tag")).toBe("TermLoop Next");
  });

  it("minimizes tagged agent windows only where the launcher supports it", () => {
    expect(developmentWindowStartMode("fix-delete", false, "darwin")).toBe("minimized");
    expect(developmentWindowStartMode("fix-delete", false, "linux")).toBe("visible");
    expect(developmentWindowStartMode("fix-delete", false, "win32")).toBe("visible");
    expect(developmentWindowStartMode(undefined, false, "darwin")).toBe("visible");
    expect(developmentWindowStartMode("bad tag", false, "darwin")).toBe("visible");
    expect(developmentWindowStartMode("fix-delete", true, "linux")).toBe("hidden");
  });

  it("applies the legacy icon only to an untagged macOS application", () => {
    const appliedIcons: string[] = [];
    const application = { dock: { setIcon: (iconPath: string) => appliedIcons.push(iconPath) } };

    expect(applyUntaggedApplicationIcon(application, undefined, "/assets/legacy.png")).toBe(true);
    expect(applyUntaggedApplicationIcon(application, "fix-delete", "/assets/legacy.png")).toBe(false);
    expect(applyUntaggedApplicationIcon({}, undefined, "/assets/legacy.png")).toBe(false);
    expect(appliedIcons).toEqual(["/assets/legacy.png"]);
  });

  it("refuses an incomplete linked-worktree environment", () => {
    expect(linkedWorktreeProfileStartupError("feature-abcd", false, false, {})).toContain(
      "tools/dev/termloop-dev",
    );
    expect(
      linkedWorktreeProfileStartupError("feature-abcd", false, false, {
        TERMLOOP_RUNTIME_FILE: "/runtime/runtime.json",
      }),
    ).toContain("feature-abcd");
  });

  it("allows a complete profile, primary checkout, packaged app, and smoke", () => {
    expect(
      linkedWorktreeProfileStartupError("feature-abcd", false, false, {
        TERMLOOP_RUNTIME_FILE: "/runtime/runtime.json",
        TERMLOOP_DESKTOP_USER_DATA_DIR: "/desktop",
      }),
    ).toBeUndefined();
    expect(linkedWorktreeProfileStartupError(null, false, false, {})).toBeUndefined();
    expect(linkedWorktreeProfileStartupError("feature-abcd", true, false, {})).toBeUndefined();
    expect(linkedWorktreeProfileStartupError("feature-abcd", false, true, {})).toBeUndefined();
  });

  it("gives smoke runs an isolated single-instance directory", () => {
    expect(desktopUserDataOverride(undefined, true, 42, "/tmp")).toBe(
      "/tmp/termloop-next-smoke-42",
    );
    expect(desktopUserDataOverride("/configured", true, 42, "/tmp")).toBe("/configured");
    expect(desktopUserDataOverride(undefined, false, 42, "/tmp")).toBeUndefined();
  });

  it("keeps packaged releases out of the development single-instance directory", () => {
    expect(desktopUserDataPath(undefined, true, false, 42, "/tmp", "/app-data")).toBe(
      path.join("/app-data", "TermLoop Next"),
    );
    expect(desktopUserDataPath("/configured", true, false, 42, "/tmp", "/app-data")).toBe(
      "/configured",
    );
    expect(desktopUserDataPath(undefined, false, false, 42, "/tmp", "/app-data")).toBeUndefined();
  });

  it("puts the tagged profile Project first without changing the daemon projection", () => {
    const projects = [
      { id: "older", folder_path: "/projects/older" },
      { id: "sandbox", folder_path: "/profiles/dev-project" },
      { id: "newer", folder_path: "/projects/newer" },
    ];

    expect(prioritizeDevelopmentProject(projects, "/profiles/dev-project").map(({ id }) => id))
      .toEqual(["sandbox", "older", "newer"]);
    expect(projects.map(({ id }) => id)).toEqual(["older", "sandbox", "newer"]);
    expect(prioritizeDevelopmentProject(projects, undefined)).toEqual(projects);
  });
});
