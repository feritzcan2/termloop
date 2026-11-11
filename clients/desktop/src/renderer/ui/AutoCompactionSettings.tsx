import { useEffect, useState } from "react";
import type { AutoCompactionSettingsDto, StewardAgentId } from "@termloop/contract/current";

export const CLAUDE_AUTO_COMPACT_WINDOW_MIN_TOKENS = 100_000;
export const CLAUDE_AUTO_COMPACT_WINDOW_MAX_TOKENS = 1_000_000;
export const CODEX_AUTO_COMPACT_THRESHOLD_MIN_PERCENT = 1;
export const CODEX_AUTO_COMPACT_THRESHOLD_MAX_PERCENT = 100;

/** The edited value for the Steward's provider, or null when it is out of range. */
export function autoCompactionDraftValue(agentId: StewardAgentId, text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim());
  const [min, max] = agentId === "claude"
    ? [CLAUDE_AUTO_COMPACT_WINDOW_MIN_TOKENS, CLAUDE_AUTO_COMPACT_WINDOW_MAX_TOKENS]
    : [CODEX_AUTO_COMPACT_THRESHOLD_MIN_PERCENT, CODEX_AUTO_COMPACT_THRESHOLD_MAX_PERCENT];
  return value >= min && value <= max ? value : null;
}

/** Replaces only the selected provider's value; the other provider keeps its choice. */
export function withAutoCompactionValue(
  settings: AutoCompactionSettingsDto,
  agentId: StewardAgentId,
  value: number,
): AutoCompactionSettingsDto {
  return agentId === "claude"
    ? { ...settings, claudeWindowTokens: value }
    : { ...settings, codexThresholdPercent: value };
}

export function AutoCompactionSettings(props: {
  agentId: StewardAgentId;
  settings: AutoCompactionSettingsDto;
  busy: boolean;
  save(settings: AutoCompactionSettingsDto): Promise<void>;
}) {
  const current = props.agentId === "claude"
    ? props.settings.claudeWindowTokens
    : props.settings.codexThresholdPercent;
  const [draft, setDraft] = useState(String(current));
  useEffect(() => { setDraft(String(current)); }, [current, props.agentId]);
  const value = autoCompactionDraftValue(props.agentId, draft);
  const claude = props.agentId === "claude";
  const label = claude ? "Compact at (tokens)" : "Compact at (% of context)";
  return <section className="ap-form ap-launch-settings" aria-label="Steward auto-compaction">
    <div className="ap-editor">
      <div className="ap-editor-head"><label>Auto-compaction</label></div>
      <p className="ap-hint">{claude
        ? `Claude compacts the Steward's conversation once it fills this many tokens (${CLAUDE_AUTO_COMPACT_WINDOW_MIN_TOKENS.toLocaleString()}–${CLAUDE_AUTO_COMPACT_WINDOW_MAX_TOKENS.toLocaleString()}).`
        : `Codex compacts the Steward's conversation when a turn ends above this share of the model's context window (${CODEX_AUTO_COMPACT_THRESHOLD_MIN_PERCENT}–${CODEX_AUTO_COMPACT_THRESHOLD_MAX_PERCENT}%).`}
        {" "}Saving restarts the Steward so the new value takes effect.</p>
      <div className="ap-launch-fields">
        <label>{label}<input aria-label={`Steward ${label}`} type="number" inputMode="numeric" disabled={props.busy}
          min={claude ? CLAUDE_AUTO_COMPACT_WINDOW_MIN_TOKENS : CODEX_AUTO_COMPACT_THRESHOLD_MIN_PERCENT}
          max={claude ? CLAUDE_AUTO_COMPACT_WINDOW_MAX_TOKENS : CODEX_AUTO_COMPACT_THRESHOLD_MAX_PERCENT}
          step={claude ? 10_000 : 1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)} /></label>
      </div>
      <div className="ap-actions"><button type="button" className="ap-btn primary"
        disabled={props.busy || value === null || value === current}
        onClick={() => {
          if (value !== null) void props.save(withAutoCompactionValue(props.settings, props.agentId, value));
        }}>Save compaction</button></div>
    </div>
  </section>;
}
