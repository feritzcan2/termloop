import { useCallback, useEffect, useState } from "react";
import type { DeletedSessionDto } from "@termloop/contract/current";
import { sessionLabel } from "../model.js";
import { Icon } from "./Icon.js";
import { RailHeader } from "./RailHeader.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

export type DeletedSessionsBinding = {
  sessions: readonly DeletedSessionDto[];
  loading: boolean;
  reload(): void;
  restore(sessionId: string): void;
};

export function useDeletedSessions(options: {
  projectId: string | undefined;
  activeSessionCount: number;
  list(projectId: string): Promise<DeletedSessionDto[]>;
  restore(sessionId: string): Promise<string | undefined>;
}): DeletedSessionsBinding {
  const [sessions, setSessions] = useState<readonly DeletedSessionDto[]>([]);
  const [loading, setLoading] = useState(false);
  const { activeSessionCount, list, projectId, restore: restoreSession } = options;
  const reload = useCallback(() => {
    if (!projectId) { setSessions([]); return; }
    setLoading(true);
    void list(projectId)
      .then(setSessions)
      .finally(() => setLoading(false));
  }, [list, projectId]);

  useEffect(() => { reload(); }, [activeSessionCount, reload]);

  const restore = useCallback((sessionId: string) => {
    void restoreSession(sessionId).then((failure) => { if (!failure) reload(); });
  }, [reload, restoreSession]);

  return { sessions, loading, reload, restore };
}

export function deletedRetentionLabel(purgeAtEpochMs: number, nowEpochMs = Date.now()): string {
  const days = Math.max(0, Math.ceil((purgeAtEpochMs - nowEpochMs) / DAY_MS));
  return `${days}d left`;
}

function restoreBlockerCopy(item: DeletedSessionDto): string | undefined {
  if (item.restore_blocker === "sourceUnavailable") return "Source folder is no longer available";
  if (item.restore_blocker === "taskArchived") return "Restore the containing Task first";
  return undefined;
}

export function DeletedRail(props: {
  sessions: readonly DeletedSessionDto[];
  loading: boolean;
  disabled: boolean;
  restore(sessionId: string): void;
}) {
  const [collapsed, setCollapsed] = useState(true);
  if (props.sessions.length === 0) return null;
  return (
    <section className="rail-section archived-section deleted-section" data-rail="deleted" aria-label="Deleted Agents">
      <RailHeader collapsed={collapsed} label="Deleted Agents" toggle={() => setCollapsed((value) => !value)}>
        <span className="rail-glyph deleted-rail-glyph" aria-hidden="true"><Icon name="trash" /></span>
        <h2>Deleted</h2>
        <span className="count-badge deleted-count" title={`${props.sessions.length} deleted Agents`}>{props.sessions.length}</span>
      </RailHeader>
      {collapsed ? null : (
        <div className="archived-list deleted-list" role="list" aria-label="Deleted Agents">
          {props.sessions.map((item) => {
            const label = sessionLabel(item.session);
            const blocker = restoreBlockerCopy(item);
            const retention = deletedRetentionLabel(item.purge_at_epoch_ms);
            return (
              <div key={item.session.id} className="archived-row deleted-row" role="listitem">
                <span className="archived-glyph" aria-hidden="true"><Icon name={item.session.process.agent_id === "claude" ? "claude" : "codex"} /></span>
                <span className="deleted-copy" title={`${label} · Deleted ${new Date(item.deleted_at_epoch_ms).toLocaleDateString()} · ${retention}${blocker ? ` · ${blocker}` : ""}`}>
                  <span className="archived-title">{label}</span>
                  <small className={`deleted-retention${blocker ? " unavailable" : ""}`}>{blocker ?? retention}</small>
                </span>
                <span className="archived-actions">
                  <button
                    type="button"
                    className="archived-restore deleted-restore"
                    disabled={props.disabled || Boolean(item.restore_blocker)}
                    aria-label={`Restore deleted Agent ${label}`}
                    title={blocker ?? "Restore Agent while its source folder is still available"}
                    onClick={() => props.restore(item.session.id)}
                  >restore</button>
                </span>
              </div>
            );
          })}
          {props.loading ? <p className="rail-empty" role="status">Refreshing deleted Agents…</p> : null}
        </div>
      )}
    </section>
  );
}
