import { describe, expect, it } from "vitest";

import { mobileAppUpdateDiagnostic } from "../src/platform/app-update-diagnostics";

const identity = {
  updateId: "01example-update",
  channel: "termloop-next-production",
  runtimeVersion: "2.0.0",
  embedded: false,
  appVersion: "2.0.0",
  appBuild: "20260908070100",
} as const;

describe("app update diagnostics", () => {
  it("records enough identity to verify a current OTA result", () => {
    expect(mobileAppUpdateDiagnostic("check_finished", identity, {
      requestedGroup: "example-group",
      result: "current",
    })).toEqual({
      message: "mobile.update.check_finished",
      level: "info",
      attributes: {
        "expo.update": "01example-update",
        "expo.channel": "termloop-next-production",
        "expo.runtime": "2.0.0",
        "expo.embedded": false,
        "app.version": "2.0.0",
        "app.build": "20260908070100",
        requestedUpdateGroup: "example-group",
        result: "current",
      },
    });
  });

  it("identifies failures without logging their messages", () => {
    const diagnostic = mobileAppUpdateDiagnostic(
      "check_failed",
      { ...identity, updateId: null, channel: null },
      { cause: new TypeError("secret request URL") },
    );

    expect(diagnostic.level).toBe("error");
    expect(diagnostic.attributes).toMatchObject({
      "expo.update": "embedded",
      "expo.channel": "embedded",
      failureType: "TypeError",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("secret request URL");
  });
});
