import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssistantPromptImproverTarget,
  ConfigurationVersionDto,
  ConfigurationVersionListResult,
  VersionedConfigurationTarget,
} from "@termloop/contract/current";
import type { QuickActionAgentSelection } from "../quick-action-memory.js";
import { Icon } from "./Icon.js";

export type ConfigurationVersionActions = {
  versions(target: VersionedConfigurationTarget): Promise<ConfigurationVersionListResult | string>;
  restore(target: VersionedConfigurationTarget, version: ConfigurationVersionDto, activeVersionId: string | null): Promise<string | undefined>;
};

export type PromptImprovement = ConfigurationVersionActions & {
  start(target: AssistantPromptImproverTarget, selection?: QuickActionAgentSelection, options?: { fresh?: boolean }): Promise<string | undefined>;
};

/** User-facing action copy names the scope being changed. The same target must
    read the same way on its editor button and in the launch setup dialog. */
export function promptImprovementActionLabel(
  surface: AssistantPromptImproverTarget["surface"],
): string {
  switch (surface) {
    case "playbook": return "Edit pipeline with agent";
    case "routineBuilder": return "Add Routine with agent";
    case "routineInstructions": return "Improve this Routine";
    case "stewardInstructions": return "Improve Steward defaults";
    case "workerInstructions": return "Improve Worker defaults";
  }
}

export function assistantVersionTarget(target: AssistantPromptImproverTarget): VersionedConfigurationTarget {
  switch (target.surface) {
    case "stewardInstructions": return { kind: "stewardInstructions", targetId: null };
    case "workerInstructions": return { kind: "workerInstructions", targetId: target.ownerId };
    case "routineInstructions": return { kind: "routineInstructions", targetId: target.ownerId };
    case "routineBuilder": return { kind: "routineBuilder", targetId: target.ownerId };
    case "playbook": return { kind: "playbook", targetId: null };
  }
}

export function useConfigurationVersions(
  actions: ConfigurationVersionActions | undefined,
  target: VersionedConfigurationTarget,
  options?: {
    watch?: boolean;
    refreshKey?: string | undefined;
    start?: (() => Promise<string | undefined>) | undefined;
  },
) {
  const [history, setHistory] = useState<ConfigurationVersionListResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [awaitingVersion, setAwaitingVersion] = useState(false);
  const launchBaseVersionId = useRef<string | null | undefined>(undefined);
  const versionTarget = useMemo<VersionedConfigurationTarget>(() => ({
    kind: target.kind,
    targetId: target.targetId,
  }), [target.kind, target.targetId]);
  const refresh = useCallback(async () => {
    if (!actions) return;
    const result = await actions.versions(versionTarget);
    if (typeof result === "string") {
      setError(result);
      return;
    }
    setError(undefined);
    setHistory(result);
    const newestId = result.versions.at(-1)?.id ?? null;
    if (awaitingVersion && newestId !== launchBaseVersionId.current) setAwaitingVersion(false);
  }, [actions, awaitingVersion, versionTarget]);
  useEffect(() => { void refresh(); }, [options?.refreshKey, refresh]);
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
  useEffect(() => {
    if (!awaitingVersion && !options?.watch) return;
    const interval = window.setInterval(() => void refresh(), 1_000);
    return () => window.clearInterval(interval);
  }, [awaitingVersion, options?.watch, refresh]);

  const guard = async (work: () => Promise<string | undefined>) => {
    setBusy(true);
    setError(undefined);
    try {
      const failure = await work();
      if (failure) setError(failure);
      return failure;
    } finally {
      setBusy(false);
    }
  };
  return {
    history,
    busy,
    error,
    awaitingVersion,
    refresh,
    start: () => guard(async () => {
      launchBaseVersionId.current = history?.versions.at(-1)?.id ?? null;
      const failure = await options?.start?.();
      if (!failure) setAwaitingVersion(true);
      return failure;
    }),
    restore: (version: ConfigurationVersionDto, restored: () => void | Promise<void>) => guard(async () => {
      if (!actions || !history) return undefined;
      const activeVersionId = history.activeVersionId;
      const failure = await actions.restore(versionTarget, version, activeVersionId);
      if (failure) return failure;
      await refresh();
      await restored();
      return undefined;
    }),
  };
}

export function usePromptImprovement(
  improvement: PromptImprovement | undefined,
  target: AssistantPromptImproverTarget,
  options?: { watch?: boolean; refreshKey?: string | undefined },
) {
  const stableTarget = useMemo<AssistantPromptImproverTarget>(() => ({
    surface: target.surface,
    ownerId: target.ownerId,
  }), [target.ownerId, target.surface]);
  const versionTarget = useMemo(() => assistantVersionTarget(stableTarget), [stableTarget]);
  return useConfigurationVersions(improvement, versionTarget, {
    ...(options?.watch === undefined ? {} : { watch: options.watch }),
    ...(options?.refreshKey === undefined ? {} : { refreshKey: options.refreshKey }),
    start: () => improvement?.start(stableTarget) ?? Promise.resolve(undefined),
  });
}

export type ConfigurationVersionsController = Pick<ReturnType<typeof usePromptImprovement>,
  "history" | "busy" | "error" | "restore"
>;

export function ConfigurationVersions(props: {
  controller: ConfigurationVersionsController;
  reload(): void | Promise<void>;
}) {
  const { controller } = props;
  const versions = useMemo(
    () => [...(controller.history?.versions ?? [])].sort((left, right) => left.sequence - right.sequence),
    [controller.history?.versions],
  );
  const activeIndex = versions.findIndex(
    (version) => version.id === controller.history?.activeVersionId,
  );
  const active = versions[activeIndex];
  if (!controller.history && !controller.error) return null;
  if (!active) return controller.error
    ? <span className="configuration-version-error" role="alert" title={controller.error}>!</span>
    : null;
  const activate = (index: number) => {
    const version = versions[index];
    if (version) void controller.restore(version, props.reload);
  };
  return <span className="configuration-versions" role="group" aria-label="Configuration version">
    <button type="button" aria-label="Previous version"
      disabled={controller.busy || activeIndex === 0}
      onClick={() => activate(activeIndex - 1)}>‹</button>
    <span aria-live="polite">v{active.sequence}</span>
    <button type="button" aria-label="Next version"
      disabled={controller.busy || activeIndex >= versions.length - 1}
      onClick={() => activate(activeIndex + 1)}>›</button>
    {controller.error ? <span className="configuration-version-error" role="alert" title={controller.error}>!</span> : null}
  </span>;
}

export function PromptImproveButton(props: {
  improvement: PromptImprovement | undefined;
  busy: boolean;
  title: string;
  label?: string;
  start(): void;
  setup(): void;
}) {
  if (!props.improvement) return null;
  return <span className="ap-improve-group agent-action-split">
    <button type="button" className="ap-btn ap-improve agent-action-main" disabled={props.busy} title={props.title} onClick={props.start}>
      <Icon name="sparkles" />{props.label ?? "Improve with agent"}
    </button>
    <button type="button" className="ap-btn ap-improve-setup agent-action-setup" disabled={props.busy} title="Choose the agent and fallback launch settings" onClick={props.setup}>
      Setup <span aria-hidden="true">▾</span>
    </button>
  </span>;
}
