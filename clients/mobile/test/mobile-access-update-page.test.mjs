import { describe, expect, it } from "vitest";

import { mobileUpdatePage } from "../scripts/mobile-access-update-page.mjs";

describe("tailnet mobile update page", () => {
  it("offers a one-tap deep link for the published update group", () => {
    const group = "b9fe7485-92ef-4b40-9e9d-3b3b6ca3356e";
    const page = mobileUpdatePage(`/mobile-update?group=${group}`);

    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.body).toContain(`href="termloop://force-update?group=${group}"`);
    expect(page.body).toContain(">Force Update</a>");
  });

  it("never reflects an invalid group into the page or deep link", () => {
    const page = mobileUpdatePage("/mobile-update?group=%22%3E%3Cscript%3Ebad%3C%2Fscript%3E");

    expect(page.body).not.toContain("<script>");
    expect(page.body).toContain('href="termloop://force-update"');
    expect(page.body).not.toContain("?group=");
  });
});
