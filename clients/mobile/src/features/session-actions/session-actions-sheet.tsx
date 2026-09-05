import type {
  AgentCapabilityDto,
  SessionDto,
  SessionRelocationPreviewDto,
  TaskDto,
} from "@termloop/contract/current";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useMobileRuntime } from "@/composition/runtime-context";
import { useConnections } from "@/features/connection/connection-store";
import { useOverview } from "@/features/overview/overview-store";
import { executeSessionRecovery } from "@/features/session-actions/session-recovery";
import { clipboardBridge } from "@/platform/clipboard";
import { keyboardAvoidingBehavior } from "@/platform/presentation";
import { basename, sessionLabel } from "@/presentation/dto-readers";
import {
  agentForkErrorMessage,
  relocationBlockerMessage,
  relocationTargetLabel,
  relocationWarningMessage,
  sessionActionPresentation,
} from "@/presentation/session-actions-presentation";
import { color, geometry, radius, space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

type SheetPage = "root" | "agents" | "tasks" | "rename" | "relocation";
type RelocationTarget =
  | { kind: "task"; task: TaskDto }
  | { kind: "project"; projectId: string; projectName: string };

export interface SessionActionsSheetProps {
  session: SessionDto | undefined;
  visible: boolean;
  onClose(): void;
  onOpenSession?: ((sessionId: string) => void) | undefined;
  onOpenTask?: ((taskId: string) => void) | undefined;
  onOpenChanges?: ((taskId: string) => void) | undefined;
  onDismissed?: (() => void) | undefined;
}

let operationSequence = 0;

function nextOperationId(): string {
  operationSequence += 1;
  return `mobile_${Date.now().toString(36)}_${operationSequence.toString(36)}`;
}

/// Mobile counterpart of the desktop Session context menu. Long press opens a
/// thumb-sized sheet; nested desktop submenus become explicit sheet pages so the
/// complete action and its target remain readable on a phone.
export function SessionActionsSheet(props: SessionActionsSheetProps) {
  const { session, visible, onClose } = props;
  const runtime = useMobileRuntime();
  const connections = useConnections();
  const overviewStore = useOverview();
  const overview = overviewStore.overview;
  const [page, setPage] = useState<SheetPage>("root");
  const [capabilities, setCapabilities] = useState<readonly AgentCapabilityDto[]>();
  const [capabilityError, setCapabilityError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [renameDraft, setRenameDraft] = useState("");
  const [mode, setMode] = useState<"resume" | "fresh">("resume");
  const [relocationTarget, setRelocationTarget] = useState<RelocationTarget>();
  const [relocation, setRelocation] = useState<SessionRelocationPreviewDto>();

  useEffect(() => {
    if (!visible || !session) return;
    setPage("root");
    setBusy(undefined);
    setError(undefined);
    setCapabilityError(undefined);
    setRenameDraft(session.name ?? "");
    setMode(session.process.agent_id === "claude" && session.lifecycle_state === "resumeFailed"
      ? "fresh"
      : "resume");
    setRelocationTarget(undefined);
    setRelocation(undefined);
    if (session.kind !== "Agent" || connections.selectedId === undefined) {
      setCapabilities([]);
      return;
    }
    let active = true;
    setCapabilities(undefined);
    void runtime.agentLaunch.capabilities(connections.selectedId).then(
      (value) => { if (active) setCapabilities(value); },
      (cause: unknown) => {
        if (!active) return;
        setCapabilities([]);
        setCapabilityError(errorMessage(cause));
      },
    );
    return () => { active = false; };
  }, [connections.selectedId, runtime, session?.id, visible]);

  const presentation = useMemo(() => (
    session && overview
      ? sessionActionPresentation(session, overview.sessions, overview.tasks, capabilities ?? [])
      : undefined
  ), [capabilities, overview, session]);
  const project = overview?.projects.find((candidate) => candidate.id === session?.project_id);
  const connectionId = connections.selectedId;

  if (!session || !overview || !presentation || !connectionId) return null;

  const finish = (callback?: (() => void) | undefined) => {
    overviewStore.refresh();
    onClose();
    callback?.();
  };
  const run = async <Result,>(
    label: string,
    action: () => Promise<Result>,
    callback?: ((result: Result) => void) | undefined,
    describeError: (cause: unknown) => string = errorMessage,
  ) => {
    if (busy !== undefined) return;
    setBusy(label);
    setError(undefined);
    try {
      const result = await action();
      finish(() => callback?.(result));
    } catch (cause: unknown) {
      setError(describeError(cause));
    } finally {
      setBusy(undefined);
    }
  };
  const previewTaskRelocation = async (task: TaskDto) => {
    if (busy !== undefined) return;
    setPage("relocation");
    setRelocationTarget({ kind: "task", task });
    setRelocation(undefined);
    setBusy("Checking move");
    setError(undefined);
    try {
      setRelocation(await runtime.sessionActions.previewRelocateToTask(
        connectionId,
        session.id,
        task.id,
        mode,
      ));
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    } finally {
      setBusy(undefined);
    }
  };
  const previewProjectRelocation = async () => {
    if (!project || busy !== undefined) return;
    setPage("relocation");
    setRelocationTarget({ kind: "project", projectId: project.id, projectName: project.name });
    setRelocation(undefined);
    setBusy("Checking move");
    setError(undefined);
    try {
      setRelocation(await runtime.sessionActions.previewRelocateToProject(
        connectionId,
        session.id,
        project.id,
      ));
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    } finally {
      setBusy(undefined);
    }
  };
  const confirmRelocation = async () => {
    const ticket = relocation?.relocation_ticket;
    if (!relocationTarget || !relocation?.can_relocate || !ticket || !relocation.manifest) return;
    await run("Moving Agent", async () => {
      if (relocationTarget.kind === "task") {
        await runtime.sessionActions.relocateToTask(
          connectionId,
          session.id,
          relocationTarget.task.id,
          nextOperationId(),
          ticket,
        );
      } else {
        await runtime.sessionActions.relocateToProject(
          connectionId,
          session.id,
          relocationTarget.projectId,
          nextOperationId(),
          ticket,
        );
      }
    }, () => props.onOpenSession?.(session.id));
  };
  const confirmDismissal = () => {
    const dismissal = presentation.dismissal;
    if (!dismissal) return;
    Alert.alert(dismissal.label, dismissal.detail, [
      { text: "Cancel", style: "cancel" },
      {
        text: dismissal.label === "Remove Session" ? "Remove" : "Close",
        style: "destructive",
        onPress: () => void run(dismissal.label, async () => {
          if (dismissal.command === "terminate") {
            await runtime.sessionActions.terminate(connectionId, session.id);
          }
          await runtime.sessionActions.close(connectionId, session.id);
        }, props.onDismissed),
      },
    ]);
  };
  const recoverAgent = () => {
    const recovery = presentation.recovery;
    if (!recovery) return;
    const execute = () => void run(
      `${recovery.label}ing Agent`,
      () => executeSessionRecovery(runtime.sessionActions, connectionId, session.id, recovery),
      () => props.onOpenSession?.(session.id),
    );
    if (recovery.kind === "retry") {
      execute();
      return;
    }
    Alert.alert(
      "Fix provider history and retry?",
      "TermLoop will retain an exact backup, repair recognized restart damage, and retry this conversation.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Fix",
          onPress: execute,
        },
      ],
    );
  };
  const back = () => {
    setError(undefined);
    setRelocation(undefined);
    setRelocationTarget(undefined);
    setPage(page === "relocation" && relocationTarget?.kind === "task" ? "tasks" : "root");
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={page === "root" ? onClose : back}
    >
      <View style={styles.layer}>
        <Pressable
          style={styles.backdrop}
          accessibilityRole="button"
          accessibilityLabel="Close Session actions"
          onPress={onClose}
        />
        <KeyboardAvoidingView behavior={keyboardAvoidingBehavior} style={styles.keyboardAvoiding}>
          <View style={styles.sheet} accessibilityViewIsModal>
            <View style={styles.handle} />
            <View style={styles.header}>
              {page === "root" ? <View style={styles.headerButton} /> : (
                <Pressable
                  onPress={back}
                  disabled={busy !== undefined}
                  accessibilityRole="button"
                  accessibilityLabel="Back to Session actions"
                  style={styles.headerButton}
                >
                  <Text style={styles.headerGlyph}>‹</Text>
                </Pressable>
              )}
              <View style={styles.headerCopy}>
                <Text style={styles.title} numberOfLines={1}>{pageTitle(page, session, relocationTarget)}</Text>
                <Text style={styles.subtitle} numberOfLines={1}>{pageSubtitle(page, session, relocationTarget)}</Text>
              </View>
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Close Session actions"
                style={styles.headerButton}
              >
                <Text style={styles.closeGlyph}>×</Text>
              </Pressable>
            </View>

            {error === undefined ? null : <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
            {busy === undefined ? null : (
              <View style={styles.busy} accessibilityRole="progressbar">
                <ActivityIndicator color={color.accentStrong} />
                <Text style={styles.busyLabel}>{busy}…</Text>
              </View>
            )}

            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.content}
              keyboardShouldPersistTaps="handled"
            >
              {page === "root" ? (
                <>
                  {props.onOpenSession ? <ActionRow
                    glyph="↗"
                    label={`Open ${session.kind === "Agent" ? "Agent" : "Session"}`}
                    detail="Show its terminal"
                    disabled={busy !== undefined || session.lifecycle_state !== "running"}
                    onPress={() => { onClose(); props.onOpenSession?.(session.id); }}
                  /> : null}
                  {presentation.attachedTask && props.onOpenTask ? <ActionRow
                    glyph="□"
                    label="Open Task"
                    detail={presentation.attachedTask.title}
                    disabled={busy !== undefined}
                    onPress={() => { onClose(); props.onOpenTask?.(presentation.attachedTask!.id); }}
                  /> : null}
                  {presentation.attachedTask?.worktree && props.onOpenChanges ? <ActionRow
                    glyph="±"
                    label="Changes"
                    detail="Review this Agent's worktree"
                    disabled={busy !== undefined}
                    onPress={() => { onClose(); props.onOpenChanges?.(presentation.attachedTask!.id); }}
                  /> : null}
                  {props.onOpenSession || presentation.attachedTask ? <Divider /> : null}
                  {presentation.recovery ? <ActionRow
                    glyph="↻"
                    label={presentation.recovery.label}
                    detail={presentation.recovery.detail}
                    disabled={busy !== undefined}
                    onPress={recoverAgent}
                  /> : null}
                  {presentation.canRefresh ? <ActionRow
                    glyph="↻"
                    label="Refresh agent display"
                    detail="Restart the provider TUI and continue the same conversation"
                    disabled={busy !== undefined}
                    onPress={() => void run("Refreshing Agent", async () => {
                      await runtime.sessionActions.restart(connectionId, session.id);
                    }, () => props.onOpenSession?.(session.id))}
                  /> : null}
                  {presentation.canFork ? <ActionRow
                    glyph="⑂"
                    label="Fork conversation"
                    detail="Start a new Agent from this conversation"
                    disabled={busy !== undefined}
                    onPress={() => void run(
                      "Forking conversation",
                      () => runtime.sessionActions.fork(connectionId, session.id),
                      (forked) => props.onOpenSession?.(forked.id),
                      agentForkErrorMessage,
                    )}
                  /> : null}
                  {presentation.coordination ? <ActionRow
                    glyph="◎"
                    label="Agents"
                    detail="Ask a helper or hand work to another Agent"
                    trailing="›"
                    disabled={busy !== undefined}
                    onPress={() => { setError(undefined); setPage("agents"); }}
                  /> : null}
                  {session.kind === "Agent" && capabilities === undefined ? (
                    <Text style={styles.inlineNote}>Loading Agent actions…</Text>
                  ) : null}
                  {capabilityError === undefined ? null : (
                    <Text style={styles.inlineNote}>Agent coordination unavailable: {capabilityError}</Text>
                  )}
                  {presentation.taskRelocationTargets.length > 0 ? <ActionRow
                    glyph="□"
                    label="Continue in Task worktree…"
                    detail="Replace this process inside a Task worktree"
                    trailing="›"
                    disabled={busy !== undefined}
                    onPress={() => { setError(undefined); setPage("tasks"); }}
                  /> : null}
                  {presentation.canRelocateToProject ? <ActionRow
                    glyph="⌂"
                    label="Move to Project checkout…"
                    detail="Resume this conversation in the Project checkout"
                    disabled={busy !== undefined || project === undefined}
                    onPress={() => void previewProjectRelocation()}
                  /> : null}
                  <ActionRow
                    glyph="✎"
                    label="Rename…"
                    detail="Change the Session label"
                    disabled={busy !== undefined}
                    onPress={() => { setError(undefined); setPage("rename"); }}
                  />
                  {presentation.canCopyId ? <ActionRow
                    glyph="▣"
                    label="Copy Session ID"
                    detail={session.id}
                    disabled={busy !== undefined}
                    onPress={() => void run("Copying Session ID", async () => {
                      await clipboardBridge.copyText(session.id);
                    })}
                  /> : null}
                  <Divider />
                  {presentation.dismissal ? <ActionRow
                    glyph="×"
                    label={presentation.dismissal.label}
                    detail={presentation.dismissal.detail}
                    danger
                    disabled={busy !== undefined}
                    onPress={confirmDismissal}
                  /> : <ActionRow
                    glyph="×"
                    label="Close Session"
                    detail="Blocked while runtime ownership is uncertain"
                    danger
                    disabled
                    onPress={() => undefined}
                  />}
                </>
              ) : null}

              {page === "agents" && presentation.coordination ? (
                <>
                  <SectionLabel>Ask to</SectionLabel>
                  {presentation.coordination.askTargets.length > 0
                    ? presentation.coordination.askTargets.map((target) => <ActionRow
                      key={target.agentId}
                      glyph={target.agentId === "claude" ? "C" : "O"}
                      label={target.label}
                      detail="Start a tracked helper request"
                      disabled={busy !== undefined}
                      onPress={() => void run(`Asking ${target.label}`, async () => {
                        await runtime.sessionActions.askTo(connectionId, session.id, target.agentId);
                      }, () => props.onOpenSession?.(session.id))}
                    />)
                    : <EmptyMessage>No tracked-helper provider is available.</EmptyMessage>}
                  <Divider />
                  <SectionLabel>Handover to</SectionLabel>
                  {presentation.coordination.handoverTargets.length > 0
                    ? presentation.coordination.handoverTargets.map((target) => <ActionRow
                      key={target.id}
                      glyph={target.process.agent_id === "claude" ? "C" : "O"}
                      label={sessionLabel(target)}
                      detail={`${target.process.agent_id === "claude" ? "Claude" : "Codex"} · ${target.id.slice(0, 8)}`}
                      disabled={busy !== undefined}
                      onPress={() => void run(`Handing over to ${sessionLabel(target)}`, async () => {
                        await runtime.sessionActions.handoverTo(connectionId, session.id, target.id);
                      }, () => props.onOpenSession?.(session.id))}
                    />)
                    : <EmptyMessage>No other running Agent is available.</EmptyMessage>}
                </>
              ) : null}

              {page === "tasks" ? (
                <>
                  {session.process.agent_id === "claude" ? (
                    <View style={styles.modeGroup}>
                      <SectionLabel>Conversation</SectionLabel>
                      <View style={styles.modeButtons}>
                        <ModeButton label="Continue existing" selected={mode === "resume"} onPress={() => setMode("resume")} />
                        <ModeButton label="Start fresh" selected={mode === "fresh"} onPress={() => setMode("fresh")} />
                      </View>
                    </View>
                  ) : null}
                  <SectionLabel>Open Tasks</SectionLabel>
                  {presentation.taskRelocationTargets.map((task) => <ActionRow
                    key={task.id}
                    glyph="□"
                    label={task.title}
                    detail={task.worktree ? basename(task.worktree.path) : "Worktree required — create it on your Mac"}
                    disabled={busy !== undefined || task.worktree === null}
                    onPress={() => void previewTaskRelocation(task)}
                  />)}
                </>
              ) : null}

              {page === "rename" ? (
                <View style={styles.form}>
                  <Text style={styles.fieldLabel}>Session name</Text>
                  <TextInput
                    autoFocus
                    value={renameDraft}
                    onChangeText={setRenameDraft}
                    maxLength={80}
                    editable={busy === undefined}
                    placeholder={session.kind === "Agent" ? "Agent name" : "Session name"}
                    placeholderTextColor={color.textMuted}
                    accessibilityLabel="Session name"
                    style={styles.input}
                  />
                  <Text style={styles.fieldHelp}>Leave empty to use the generated label.</Text>
                  <PrimaryAction
                    label={busy === undefined ? "Save name" : "Saving…"}
                    disabled={busy !== undefined}
                    onPress={() => void run("Saving name", async () => {
                      const name = renameDraft.trim();
                      await runtime.sessionActions.rename(connectionId, session.id, name.length > 0 ? name : null);
                    })}
                  />
                </View>
              ) : null}

              {page === "relocation" && relocationTarget ? (
                <View style={styles.relocationBody}>
                  <Text style={styles.relocationLead}>
                    The Agent will stop here and continue in {relocationTarget.kind === "task" ? "the Task worktree" : "the Project checkout"}.
                  </Text>
                  {relocation === undefined && busy === undefined ? (
                    <PrimaryAction
                      label="Check again"
                      onPress={() => void (relocationTarget.kind === "task"
                        ? previewTaskRelocation(relocationTarget.task)
                        : previewProjectRelocation())}
                    />
                  ) : null}
                  {relocation ? (
                    <>
                      <View style={styles.previewFacts}>
                        <Fact label="From" value={basename(relocation.source_cwd)} />
                        <Fact label="To" value={relocation.target_cwd ? basename(relocation.target_cwd) : "Unavailable"} />
                        <Fact label="Conversation" value={relocation.mode === "fresh" ? "Start fresh" : "Continue existing"} />
                      </View>
                      {relocation.warnings.map((warning) => (
                        <Text key={warning} style={styles.warning}>• {relocationWarningMessage(warning)}</Text>
                      ))}
                      {relocation.blockers.map((blocker) => (
                        <Text key={blocker} style={styles.blocker}>• {relocationBlockerMessage(blocker)}</Text>
                      ))}
                      <PrimaryAction
                        label={busy === undefined ? "Move Agent" : "Moving…"}
                        disabled={busy !== undefined || !relocation.can_relocate
                          || relocation.relocation_ticket === null || relocation.manifest === null}
                        onPress={() => void confirmRelocation()}
                      />
                    </>
                  ) : null}
                </View>
              ) : null}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function pageTitle(page: SheetPage, session: SessionDto, target: RelocationTarget | undefined): string {
  if (page === "agents") return "Agents";
  if (page === "tasks") return "Continue in Task";
  if (page === "rename") return "Rename Session";
  if (page === "relocation" && target) {
    return `Move to ${relocationTargetLabel(
      target.kind === "task" ? target.task : null,
      target.kind === "project" ? target.projectName : "Project",
    )}`;
  }
  return sessionLabel(session);
}

function pageSubtitle(page: SheetPage, session: SessionDto, target: RelocationTarget | undefined): string {
  if (page === "root") return session.process.cwd;
  if (page === "agents") return "Coordinate this conversation";
  if (page === "tasks") return "Choose an open Task worktree";
  if (page === "rename") return session.id;
  return target?.kind === "task" ? target.task.worktree?.path ?? "Worktree unavailable" : "Review before moving";
}

function ActionRow({ glyph, label, detail, trailing, danger = false, disabled = false, onPress }: {
  glyph: string;
  label: string;
  detail?: string | undefined;
  trailing?: string | undefined;
  danger?: boolean | undefined;
  disabled?: boolean | undefined;
  onPress(): void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.action,
        pressed && !disabled ? styles.actionPressed : null,
        disabled ? styles.actionDisabled : null,
      ]}
    >
      <Text style={[styles.actionGlyph, danger ? styles.danger : null]}>{glyph}</Text>
      <View style={styles.actionCopy}>
        <Text style={[styles.actionLabel, danger ? styles.danger : null]}>{label}</Text>
        {detail === undefined ? null : <Text style={styles.actionDetail} numberOfLines={2}>{detail}</Text>}
      </View>
      {trailing === undefined ? null : <Text style={styles.actionTrailing}>{trailing}</Text>}
    </Pressable>
  );
}

function Divider() {
  return <View style={styles.divider} />;
}

function SectionLabel({ children }: { children: string }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

function EmptyMessage({ children }: { children: string }) {
  return <Text style={styles.empty}>{children}</Text>;
}

function ModeButton({ label, selected, onPress }: { label: string; selected: boolean; onPress(): void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={({ pressed }) => [styles.modeButton, selected ? styles.modeButtonSelected : null, pressed ? styles.actionPressed : null]}
    >
      <Text style={[styles.modeButtonLabel, selected ? styles.modeButtonLabelSelected : null]}>{label}</Text>
    </Pressable>
  );
}

function PrimaryAction({ label, disabled = false, onPress }: { label: string; disabled?: boolean; onPress(): void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.primary, pressed && !disabled ? styles.primaryPressed : null, disabled ? styles.primaryDisabled : null]}
    >
      <Text style={styles.primaryLabel}>{label}</Text>
    </Pressable>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue} numberOfLines={2}>{value}</Text>
    </View>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "This Session action could not be completed.";
}

const styles = StyleSheet.create({
  layer: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: color.scrim },
  keyboardAvoiding: { maxHeight: "88%", justifyContent: "flex-end" },
  sheet: {
    maxHeight: "100%",
    paddingTop: space.sm,
    paddingBottom: space.xl,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    backgroundColor: color.bgRaised,
  },
  handle: {
    alignSelf: "center",
    width: geometry.sheetHandle.width,
    height: geometry.sheetHandle.height,
    marginBottom: space.xs,
    borderRadius: radius.pill,
    backgroundColor: color.borderStrong,
  },
  header: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.sm,
  },
  headerButton: { width: geometry.touchTarget, height: geometry.touchTarget, alignItems: "center", justifyContent: "center" },
  headerGlyph: { color: color.textSecondary, fontSize: 34, lineHeight: 36 },
  closeGlyph: { color: color.textSecondary, fontSize: 25, lineHeight: 28 },
  headerCopy: { flex: 1, minWidth: 0, gap: 3, alignItems: "center" },
  title: { color: color.text, fontSize: 16, fontWeight: "700" },
  subtitle: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 10 },
  scroll: { flexGrow: 0 },
  content: { paddingHorizontal: space.sm, paddingBottom: space.md },
  action: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: 9,
    borderRadius: radius.control,
  },
  actionPressed: { backgroundColor: color.accentWash },
  actionDisabled: { opacity: 0.42 },
  actionGlyph: {
    width: 24,
    color: color.textSecondary,
    fontFamily: fontFamily.mono,
    fontSize: 16,
    textAlign: "center",
  },
  actionCopy: { flex: 1, minWidth: 0, gap: 2 },
  actionLabel: { color: color.text, fontSize: 14, fontWeight: "600" },
  actionDetail: { color: color.textMuted, fontSize: 11, lineHeight: 15 },
  actionTrailing: { color: color.textMuted, fontSize: 20 },
  danger: { color: color.danger },
  divider: { height: StyleSheet.hairlineWidth, marginHorizontal: space.md, marginVertical: 5, backgroundColor: color.rule },
  sectionLabel: {
    marginTop: space.sm,
    marginBottom: space.xs,
    paddingHorizontal: space.md,
    color: color.textMuted,
    fontFamily: fontFamily.mono,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.7,
    textTransform: "uppercase",
  },
  empty: { paddingHorizontal: space.md, paddingVertical: space.lg, color: color.textMuted, fontSize: 12 },
  inlineNote: { paddingHorizontal: space.md, paddingVertical: space.sm, color: color.textMuted, fontSize: 11, lineHeight: 16 },
  busy: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, paddingVertical: space.sm },
  busyLabel: { color: color.textSecondary, fontFamily: fontFamily.mono, fontSize: 11 },
  error: {
    marginHorizontal: space.md,
    padding: space.md,
    borderRadius: radius.control,
    backgroundColor: color.dangerWash,
    color: color.danger,
    fontSize: 12,
    lineHeight: 17,
  },
  form: { gap: space.sm, padding: space.md },
  fieldLabel: { color: color.textSecondary, fontFamily: fontFamily.mono, fontSize: 11, fontWeight: "700" },
  input: {
    minHeight: geometry.touchTarget,
    paddingHorizontal: space.md,
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.control,
    backgroundColor: color.bgApp,
    color: color.text,
    fontSize: 15,
  },
  fieldHelp: { color: color.textMuted, fontSize: 11 },
  primary: {
    minHeight: geometry.touchTarget,
    alignItems: "center",
    justifyContent: "center",
    marginTop: space.sm,
    paddingHorizontal: space.lg,
    borderRadius: radius.control,
    backgroundColor: color.accent,
  },
  primaryPressed: { opacity: 0.78 },
  primaryDisabled: { opacity: 0.38 },
  primaryLabel: { color: color.onAccent, fontSize: 13, fontWeight: "800" },
  modeGroup: { gap: space.xs, marginBottom: space.md },
  modeButtons: { flexDirection: "row", gap: space.sm, paddingHorizontal: space.md },
  modeButton: {
    minHeight: geometry.touchTarget,
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.sm,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.control,
  },
  modeButtonSelected: { borderColor: color.accentStrong, backgroundColor: color.accentWash },
  modeButtonLabel: { color: color.textSecondary, fontSize: 12, fontWeight: "600" },
  modeButtonLabelSelected: { color: color.accentStrong },
  relocationBody: { gap: space.sm, padding: space.md },
  relocationLead: { color: color.textSecondary, fontSize: 13, lineHeight: 19 },
  previewFacts: { gap: space.xs, marginVertical: space.sm },
  fact: { flexDirection: "row", gap: space.md },
  factLabel: { width: 92, color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 11 },
  factValue: { flex: 1, color: color.text, fontSize: 12 },
  warning: { color: color.warning, fontSize: 12, lineHeight: 17 },
  blocker: { color: color.danger, fontSize: 12, lineHeight: 17 },
});
