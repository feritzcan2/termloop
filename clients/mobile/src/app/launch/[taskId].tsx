import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import type { AgentCapabilityDto } from "@termloop/contract/current";

import type {
  AgentLaunchAgentId,
  AgentLaunchInspection,
  AgentLaunchPermission,
  AgentLaunchReasoning,
  AgentLaunchSelection,
} from "@/application/ports";
import { Banner, Card, CardDivider, PrimaryButton, SectionHeader, UnavailableNote } from "@/components/primitives";
import { Screen, ScreenHeader } from "@/components/screen";
import { useMobileRuntime } from "@/composition/runtime-context";
import { useConnections } from "@/features/connection/connection-store";
import { useOverview } from "@/features/overview/overview-store";
import { retainPendingSessionInput } from "@/features/terminal/pending-session-input";
import {
  coerceModel,
  defaultLaunchSelection,
  firstAvailableAgent,
  launchAgentOptions,
  launchBlockedReason,
  modelLabel,
  permissionLabel,
} from "@/presentation/agent-launch-presentation";
import { color, radius, space } from "@/theme/tokens";
import { fontFamily, text } from "@/theme/typography";

const PROJECT_TARGET_PREFIX = "project:";

/// Starting a Task Agent or an unassigned Project Agent from the phone, with
/// the provider, model, permission, and reasoning stated rather than assumed.
///
/// The launch is the Mac's, not the phone's: this screen asks for a preview,
/// renders the manifest the Mac says it would run, and only then spends the
/// ticket. It never assembles argv, never fills in a default the Mac did not
/// state, and shows redacted arguments exactly as redacted.
export default function LaunchRoute() {
  const { taskId } = useLocalSearchParams<{ taskId: string }>();
  const router = useRouter();
  const runtime = useMobileRuntime();
  const { selected } = useConnections();
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
  const [stage, setStage] = useState<"reading" | "choosing" | "previewing" | "launching">("reading");
  const [error, setError] = useState<string | undefined>(undefined);

  const connectionId = selected?.id;

  useEffect(() => {
    if (connectionId === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await runtime.agentLaunch.capabilities(connectionId);
        if (cancelled) return;
        setCapabilities(list);
        setSelection(defaultLaunchSelection(firstAvailableAgent(list) ?? "claude"));
        setStage("choosing");
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStage("choosing");
      }
    })();
    return () => { cancelled = true; };
  }, [connectionId, runtime]);

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
      if (current === undefined) return current;
      if (next.agentId !== undefined && next.agentId !== current.agentId) {
        return defaultLaunchSelection(next.agentId);
      }
      const merged = { ...current, ...next };
      return { ...merged, model: coerceModel(merged.agentId, merged.model, capabilities ?? []) };
    });
  }, [capabilities]);

  const preview = useCallback(async () => {
    if (connectionId === undefined || selection === undefined) return;
    setStage("previewing");
    setError(undefined);
    try {
      if (project !== undefined) {
        setInspection(await runtime.agentLaunch.previewProject(connectionId, project, selection));
      } else if (task !== undefined) {
        setInspection(await runtime.agentLaunch.preview(connectionId, task.id, selection));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStage("choosing");
    }
  }, [connectionId, project, runtime, selection, task]);

  const launch = useCallback(async () => {
    if (connectionId === undefined || selection === undefined || inspection === undefined) return;
    setStage("launching");
    setError(undefined);
    try {
      const result = project !== undefined
        ? await runtime.agentLaunch.launchProject(
          connectionId,
          project,
          { agentId: selection.agentId },
          inspection.launchTicket,
          prompt,
        )
        : task !== undefined
          ? await runtime.agentLaunch.launch(
            connectionId,
            task.id,
            { agentId: selection.agentId },
            inspection.launchTicket,
            prompt,
          )
          : undefined;
      if (result === undefined) return;
      if (result.promptSubmitted === false) {
        retainPendingSessionInput(connectionId, result.sessionId, result.runtimeEpoch, prompt);
      }
      store.refresh();
      router.replace({ pathname: "/session/[sessionId]", params: { sessionId: result.sessionId } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      // The ticket is spent whether or not the launch completed, so the next
      // attempt has to reserve a fresh one rather than replay this manifest.
      setInspection(undefined);
      setStage("choosing");
    }
  }, [connectionId, inspection, project, router, runtime, selection, store, task]);

  const backLabel = project === undefined ? "Task" : "Project";
  const targetMissing = task === undefined && project === undefined;

  if (targetMissing || selection === undefined || stage === "reading") {
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
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.titleBlock}>
          <Text style={styles.title} numberOfLines={2}>{project?.name ?? task?.title}</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {project?.folder_path ?? task?.worktree?.path ?? task?.branch?.name ?? "no worktree"}
          </Text>
        </View>

        {blocked === undefined ? null : <Banner kind="danger" message={blocked} />}

        <Choice
          label="Agent"
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
          options={(chosenOption?.reasoning ?? ["default"]).map((reasoning) => ({
            value: reasoning,
            label: reasoning,
            disabled: false,
          }))}
          value={selection.reasoning}
          onChange={(value) => change({ reasoning: value as AgentLaunchReasoning })}
        />

        <View style={styles.section}>
          <SectionHeader label="First message · optional" />
          <TextInput
            accessibilityLabel="First message for the new agent"
            multiline
            maxLength={4096}
            value={prompt}
            onChangeText={setPrompt}
            placeholder="What should this agent do?"
            placeholderTextColor={color.textMuted}
            style={styles.promptInput}
            textAlignVertical="top"
          />
          <Text style={styles.promptHint}>
            Sent after the agent starts. If delivery fails, it stays ready in the Session message box.
          </Text>
        </View>

        <View style={styles.section}>
          <SectionHeader label="What your Mac will run" />
          {inspection === undefined ? (
            <UnavailableNote>
              Nothing is reserved yet. Ask your Mac to describe this launch before it runs.
            </UnavailableNote>
          ) : (
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

        {error === undefined ? null : <Banner kind="warning" message={error} />}

        <View style={styles.actions}>
          {inspection === undefined ? (
            <PrimaryButton
              label={stage === "previewing" ? "Describing…" : "Describe this launch"}
              disabled={blocked !== undefined || !chosenAvailable || stage !== "choosing"}
              onPress={() => void preview()}
            />
          ) : (
            <PrimaryButton
              label={stage === "launching" ? "Starting…" : prompt.trim() ? "Start and send" : "Start this agent"}
              disabled={stage === "launching"}
              onPress={() => void launch()}
            />
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

function Choice({ label, options, value, onChange }: {
  label: string;
  options: readonly { value: string; label: string; disabled: boolean }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <View style={styles.section}>
      <SectionHeader label={label} />
      <View style={styles.choiceRow}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled: option.disabled }}
              accessibilityLabel={`${label} ${option.label}${option.disabled ? ", unavailable" : ""}`}
              disabled={option.disabled}
              onPress={() => onChange(option.value)}
              style={[
                styles.choice,
                selected ? styles.choiceSelected : null,
                option.disabled ? styles.choiceDisabled : null,
              ]}
            >
              <Text style={[
                styles.choiceLabel,
                selected ? styles.choiceLabelSelected : null,
                option.disabled ? styles.choiceLabelDisabled : null,
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
  content: { gap: space.lg, padding: space.screen, paddingBottom: space.xl },
  titleBlock: { gap: space.xs },
  title: { color: color.text, fontSize: 18, fontWeight: "700", lineHeight: 24 },
  subtitle: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 11 },
  section: { gap: 6 },
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
  actions: { paddingTop: space.xs },
});
