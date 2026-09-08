import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import type { AgentCapabilityDto } from "@termloop/contract/current";

import type {
  AgentLaunchAgentId,
  AgentLaunchInspection,
  AgentLaunchPermission,
  AgentLaunchReasoning,
  AgentLaunchSelection,
} from "@/application/ports";
import { Banner, Card, CardDivider, PrimaryButton, SectionHeader } from "@/components/primitives";
import { Screen, ScreenHeader } from "@/components/screen";
import { useMobileRuntime } from "@/composition/runtime-context";
import { useConnections } from "@/features/connection/connection-store";
import { useOverview } from "@/features/overview/overview-store";
import {
  coerceModel,
  defaultLaunchSelection,
  launchAgentOptions,
  launchBlockedReason,
  modelLabel,
  permissionLabel,
  restoreLaunchSelection,
} from "@/presentation/agent-launch-presentation";
import { agentLaunchPreferences } from "@/platform/agent-launch-preferences";
import { keyboardAvoidingBehavior } from "@/platform/presentation";
import { color, radius, space } from "@/theme/tokens";
import { fontFamily, text } from "@/theme/typography";

const PROJECT_TARGET_PREFIX = "project:";

/// Start with the last successful choices. The Mac still previews and binds
/// the exact prompt and settings before launch; inspection is available in Edit.
export default function LaunchRoute() {
  const { taskId, connectionId: routeConnectionId } = useLocalSearchParams<{
    taskId: string;
    connectionId?: string;
  }>();
  const router = useRouter();
  const runtime = useMobileRuntime();
  const connections = useConnections();
  const selectingConnection = routeConnectionId !== undefined
    && connections.selectedId !== routeConnectionId;
  const selected = selectingConnection ? undefined : connections.selected;
  const store = useOverview();

  const projectId = taskId?.startsWith(PROJECT_TARGET_PREFIX)
    ? taskId.slice(PROJECT_TARGET_PREFIX.length)
    : undefined;
  const task = projectId === undefined
    ? store.overview?.tasks.find((candidate) => candidate.id === taskId)
    : undefined;
  const project = projectId === undefined
    ? undefined
    : store.overview?.projects.find((candidate) => candidate.id === projectId);
  const [capabilities, setCapabilities] = useState<readonly AgentCapabilityDto[] | undefined>(undefined);
  const [selection, setSelection] = useState<AgentLaunchSelection | undefined>(undefined);
  const [inspection, setInspection] = useState<AgentLaunchInspection | undefined>(undefined);
  const [prompt, setPrompt] = useState("");
  const [editing, setEditing] = useState(false);
  const starting = useRef(false);
  const [stage, setStage] = useState<"reading" | "choosing" | "previewing" | "launching">("reading");
  const [launchElapsedSeconds, setLaunchElapsedSeconds] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (routeConnectionId !== undefined && connections.selectedId !== routeConnectionId) {
      connections.select(routeConnectionId);
    }
  }, [connections.select, connections.selectedId, routeConnectionId]);

  const connectionId = selected?.id;

  useEffect(() => {
    if (connectionId === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await runtime.agentLaunch.capabilities(connectionId);
        if (cancelled) return;
        const saved = await agentLaunchPreferences.read().catch(() => undefined);
        if (cancelled) return;
        setCapabilities(list);
        setSelection(restoreLaunchSelection(saved, list));
        setStage("choosing");
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStage("choosing");
      }
    })();
    return () => { cancelled = true; };
  }, [connectionId, runtime]);

  useEffect(() => {
    if (stage !== "launching") {
      setLaunchElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setLaunchElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    }, 500);
    return () => clearInterval(timer);
  }, [stage]);

  const blocked = useMemo(() => (task ? launchBlockedReason(task) : undefined), [task]);
  const options = useMemo(() => launchAgentOptions(capabilities ?? []), [capabilities]);
  const chosenOption = options.find((option) => option.agentId === selection?.agentId);
  const chosenAvailable = selection !== undefined
    && options.some((option) => option.agentId === selection.agentId && option.available);

  /// Any change to the four choices invalidates the reserved ticket: a preview
  /// describes one exact launch, and reusing it after a change would launch
  /// something the user never saw.
  const change = useCallback((next: Partial<AgentLaunchSelection>) => {
    setInspection(undefined);
    setError(undefined);
    setSelection((current) => {
      if (current === undefined || stage !== "choosing") return current;
      if (next.agentId !== undefined && next.agentId !== current.agentId) {
        return defaultLaunchSelection(next.agentId);
      }
      const merged = { ...current, ...next };
      return { ...merged, model: coerceModel(merged.agentId, merged.model, capabilities ?? []) };
    });
  }, [capabilities, stage]);

  const inspect = useCallback(async () => {
    if (connectionId === undefined || selection === undefined) return undefined;
    if (project !== undefined) {
      return await runtime.agentLaunch.previewProject(connectionId, project, selection, prompt);
    }
    if (task !== undefined) {
      return await runtime.agentLaunch.preview(connectionId, task.id, selection, prompt);
    }
    return undefined;
  }, [connectionId, project, prompt, runtime, selection, task]);

  const preview = useCallback(async () => {
    if (stage !== "choosing" || starting.current) return;
    Keyboard.dismiss();
    setStage("previewing");
    setError(undefined);
    try {
      setInspection(await inspect());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStage("choosing");
    }
  }, [inspect, stage]);

  const launch = useCallback(async () => {
    if (connectionId === undefined || selection === undefined || stage !== "choosing"
      || blocked !== undefined || !chosenAvailable || starting.current) return;
    starting.current = true;
    Keyboard.dismiss();
    setStage("launching");
    setError(undefined);
    try {
      const reserved = inspection ?? await inspect();
      if (reserved === undefined) {
        starting.current = false;
        setStage("choosing");
        return;
      }
      const result = project !== undefined
        ? await runtime.agentLaunch.launchProject(
          connectionId,
          project,
          selection,
          reserved.launchTicket,
          prompt,
        )
        : task !== undefined
          ? await runtime.agentLaunch.launch(
            connectionId,
            task.id,
            { agentId: selection.agentId },
            reserved.launchTicket,
            prompt,
          )
          : undefined;
      if (result === undefined) {
        starting.current = false;
        setStage("choosing");
        return;
      }
      void agentLaunchPreferences.write(selection).catch(() => undefined);
      store.refresh();
      router.replace({
        pathname: "/session/[sessionId]",
        params: { sessionId: result.sessionId, connectionId },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      // The ticket is spent whether or not the launch completed, so the next
      // attempt has to reserve a fresh one rather than replay this manifest.
      setInspection(undefined);
      setStage("choosing");
      starting.current = false;
    }
  }, [blocked, chosenAvailable, connectionId, inspect, inspection, project, prompt, router, runtime, selection, stage, store, task]);

  const backLabel = project === undefined ? "Task" : "Project";
  const targetMissing = task === undefined && project === undefined;

  if (selectingConnection || targetMissing || selection === undefined || stage === "reading") {
    return (
      <Screen>
        <ScreenHeader back={backLabel} title="Start agent" />
        <View style={styles.centre}>
          {targetMissing && store.load === "ready"
            ? <Banner kind="warning" message={`This ${projectId === undefined ? "Task" : "Project"} is no longer in the connected Mac's projection.`} action="Back" onAction={() => router.back()} />
            : <ActivityIndicator color={color.accentStrong} />}
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenHeader back={backLabel} title="Start agent" />
      <KeyboardAvoidingView behavior={keyboardAvoidingBehavior} style={styles.body}>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.titleBlock}>
            <Text style={styles.title} numberOfLines={2}>{project?.name ?? task?.title}</Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              {project?.folder_path ?? task?.worktree?.path ?? task?.branch?.name ?? "no worktree"}
            </Text>
          </View>

        {blocked === undefined ? null : <Banner kind="danger" message={blocked} />}

        <View style={styles.section}>
          <SectionHeader label="First message · optional" />
          <TextInput
            accessibilityLabel="First message for the new agent"
            editable={stage === "choosing"}
            multiline
            maxLength={4096}
            value={prompt}
            onChangeText={(value) => { setPrompt(value); setInspection(undefined); setError(undefined); }}
            placeholder="What should this agent do?"
            placeholderTextColor={color.textMuted}
            style={styles.promptInput}
            textAlignVertical="top"
          />
          <Text style={styles.promptHint}>
            Your Mac sends this when the agent is ready.
          </Text>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Edit launch settings"
          accessibilityState={{ expanded: editing, disabled: stage !== "choosing" }}
          disabled={stage !== "choosing"}
          onPress={() => setEditing((value) => !value)}
          style={styles.settingsSummary}
        >
          <View style={styles.settingsSummaryCopy}>
            <Text style={styles.settingsTitle}>{chosenOption?.label ?? selection.agentId}</Text>
            <Text style={styles.settingsDetail}>
              {selection.model === "default" ? "Default model" : selection.model}
              {" · "}{permissionLabel(selection.agentId, selection.permission)}
              {" · "}{selection.reasoning === "default" ? "Default reasoning" : `${selection.reasoning} reasoning`}
            </Text>
          </View>
          <Text style={styles.settingsEdit}>{editing ? "Done" : "Edit"}</Text>
        </Pressable>

        {editing ? <>
        <Choice
          label="Agent"
          disabled={stage !== "choosing"}
          options={options.map((option) => ({
            value: option.agentId,
            label: `${option.label}${option.version === null ? "" : ` ${option.version}`}${option.integrationLevel === "launchOnly" ? " · launch only" : ""}`,
            disabled: !option.available,
          }))}
          value={selection.agentId}
          onChange={(value) => change({ agentId: value as AgentLaunchAgentId })}
        />
        <Choice
          label="Model"
          disabled={stage !== "choosing"}
          options={(chosenOption?.models ?? ["default"]).map((model) => ({
            value: model,
            label: modelLabel(selection.agentId, model),
            disabled: false,
          }))}
          value={selection.model}
          onChange={(value) => change({ model: value })}
        />
        <Choice
          label="Permission"
          disabled={stage !== "choosing"}
          options={(chosenOption?.permissions ?? ["default"]).map((permission) => ({
            value: permission,
            label: permissionLabel(selection.agentId, permission),
            disabled: false,
          }))}
          value={selection.permission}
          onChange={(value) => change({ permission: value as AgentLaunchPermission })}
        />
        <Choice
          label="Reasoning"
          disabled={stage !== "choosing"}
          options={(chosenOption?.reasoning ?? ["default"]).map((reasoning) => ({
            value: reasoning,
            label: reasoning,
            disabled: false,
          }))}
          value={selection.reasoning}
          onChange={(value) => change({ reasoning: value as AgentLaunchReasoning })}
        />

        <View style={styles.section}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Preview launch details"
            disabled={blocked !== undefined || !chosenAvailable || stage !== "choosing"}
            onPress={() => void preview()}
          >
            <Text style={styles.settingsEdit}>{stage === "previewing" ? "Loading details…" : "Preview launch details"}</Text>
          </Pressable>
          {inspection === undefined ? null : (
            <Card>
              <ManifestLine label="program" value={inspection.program} />
              <CardDivider />
              <ManifestLine label="cwd" value={inspection.cwd} />
              <CardDivider />
              <ManifestLine label="model" value={inspection.model ?? "—"} />
              <CardDivider />
              <ManifestLine label="permission" value={inspection.permission ?? "—"} />
              <CardDivider />
              <ManifestLine label="reasoning" value={inspection.reasoning ?? "—"} />
              {inspection.args.length === 0 ? null : (
                <>
                  <CardDivider />
                  <ManifestLine label="arguments" value={inspection.args.join(" ")} />
                </>
              )}
            </Card>
          )}
        </View>
        </> : null}

        {error === undefined ? null : <Banner kind="warning" message={error} />}

        {stage !== "launching" ? null : (
          <View style={styles.launchStatus} accessibilityLiveRegion="polite">
            <ActivityIndicator color={color.accentStrong} />
            <View style={styles.launchStatusCopy}>
              <Text style={styles.launchStatusTitle}>Starting agent · {launchElapsedSeconds}s</Text>
              <Text style={styles.launchStatusBody}>
                Your Mac is opening the agent{prompt.trim() ? " and preparing your first message" : ""}.
              </Text>
            </View>
          </View>
        )}

        <View style={styles.actions}>
          <PrimaryButton
            label={stage === "launching" ? "Starting…" : prompt.trim() ? "Start and send" : "Start agent"}
            disabled={blocked !== undefined || !chosenAvailable || stage !== "choosing"}
            busy={stage === "launching"}
            onPress={() => void launch()}
          />
        </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function Choice({ label, options, value, disabled = false, onChange }: {
  label: string;
  options: readonly { value: string; label: string; disabled: boolean }[];
  value: string;
  disabled?: boolean | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <View style={styles.section}>
      <SectionHeader label={label} />
      <View style={styles.choiceRow}>
        {options.map((option) => {
          const selected = option.value === value;
          const optionDisabled = disabled || option.disabled;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled: optionDisabled }}
              accessibilityLabel={`${label} ${option.label}${option.disabled ? ", unavailable" : ""}`}
              disabled={optionDisabled}
              onPress={() => onChange(option.value)}
              style={[
                styles.choice,
                selected ? styles.choiceSelected : null,
                optionDisabled ? styles.choiceDisabled : null,
              ]}
            >
              <Text style={[
                styles.choiceLabel,
                selected ? styles.choiceLabelSelected : null,
                optionDisabled ? styles.choiceLabelDisabled : null,
              ]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function ManifestLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.manifestLine}>
      <Text style={styles.manifestLabel}>{label}</Text>
      <Text style={styles.manifestValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  centre: { flex: 1, justifyContent: "center", padding: space.screen },
  body: { flex: 1 },
  content: { gap: space.lg, padding: space.screen, paddingBottom: space.xl },
  titleBlock: { gap: space.xs },
  title: { color: color.text, fontSize: 18, fontWeight: "700", lineHeight: 24 },
  subtitle: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 11 },
  section: { gap: 6 },
  settingsSummary: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, borderRadius: radius.card, backgroundColor: color.bgRaised },
  settingsSummaryCopy: { flex: 1, gap: 4 },
  settingsTitle: { ...text.body, color: color.text, fontWeight: "700" },
  settingsDetail: { ...text.muted, color: color.textSecondary },
  settingsEdit: { ...text.body, color: color.accentStrong, fontWeight: "600", paddingVertical: space.sm },
  choiceRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  choice: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: color.bgRaised,
  },
  choiceSelected: { backgroundColor: color.accent },
  choiceDisabled: { backgroundColor: color.bgApp, opacity: 0.55 },
  choiceLabel: { ...text.body, color: color.textSecondary, fontWeight: "600" },
  choiceLabelSelected: { color: color.onAccent },
  choiceLabelDisabled: { color: color.textMuted },
  manifestLine: { paddingHorizontal: space.md, paddingVertical: space.sm, gap: 2 },
  manifestLabel: {
    color: color.textMuted,
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  manifestValue: { color: color.text, fontFamily: fontFamily.mono, fontSize: 12 },
  promptInput: {
    minHeight: 108,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderRadius: radius.card,
    backgroundColor: color.bgRaised,
    color: color.text,
    fontSize: 15,
    lineHeight: 21,
  },
  promptHint: { ...text.muted, paddingHorizontal: 2 },
  launchStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.md,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.accent,
    backgroundColor: color.accentWash,
  },
  launchStatusCopy: { flex: 1, gap: 3 },
  launchStatusTitle: { color: color.accentStrong, fontFamily: fontFamily.mono, fontSize: 12, fontWeight: "800" },
  launchStatusBody: { color: color.textSecondary, fontSize: 12, lineHeight: 17 },
  actions: { paddingTop: space.xs },
});
