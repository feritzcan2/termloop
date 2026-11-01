import { describe, expect, it, vi } from "vitest";

vi.mock("electron-updater", () => ({ default: { autoUpdater: {} } }));

const { UpdateFailure, updateFailureCode } = await import("../src/platform/auto-update.js");

describe("update failure codes", () => {
  it("keeps electron-updater and HTTP codes", () => {
    expect(updateFailureCode(Object.assign(new Error("Cannot find channel"), { code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" })))
      .toBe("ERR_UPDATER_CHANNEL_FILE_NOT_FOUND");
    expect(updateFailureCode(Object.assign(new Error("HTTP error: 404"), { code: "HTTP_ERROR_404" }))).toBe("HTTP_ERROR_404");
  });

  it("names a missing feed file by its errno code", () => {
    const missing = Object.assign(new Error("ENOENT: no such file, open 'C:\\\\app\\\\resources\\\\app-update.yml'"), { code: "ENOENT" });
    expect(updateFailureCode(missing)).toBe("ENOENT");
  });

  it("extracts Chromium network errors from their message only", () => {
    expect(updateFailureCode(new Error("net::ERR_INTERNET_DISCONNECTED at https://updates.termloop.ai/stable/latest.yml")))
      .toBe("net::ERR_INTERNET_DISCONNECTED");
  });

  it("drops anything else instead of leaking it", () => {
    expect(updateFailureCode(new Error("https://updates.termloop.ai/stable/latest.yml returned garbage"))).toBe("unknown");
    expect(updateFailureCode(Object.assign(new Error("x"), { code: "a code with spaces and https://x" }))).toBe("unknown");
    expect(updateFailureCode("boom")).toBe("unknown");
  });

  it("wraps a failure without keeping the original message", () => {
    const failure = new UpdateFailure(new Error("net::ERR_TIMED_OUT at https://updates.termloop.ai/stable"));
    expect(failure.code).toBe("net::ERR_TIMED_OUT");
    expect(failure.message).not.toContain("https://");
  });
});
