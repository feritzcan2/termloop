// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationStatusDto } from "@termloop/contract/current";

import type { ConnectionProfileSummary } from "../src/connection-profile-types.js";
import { IntegrationsSettings, type IntegrationActions } from "../src/renderer/ui/IntegrationsSettings.js";
import {
  integrationErrorMessage,
  integrationRemediation,
  integrationRetryAfterLabel,
} from "../src/renderer/integration-status.js";

const NOW = 1_700_000_000_000;
const local: ConnectionProfileSummary = {
  id: "local", name: "MacBook Pro", transport: "local", scope: "local",
  endpoint: "", enabled: true, persistence: "local", state: "connected",
};
const remote: ConnectionProfileSummary = {
  id: "netcup", name: "Netcup", transport: "ssh", scope: "full",
  endpoint: "admin@host:43717", enabled: true, persistence: "encrypted", state: "connected",
};

function status(overrides: Partial<IntegrationStatusDto> = {}): IntegrationStatusDto {
  return {
    provider: "github", target: "github.com", state: "connected", account: "octocat", credentialSource: "cli",
    capabilities: [
      { capability: "pullRequests", available: true },
      { capability: "checks", available: true },
    ],
    retryAfterEpochMs: null, checkedAtEpochMs: NOW - 30_000,
    ...overrides,
  };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

async function render(actions: IntegrationActions, profiles = [local], extra: { openTaskSettings?: () => void; initialProfileId?: string } = {}) {
  await act(async () => root.render(<IntegrationsSettings actions={actions} listProfiles={async () => profiles}
    nowEpochMs={NOW} {...extra} />));
  await act(async () => {});
}
const card = (label: string) => host.querySelector<HTMLElement>(`article[aria-label="${label}"]`)!;
const button = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === text)!;
async function typeToken(value: string) {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Azure DevOps personal access token"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

describe("IntegrationsSettings", () => {
  it("renders review and task providers with state, account, capabilities and remediation", async () => {
    const list = vi.fn(async () => ({ integrations: [
      status(),
      status({
        provider: "azureDevOps", target: "dev.azure.com/contoso", state: "extensionMissing", account: null,
        credentialSource: null, capabilities: [{ capability: "checks", available: false }],
      }),
      status({ provider: "jira", target: "contoso.atlassian.net", state: "rateLimited", account: "ada@contoso.com",
        credentialSource: "apiToken", retryAfterEpochMs: NOW + 5 * 60_000, capabilities: [{ capability: "issues", available: true }] }),
    ] }));
    await render({ list, setAzureDevOpsToken: vi.fn() });
    expect(list).toHaveBeenCalledExactlyOnceWith("local", { refresh: false });

    const github = card("GitHub github.com");
    expect(github.querySelector(".integration-state")?.textContent).toBe("Connected");
    expect(github.querySelector(".integration-state")?.className).toContain("ok");
    expect(github.textContent).toContain("octocat");
    expect(github.textContent).toContain("Signed-in CLI");
    expect([...github.querySelectorAll(".integration-capabilities li")].map((chip) => chip.className))
      .toEqual(["available", "available"]);
    expect(github.querySelector(".integration-hint")).toBeNull();
    expect(github.textContent).toContain("Checked just now");

    const azure = card("Azure DevOps dev.azure.com/contoso");
    expect(azure.querySelector(".integration-state")?.textContent).toBe("Extension missing");
    expect(azure.querySelector(".integration-hint code")?.textContent).toBe("az extension add --name azure-devops");
    expect(azure.querySelector(".integration-capabilities li")?.className).toBe("unavailable");
    expect(azure.querySelector('input[type="password"]')).not.toBeNull();

    const jira = card("Jira contoso.atlassian.net");
    expect(jira.querySelector(".integration-state")?.textContent).toBe("Rate limited");
    expect(jira.textContent).toContain("Retry in 5m");
    expect(host.querySelector("#integrations-review-title")?.textContent).toBe("Review providers");
    expect(host.querySelector("#integrations-task-title")?.textContent).toBe("Task providers");
  });

  it("refreshes with refresh: true and points an empty Jira section at Task Settings", async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ integrations: [status({ state: "notAuthenticated", account: null, credentialSource: null })] })
      .mockResolvedValueOnce({ integrations: [status()] });
    const openTaskSettings = vi.fn();
    await render({ list, setAzureDevOpsToken: vi.fn() }, [local], { openTaskSettings });
    const github = card("GitHub github.com");
    expect(github.querySelector(".integration-hint code")?.textContent).toBe("gh auth login");
    expect(host.textContent).toContain("No Jira site is connected on this computer");
    await act(async () => button(github, "Refresh").click());
    await act(async () => {});
    expect(list).toHaveBeenLastCalledWith("local", { refresh: true });
    expect(card("GitHub github.com").querySelector(".integration-state")?.textContent).toBe("Connected");
    await act(async () => button(host, "Open Task Settings").click());
    expect(openTaskSettings).toHaveBeenCalledOnce();
  });

  it("saves and removes the Azure DevOps PAT on the selected computer and shows the returned status", async () => {
    const list = vi.fn(async () => ({ integrations: [status({
      provider: "azureDevOps", target: "dev.azure.com", state: "notAuthenticated", account: null, credentialSource: null,
    })] }));
    const setAzureDevOpsToken = vi.fn()
      .mockResolvedValueOnce({ status: status({ provider: "azureDevOps", target: "dev.azure.com", account: "ada", credentialSource: "personalAccessToken" }) })
      .mockResolvedValueOnce({ status: status({ provider: "azureDevOps", target: "dev.azure.com", state: "notAuthenticated", account: null, credentialSource: null }) });
    await render({ list, setAzureDevOpsToken }, [local, remote], { initialProfileId: "netcup" });
    expect(list).toHaveBeenCalledWith("netcup", { refresh: false });
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Computer"]')?.value).toBe("netcup");

    const azure = () => card("Azure DevOps dev.azure.com");
    expect(button(azure(), "Save").disabled).toBe(true);
    const input = await typeToken("  secret-pat  ");
    expect(input.type).toBe("password");
    await act(async () => button(azure(), "Save").click());
    expect(setAzureDevOpsToken).toHaveBeenLastCalledWith("netcup", { token: "secret-pat" });
    expect(azure().querySelector(".integration-state")?.textContent).toBe("Connected");
    expect(azure().textContent).toContain("Personal access token");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Azure DevOps personal access token"]')!.value).toBe("");
    expect(host.innerHTML).not.toContain("secret-pat");

    await act(async () => button(azure(), "Remove").click());
    expect(setAzureDevOpsToken).toHaveBeenLastCalledWith("netcup", { token: null });
    expect(azure().querySelector(".integration-state")?.textContent).toBe("Not signed in");
    expect(azure().textContent).toContain("Personal access token removed.");
  });

  it("explains an older daemon, a daemon error, and a read-only computer", async () => {
    await render({ list: vi.fn(async () => { throw new Error("Error invoking remote method 'termloop:integration-status-list': TermLoopControlError: method not found"); }), setAzureDevOpsToken: vi.fn() });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("too old to report integrations");

    const failing = vi.fn()
      .mockRejectedValueOnce(new Error("connection failed"))
      .mockResolvedValueOnce({ integrations: [] });
    await act(async () => root.unmount());
    root = createRoot(host);
    await render({ list: failing, setAzureDevOpsToken: vi.fn() });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not reach this computer");
    await act(async () => button(host, "Retry").click());
    await act(async () => {});
    expect(failing).toHaveBeenLastCalledWith("local", { refresh: true });
    expect(card("GitHub integration").textContent).toContain("Not reported");

    await act(async () => root.unmount());
    root = createRoot(host);
    const list = vi.fn();
    await render({ list, setAzureDevOpsToken: vi.fn() }, [{ ...remote, scope: "readOnly" }], { initialProfileId: "netcup" });
    expect(list).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Full access to this computer is required");
  });
});

describe("integration status copy", () => {
  it("names the fix for each provider and state", () => {
    const text = (value: IntegrationStatusDto) => integrationRemediation(value)?.map((part) => typeof part === "string" ? part : part.code).join("");
    expect(text(status({ state: "notInstalled" }))).toContain("gh");
    expect(text(status({ provider: "azureDevOps", target: "dev.azure.com", state: "notAuthenticated", credentialSource: null }))).toContain("az login");
    expect(text(status({ provider: "azureDevOps", target: "dev.azure.com", state: "notInstalled", credentialSource: "personalAccessToken" })))
      .toContain("Install the Azure CLI");
    expect(text(status({ provider: "azureDevOps", target: "dev.azure.com", state: "notInstalled" }))).not.toContain("personal access token");
    expect(text(status({ provider: "jira", target: "x.atlassian.net", state: "notConfigured" }))).toContain("Task Settings");
    expect(text(status({ state: "offline" }))).toContain("can't reach github.com");
    expect(integrationRemediation(status())).toBeUndefined();
    expect(integrationRetryAfterLabel(status({ retryAfterEpochMs: NOW - 1 }), NOW)).toBe("Retry now");
    expect(integrationRetryAfterLabel(status(), NOW)).toBeUndefined();
    expect(integrationErrorMessage(new Error("capabilityDenied"))).toContain("Full access");
  });
});
