// Small read-only views of a ticket's delivery facts: environment badges and the pull request line.
import type { PmDeliveryRisk, PmEnvironment, PmFactSource, PmFactsSummary } from "@termloop/pm-contract/pm";
import { relativeTime } from "./format.js";

export const SOURCE_LABEL: Record<PmFactSource, string> = { jira: "Jira", gitHost: "pull requests", probe: "probes", check: "delivery checks", projectManager: "your edits" };

/** Why the facts may be out of date, or `undefined` when they are current. */
export function factsCaveat(facts: PmFactsSummary | null, now: number): string | undefined {
  if (!facts) return "No delivery facts read yet";
  const reasons = [
    facts.stale ? `Facts are stale (read ${relativeTime(facts.recordedAtEpochMs, now)})` : undefined,
    facts.failedReads.length > 0 ? `Could not read ${facts.failedReads.map((source) => SOURCE_LABEL[source]).join(", ")}` : undefined,
  ].filter(Boolean);
  return reasons.length > 0 ? reasons.join(". ") : undefined;
}

/**
 * One badge per project environment in delivery order, filled where the
 * ticket is deployed. Stale or partly failed facts dim the badges and say why.
 */
export function EnvironmentBadges(props: { environments: readonly PmEnvironment[]; facts: PmFactsSummary | null; now: number }) {
  if (props.environments.length === 0) return null;
  const deployed = new Set(props.facts?.deployedEnvironments ?? []);
  const caveat = factsCaveat(props.facts, props.now);
  const summary = props.environments.map((environment) => `${environment.name} ${deployed.has(environment.name) ? "deployed" : "not deployed"}`).join(", ");
  return (
    <span className={`env-badges ${caveat ? "uncertain" : ""}`} data-testid="env-badges" title={caveat ?? summary} aria-label={`Environments: ${summary}${caveat ? `. ${caveat}` : ""}`}>
      {props.environments.map((environment) => {
        const on = deployed.has(environment.name);
        return <span key={environment.name} className={`env ${on ? "on" : "off"}`}>{environment.name}{on ? " ✓" : ""}</span>;
      })}
    </span>
  );
}

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
