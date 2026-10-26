// Small read-only views of a ticket's delivery facts: the pull request line.
import type { PmDeliveryRisk, PmFactSource, PmFactsSummary } from "@termloop/pm-contract/pm";

export const SOURCE_LABEL: Record<PmFactSource, string> = { jira: "Jira", gitHost: "pull requests" };

const GIT_HOST_FAILURE = "Pull requests could not be read: ";

/** The editor's pull request line; the count covers every linked pull request, open or not. */
export function pullRequestLine(facts: PmFactsSummary, risks: readonly PmDeliveryRisk[]): { text: string; unavailable: boolean } {
  if (facts.failedReads.includes("gitHost")) {
    const detail = risks.find((risk) => risk.kind === "readFailed" && risk.detail.startsWith(GIT_HOST_FAILURE))?.detail;
    return { text: `Pull requests unavailable${detail ? `: ${detail.slice(GIT_HOST_FAILURE.length)}` : ""}`, unavailable: true };
  }
  const count = facts.pullRequests;
  return { text: count === 0 ? "No pull request" : `${count} ${count === 1 ? "pull request" : "pull requests"}`, unavailable: false };
}
