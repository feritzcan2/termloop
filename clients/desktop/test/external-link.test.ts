import { describe, expect, it } from "vitest";
import { validatedExternalUrl, validatedGitHostPullRequestUrl, validatedJiraIssueUrl, validatedLoopbackRunUrl } from "../src/main/external-link.js";

describe("validatedGitHostPullRequestUrl", () => {
  it("accepts canonical GitHub and Azure DevOps pull-request URLs", () => {
    expect(validatedGitHostPullRequestUrl("https://github.com/acme/widget/pull/42"))
      .toBe("https://github.com/acme/widget/pull/42");
    expect(validatedGitHostPullRequestUrl("https://dev.azure.com/fiber-teams/Fiber%20Tests/_git/Widget/pullrequest/42"))
      .toBe("https://dev.azure.com/fiber-teams/Fiber%20Tests/_git/Widget/pullrequest/42");
  });

  it("rejects credential, authority, navigation and encoded-separator poison", () => {
    for (const value of [
      "http://github.com/acme/widget/pull/42",
      "https://github.com.evil/acme/widget/pull/42",
      "https://token@github.com/acme/widget/pull/42",
      "https://github.com:443/acme/widget/pull/42",
      "https://github.com/acme/widget/pull/42?token=secret",
      "https://github.com/acme/widget/pull/42#fragment",
      "https://github.com/acme%2fwidget/pull/42",
      "https://github.com/acme/widget/pull/42%0a",
      "https://dev.azure.com/fiber-teams/Fiber%2FTests/_git/Widget/pullrequest/42",
      "https://dev.azure.com/FIBER/Fiber/_git/Widget/pullrequest/42",
      "https://dev.azure.com/fiber/Fiber/_git/../pullrequest/42",
      "https://dev.azure.com/fiber/Fiber/_git/Widget/pullrequest/0",
    ]) expect(() => validatedGitHostPullRequestUrl(value)).toThrow("externalLinkDenied");
  });
});

describe("validatedJiraIssueUrl", () => {
  it("accepts exact HTTPS Jira browse URLs through the external-link channel", () => {
    const jira = "https://apcoadigital.atlassian.net/browse/UKIE-697";
    expect(validatedJiraIssueUrl(jira)).toBe(jira);
    expect(validatedExternalUrl(jira)).toBe(jira);
  });

  it("rejects fuzzy and secret-bearing Jira links", () => {
    for (const value of [
      "UKIE-697",
      "http://apcoadigital.atlassian.net/browse/UKIE-697",
      "https://user@apcoadigital.atlassian.net/browse/UKIE-697",
      "https://apcoadigital.atlassian.net/browse/UKIE-697?token=secret",
      "https://apcoadigital.atlassian.net/browse/ukie-697",
      "https://apcoadigital.atlassian.net/issues/UKIE-697",
    ]) expect(() => validatedJiraIssueUrl(value)).toThrow("externalLinkDenied");
  });
});

describe("validatedLoopbackRunUrl", () => {
  it("accepts only bounded HTTP loopback run URLs", () => {
    expect(validatedLoopbackRunUrl("http://localhost:5173/app?mode=dev#ready"))
      .toBe("http://localhost:5173/app?mode=dev#ready");
    expect(validatedLoopbackRunUrl("https://127.0.0.1"))
      .toBe("https://127.0.0.1/");
    for (const value of [
      "https://example.com:5173",
      "ftp://localhost:21",
      "http://token@localhost:5173",
      "http://localhost:0",
      "http://localhost:5173/\npoison",
    ]) expect(() => validatedLoopbackRunUrl(value)).toThrow("runUrlDenied");
  });
});
