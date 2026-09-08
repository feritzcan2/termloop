import type { AgentAccountCreateParams, AgentAccountRenameParams, AgentAccountSetDefaultParams, AgentAuthStatusListParams } from "@termloop/contract/current";
import { shell, type IpcMain, type IpcMainInvokeEvent } from "electron";
import type { AgentAuthOperationDto, AgentAuthOperationParams, AgentAuthSubmitCodeParams, AgentConnectionParams } from "@termloop/contract/current";
import { controlCall } from "./control.js";

export function signInUrl(operation: AgentAuthOperationDto): string {
  const value = operation.verificationUrl;
  if (!value || value.length > 4096 || /[\s\\\u0000-\u001f\u007f]/u.test(value)
    || !["awaitingBrowser", "awaitingCode"].includes(operation.phase)
    || operation.expiresAtEpochMs <= Date.now()) throw new Error("This sign-in attempt has expired. Start a new one.");
  const url = new URL(value);
  const allowed = operation.agentId === "codex"
    ? value === "https://auth.openai.com/codex/device"
    : (url.hostname === "claude.com" && url.pathname === "/cai/oauth/authorize") || (["claude.ai", "platform.claude.com", "console.anthropic.com"].includes(url.hostname) && url.pathname === "/oauth/authorize");
  if (!allowed || url.protocol !== "https:" || url.username || url.password || url.port || url.hash) throw new Error("The provider returned an unsupported sign-in address.");
  return value;
}

export function registerAgentConnectionIpc(handle: IpcMain["handle"], requireRenderer: (event: IpcMainInvokeEvent) => void): void {
  handle("termloop:agent-account-list", (event) => { requireRenderer(event); return controlCall("agent.accountList"); });
  handle("termloop:agent-account-create", (event, params: AgentAccountCreateParams) => { requireRenderer(event); return controlCall("agent.accountCreate", params); });
  handle("termloop:agent-account-rename", (event, params: AgentAccountRenameParams) => { requireRenderer(event); return controlCall("agent.accountRename", params); });
  handle("termloop:agent-account-set-default", (event, params: AgentAccountSetDefaultParams) => { requireRenderer(event); return controlCall("agent.accountSetDefault", params); });
  handle("termloop:agent-auth-status-list", (event, params: AgentAuthStatusListParams = {}) => { requireRenderer(event); return controlCall("agent.authStatusList", params); });
  handle("termloop:agent-install", (event, params: AgentConnectionParams) => { requireRenderer(event); return controlCall("agent.install", params); });
  handle("termloop:agent-auth-start", (event, params: AgentConnectionParams) => { requireRenderer(event); return controlCall("agent.authStart", params); });
  handle("termloop:agent-auth-logout", (event, params: AgentConnectionParams) => { requireRenderer(event); return controlCall("agent.authLogout", params); });
  handle("termloop:agent-auth-get", (event, params: AgentAuthOperationParams) => { requireRenderer(event); return controlCall("agent.authGet", params); });
  handle("termloop:agent-auth-cancel", (event, params: AgentAuthOperationParams) => { requireRenderer(event); return controlCall("agent.authCancel", params); });
  handle("termloop:agent-auth-submit-code", (event, params: AgentAuthSubmitCodeParams) => { requireRenderer(event); return controlCall("agent.authSubmitCode", params); });
  handle("termloop:agent-auth-open", async (event, params: AgentAuthOperationParams) => {
    requireRenderer(event);
    // Re-read the exact authenticated operation. The renderer cannot supply an
    // arbitrary URL or redirect a challenge from a different server.
    await shell.openExternal(signInUrl(await controlCall("agent.authGet", params)));
  });
}
