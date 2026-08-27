import { useCallback, useEffect, useState } from "react";

import type {
  McpToolDescriptionResetParams,
  McpToolDescriptionUpdateParams,
  McpToolSettingsDto,
  McpToolSettingsResult,
} from "@termloop/contract/current";
import {
  MCP_TOOL_DESCRIPTION_MAX_CHARACTERS,
  mcpToolDescriptionError,
  mcpToolRoleLabel,
  type McpSettingsMutationResult,
} from "../mcp-settings.js";
import { Icon } from "./Icon.js";
import { ConfigurationVersions, useConfigurationVersions, type ConfigurationVersionActions } from "./PromptImprovement.js";

/// Stage page for one MCP tool description. Saves carry the revision the rail
/// was loaded with, so a change made in another client surfaces as a conflict
/// and reloads the current text instead of overwriting it.
export function McpToolPanel({ tool, stateRevision, update, reset, apply, versions, reload, close }: {
  tool: McpToolSettingsDto;
  stateRevision: number;
  update(params: McpToolDescriptionUpdateParams): Promise<McpSettingsMutationResult>;
  reset(params: McpToolDescriptionResetParams): Promise<McpSettingsMutationResult>;
  apply(settings: McpToolSettingsResult): void;
  versions?: ConfigurationVersionActions | undefined;
  reload?: (() => void) | undefined;
  close(): void;
}) {
  const [draft, setDraft] = useState(tool.effectiveDescription);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const versionController = useConfigurationVersions(
    versions,
    { kind: "settingsMcpTool", targetId: tool.name },
    { watch: true, refreshKey: String(stateRevision) },
  );

  useEffect(() => {
    setDraft(tool.effectiveDescription);
    setError(undefined);
  }, [tool.effectiveDescription, tool.name]);

  const settle = useCallback((result: McpSettingsMutationResult, conflictCopy: string) => {
    if (result.ok) {
      apply(result.result);
      setError(undefined);
      return;
    }
    setError(result.code === "conflict" ? conflictCopy : result.message);
  }, [apply]);

  const validationError = mcpToolDescriptionError(draft);
  const dirty = draft !== tool.effectiveDescription;

  const save = useCallback(async () => {
    if (busy || !dirty || validationError) return;
    setBusy(true);
    try {
      settle(
        await update({ tool: tool.name, description: draft, expectedRevision: stateRevision }),
        "Settings changed in another client. Reload the rail, then save again.",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [busy, dirty, draft, settle, stateRevision, tool.name, update, validationError]);

  const resetTool = useCallback(async () => {
    setBusy(true);
    try {
      settle(
        await reset({ tool: tool.name, expectedRevision: stateRevision }),
        "Settings changed in another client. Reload the rail, then reset again.",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [reset, settle, stateRevision, tool.name]);

  return (
    <section className="stage-editor" aria-label={`${tool.title} MCP tool`}>
      <header className="stage-editor-head">
        <div className="stage-editor-title">
          <span>MCP tool</span>
          <h2>{tool.title}</h2>
          <code>{tool.name}</code>
        </div>
        <div className="stage-editor-actions">
          {tool.customized
            ? <button className="secondary-button" type="button" disabled={busy} onClick={() => void resetTool()}>Reset to canonical</button>
            : null}
          <button
            className="primary-button"
            type="button"
            disabled={busy || !dirty || Boolean(validationError)}
            onClick={() => void save()}
          >{busy ? "Saving…" : "Save"}</button>
          <button className="icon-button quiet" type="button" aria-label="Close MCP tool" onClick={close}><Icon name="close" /></button>
        </div>
      </header>
      <div className="stage-editor-facts">
        <div className="stage-editor-chips" aria-label="Visible to">
          {tool.roles.map((role) => <span key={role} className="stage-editor-chip">{mcpToolRoleLabel(role)}</span>)}
        </div>
        <span>{tool.customized ? "Customized description" : "Canonical TermLoop description"}</span>
      </div>
      {error ? <p className="settings-rail-error" role="alert">{error}</p> : null}
      <textarea
        className="stage-editor-source"
        value={draft}
        maxLength={MCP_TOOL_DESCRIPTION_MAX_CHARACTERS}
        spellCheck={false}
        disabled={busy}
        aria-label={`${tool.title} description`}
        aria-invalid={Boolean(validationError)}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "s") {
            event.preventDefault();
            void save();
          }
        }}
      />
      <div className="stage-editor-meta">
        <span className={validationError && dirty ? "form-error" : undefined}>
          {validationError && dirty ? validationError : "Saved text is sent to agents in future Sessions. Connection details and credentials stay inside the daemon."}
        </span>
        <code>{[...draft].length.toLocaleString("en-US")} / {MCP_TOOL_DESCRIPTION_MAX_CHARACTERS.toLocaleString("en-US")}</code>
      </div>
      <ConfigurationVersions controller={versionController} reload={reload ?? (() => undefined)} />
    </section>
  );
}
