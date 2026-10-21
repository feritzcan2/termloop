// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHostRepositoryPullRequestDto, GitHostRepositoryPullRequestFilter, GitHostRepositoryPullRequestListResult } from "@termloop/contract/current";
import { PullRequestsSidebar, pullRequestSignals } from "../src/renderer/ui/PullRequestsSidebar.js";

const pullRequest = (overrides: Partial<GitHostRepositoryPullRequestDto> = {}): GitHostRepositoryPullRequestDto => ({
  number: 42,
  title: "Add the PR sidebar",
  url: "https://github.com/acme/widget/pull/42",
  state: "open",
  base_branch: "main",
  head_branch: "feature/prs",
  author: "octocat",
  check_rollup: "passing",
  review_signal: "reviewRequired",
  merge_conflict: "noneDetected",
  created_at_epoch_ms: 1_000,
  updated_at_epoch_ms: 3_600_000,
  ...overrides,
});
const listed = (pullRequests: GitHostRepositoryPullRequestDto[], overrides: Partial<GitHostRepositoryPullRequestListResult> = {}): GitHostRepositoryPullRequestListResult => ({
  repository_provider: "github",
  repository_owner: "acme",
  repository_project: null,
  repository_name: "widget",
  reason: null,
  pull_requests: pullRequests,
  truncated: false,
  observed_at_epoch_ms: 7_200_000,
  ...overrides,
});

describe("Pull Requests sidebar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const render = async (props: Partial<Parameters<typeof PullRequestsSidebar>[0]> & Pick<Parameters<typeof PullRequestsSidebar>[0], "load">) => {
    const openExternal = vi.fn();
    await act(async () => root.render(<PullRequestsSidebar projectId="project" openExternal={openExternal} close={vi.fn()} unavailable={false} {...props} />));
    return openExternal;
  };
  const button = (label: string) => [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label || candidate.getAttribute("aria-label") === label)!;

  it("lists the repository's pull requests and opens one in the browser", async () => {
    const load = vi.fn(async () => listed([pullRequest()]));
    const openExternal = await render({ load });

    expect(load).toHaveBeenCalledWith("project", "authored");
    expect(container.querySelector(".pull-requests-repository")?.textContent).toBe("acme/widget");
    const row = container.querySelector<HTMLButtonElement>(".pull-request-row")!;
    expect(row.textContent).toContain("#42 Add the PR sidebar");
    expect(row.textContent).toContain("octocat · feature/prs → main · 1 h ago");
    expect([...row.querySelectorAll(".pull-request-signal")].map((signal) => signal.textContent)).toEqual(["Checks passing", "Review required"]);

    await act(async () => row.click());
    expect(openExternal).toHaveBeenCalledWith("https://github.com/acme/widget/pull/42");
  });

  it("starts on Mine and reloads for each filter and for refresh", async () => {
    const load = vi.fn(async (_projectId: string, _filter: GitHostRepositoryPullRequestFilter) => listed([]));
    await render({ load });
    expect(load).toHaveBeenLastCalledWith("project", "authored");
    expect(button("Mine").getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("You have no open pull requests.");

    await act(async () => button("All").click());
    expect(load).toHaveBeenLastCalledWith("project", "all");
    expect(container.textContent).toContain("No open pull requests.");

    await act(async () => button("Review requested").click());
    expect(load).toHaveBeenLastCalledWith("project", "reviewRequested");

    await act(async () => button("Refresh pull requests").click());
    expect(load).toHaveBeenCalledTimes(4);
    expect(load).toHaveBeenLastCalledWith("project", "reviewRequested");
  });

  it("explains a typed degraded reason instead of claiming there are no pull requests", async () => {
    await render({ load: async () => listed([], { reason: "unauthorized" }) });
    expect(container.querySelector("[role=alert]")?.textContent).toContain("rejected the credentials");
    expect(container.textContent).not.toContain("No open pull requests.");
  });

  it("notes a truncated list and reports a failed request", async () => {
    await render({ load: async () => listed([pullRequest()], { truncated: true }) });
    expect(container.textContent).toContain("Showing the 1 most recently updated.");

    await render({ projectId: "other", load: async () => { throw new Error("method not found"); } });
    expect(container.querySelector("[role=alert]")?.textContent).toContain("too old to list pull requests");
  });

  it("does not load without a connected Project", async () => {
    const load = vi.fn(async () => listed([]));
    await render({ projectId: undefined, load });
    expect(container.textContent).toContain("Select a Project");
    await render({ unavailable: true, load });
    expect(container.textContent).toContain("not connected");
    expect(load).not.toHaveBeenCalled();
  });

  it("maps draft, failing, changes requested, and conflicts to signals", () => {
    expect(pullRequestSignals(pullRequest({ state: "draft", check_rollup: "failing", review_signal: "changesRequested", merge_conflict: "conflicting" })))
      .toEqual([
        { label: "Draft", tone: "idle" },
        { label: "Checks failing", tone: "danger" },
        { label: "Changes requested", tone: "danger" },
        { label: "Conflicts", tone: "danger" },
      ]);
    expect(pullRequestSignals(pullRequest({ check_rollup: "unsupported", review_signal: "notReported" }))).toEqual([]);
  });
});
