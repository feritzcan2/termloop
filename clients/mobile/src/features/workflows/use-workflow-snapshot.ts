import type { WorkflowConfigurationListResult } from "@termloop/contract/current";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import type { ControlReadPort } from "../../application/ports";
import type { WorkflowTemplatesPort } from "../../application/workflow-templates-port";
import { useAppLifecycle } from "../../platform/app-lifecycle";
import { observeWorkflowSnapshots } from "./workflow-snapshot-observer";

export function useWorkflowSnapshot(templates: WorkflowTemplatesPort, control: ControlReadPort, connectionId: string, projectId: string, online: boolean) {
  const lifecycle = useAppLifecycle();
  const [snapshot, setSnapshot] = useState<WorkflowConfigurationListResult>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [checkedAt, setCheckedAt] = useState<number>();
  const revision = useRef(-1);
  const observer = useRef<ReturnType<typeof observeWorkflowSnapshots> | undefined>(undefined);
  useFocusEffect(useCallback(() => {
    if (!online || !lifecycle.active) { setLoading(false); return; }
    const current = observeWorkflowSnapshots({
      read: () => templates.list(connectionId, projectId),
      subscribe: (invalidate) => control.subscribeInvalidations(connectionId, (event) => {
        if (event.topics.some((topic) => topic === "workflow" || topic === "session")) invalidate();
      }),
      minimumRevision: () => revision.current,
      publish(next, now) { revision.current = next.stateRevision; setSnapshot(next); setCheckedAt(now); setError(undefined); },
      loading: setLoading,
      failed: setError,
    });
    observer.current = current;
    return () => { current.stop(); observer.current = undefined; };
  }, [templates, control, connectionId, projectId, online, lifecycle.active, lifecycle.foregroundRevision]));
  return { snapshot, loading, error, checkedAt, refresh: useCallback(() => observer.current?.refresh(), []) };
}
