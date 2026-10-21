import type {
  IntegrationCapability,
  IntegrationConnectionState,
  IntegrationCredentialSource,
  IntegrationProvider,
  IntegrationStatusDto,
} from "@termloop/contract/current";

import { controlErrorMessage } from "./control-error.js";

/* React-free presentation of the daemon's per-computer integration status.
   Every fact comes from `integration.statusList`; nothing here probes a CLI,
   reads a credential, or decides whether a provider works. */

export type IntegrationTone = "ok" | "warn" | "danger" | "idle";

export function integrationProviderLabel(provider: IntegrationProvider): string {
  return provider === "github" ? "GitHub" : provider === "azureDevOps" ? "Azure DevOps" : "Jira";
}

const STATE_COPY: Record<IntegrationConnectionState, { label: string; tone: IntegrationTone }> = {
  connected: { label: "Connected", tone: "ok" },
  notInstalled: { label: "Not installed", tone: "idle" },
  notAuthenticated: { label: "Not signed in", tone: "warn" },
  extensionMissing: { label: "Extension missing", tone: "warn" },
  notConfigured: { label: "Not set up", tone: "idle" },
  offline: { label: "Offline", tone: "danger" },
  rateLimited: { label: "Rate limited", tone: "warn" },
  timeout: { label: "Timed out", tone: "danger" },
  failed: { label: "Check failed", tone: "danger" },
};

export function integrationStateCopy(state: IntegrationConnectionState): { label: string; tone: IntegrationTone } {
  return STATE_COPY[state];
}

export function integrationCredentialSourceLabel(source: IntegrationCredentialSource | null): string | undefined {
  if (source === null) return undefined;
  return source === "cli" ? "Signed-in CLI" : source === "personalAccessToken" ? "Personal access token" : "API token";
}

export function integrationCapabilityLabel(capability: IntegrationCapability): string {
  switch (capability) {
    case "pullRequests": return "Pull requests";
    case "checks": return "Build checks";
    case "reviews": return "Reviews";
    case "mergeConflicts": return "Merge conflicts";
    case "issues": return "Issues";
  }
}

/** A hint is plain words with inline commands kept separate, so the pane can
    render a command as code the user copies verbatim. */
export type IntegrationHintPart = string | { code: string };

export function integrationRemediation(status: IntegrationStatusDto): IntegrationHintPart[] | undefined {
  const provider = integrationProviderLabel(status.provider);
  switch (status.state) {
    case "connected":
      return undefined;
    case "offline":
      return [`This computer can't reach ${status.target}. Check its network connection, then refresh.`];
    case "rateLimited":
      return [`${provider} is limiting requests from this computer. TermLoop tries again after the limit resets.`];
    case "timeout":
      return [`${provider} didn't answer in time. Refresh to try again.`];
    case "failed":
      return [`${provider} returned an unexpected answer. Refresh to try again.`];
    default:
      break;
  }
  if (status.provider === "github") {
    if (status.state === "notInstalled") {
      return ["Install the GitHub CLI ", { code: "gh" }, " on this computer, then refresh."];
    }
    return ["Run ", { code: "gh auth login" }, " in a terminal on this computer, then refresh."];
  }
  if (status.provider === "azureDevOps") {
    // A saved token is only ever handed to `az`, so it cannot stand in for a
    // missing CLI or extension.
    if (status.state === "notInstalled") {
      return ["Install the Azure CLI ", { code: "az" }, " on this computer, then refresh."];
    }
    if (status.state === "extensionMissing") {
      return ["Run ", { code: "az extension add --name azure-devops" }, " in a terminal on this computer, then refresh."];
    }
    return ["Run ", { code: "az login" }, " in a terminal on this computer, or save a personal access token below."];
  }
  if (status.state === "notAuthenticated") {
    return ["Jira rejected the API token. Replace it in the Project's Task Settings."];
  }
  return ["Connect this Jira site from the Project's Task Settings."];
}

export function integrationRetryAfterLabel(status: IntegrationStatusDto, nowEpochMs: number): string | undefined {
  if (status.retryAfterEpochMs === null) return undefined;
  if (status.retryAfterEpochMs <= nowEpochMs) return "Retry now";
  const minutes = Math.max(1, Math.round((status.retryAfterEpochMs - nowEpochMs) / 60_000));
  return minutes < 60 ? `Retry in ${minutes}m` : `Retry after ${new Date(status.retryAfterEpochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export function integrationCheckedLabel(checkedAtEpochMs: number, nowEpochMs: number): string {
  const seconds = Math.max(0, Math.round((nowEpochMs - checkedAtEpochMs) / 1000));
  if (seconds < 60) return "Checked just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Checked ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `Checked ${hours}h ago` : `Checked ${new Date(checkedAtEpochMs).toLocaleDateString()}`;
}

export type IntegrationGroups = {
  github: IntegrationStatusDto[];
  azureDevOps: IntegrationStatusDto[];
  jira: IntegrationStatusDto[];
};

export function groupIntegrations(integrations: readonly IntegrationStatusDto[]): IntegrationGroups {
  const byTarget = (left: IntegrationStatusDto, right: IntegrationStatusDto) => left.target.localeCompare(right.target);
  return {
    github: integrations.filter((value) => value.provider === "github").sort(byTarget),
    azureDevOps: integrations.filter((value) => value.provider === "azureDevOps").sort(byTarget),
    jira: integrations.filter((value) => value.provider === "jira").sort(byTarget),
  };
}

/** An older daemon answers the new methods with a typed "method not found";
    that is a version gap the user fixes by updating, not a broken provider. */
export function integrationMethodUnavailable(error: unknown): boolean {
  return /method not found|methodNotFound|unknown method/iu.test(controlErrorMessage(error));
}

export function integrationErrorMessage(error: unknown): string {
  if (integrationMethodUnavailable(error)) {
    return "This computer's TermLoop server is too old to report integrations. Update it, then refresh.";
  }
  const message = controlErrorMessage(error);
  if (/capabilityDenied|capability denied|read-only|readOnly/iu.test(message)) {
    return "Full access to this computer is required to check integrations.";
  }
  if (/secure credential|credential store/iu.test(message)) {
    return "This computer's secure credential storage is unavailable. Unlock it and try again.";
  }
  if (/connectionProfileRequired|unknownConnectionProfile|daemonUnavailable|connection (?:failed|closed|timeout)|request timeout/iu.test(message)) {
    return "TermLoop could not reach this computer's server. Reconnect and try again.";
  }
  return message || "Integration status could not be loaded.";
}
