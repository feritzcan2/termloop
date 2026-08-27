import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import type { PlaybookProjection } from "@/application/ports";
import { Banner, Card, SecondaryButton, UnavailableNote } from "@/components/primitives";
import { useMobileRuntime } from "@/composition/runtime-context";
import {
  pipelineProgressLabel,
  pipelineSegments,
  stepAnswerSource,
  stepEvidence,
  stepIsCheckable,
  stepPositionAction,
  stepRowSummary,
  stepTiming,
  taskPipelineView,
  terminusPositionAction,
  type TaskPipelineStep,
  type TaskPipelineView,
} from "@/presentation/playbook-presentation";
import { color, geometry, radius, space } from "@/theme/tokens";
import { fontFamily, text } from "@/theme/typography";

/// The Task's place on its Project's delivery pipeline, at phone scale.
///
/// The pipeline is one vertical rail. Every step is a compact row on that rail;
/// only the step the Task is standing at opens by itself and carries the one
/// primary action a phone is genuinely good for — running the standing check
/// right now. Everything else is a tap away: a row opens to its evidence and to
/// the positional correction, so a thumb cannot re-seat the Task by accident
/// while scrolling. Both actions are ordinary core commands with core's own
/// gates, not new client authority.
///
/// Editing the pipeline itself stays on the Mac. Building one from a phone goes
/// through the Steward conversation, which is why the empty state points there.
export function TaskPipeline({ connectionId, projectId, taskId, nowEpochMs, openSteward }: {
  connectionId: string;
  projectId: string;
  taskId: string;
  nowEpochMs: number;
  openSteward: () => void;
}) {
  const runtime = useMobileRuntime();
  const [projection, setProjection] = useState<PlaybookProjection | undefined>(undefined);
  const [load, setLoad] = useState<"loading" | "ready" | "failed">("loading");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [reloads, setReloads] = useState(0);
  /// undefined means "the standing step is the open one" — the default a fresh
  /// screen and every reload return to. The terminus opens under its own key.
  const [opened, setOpened] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setLoad((current) => (current === "ready" ? current : "loading"));
    void (async () => {
      try {
        const next = await runtime.playbook.read(connectionId, projectId);
        if (cancelled) return;
        setProjection(next);
        setLoad("ready");
        setError(undefined);
      } catch (cause) {
        if (cancelled) return;
        setLoad("failed");
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => { cancelled = true; };
  }, [connectionId, projectId, reloads, runtime]);

  const view = useMemo(
    () => taskPipelineView(
      projection?.playbook ?? null,
      projection?.runtime ?? null,
      projection?.routines ?? [],
      taskId,
    ),
    [projection, taskId],
  );

  const setPosition = useCallback(async (passedMilestoneCount: number) => {
    const current = projection;
    if (!current?.playbook) return;
    setBusy(`position-${passedMilestoneCount}`);
    try {
      await runtime.playbook.setTaskPosition(connectionId, {
        projectId,
        taskId,
        passedMilestoneCount,
        expectedPlaybookRevision: current.playbook.revision,
        expectedRevision: current.stateRevision,
      });
      setError(undefined);
      setOpened(undefined);
      setReloads((value) => value + 1);
    } catch (cause) {
      setError(positionFailure(cause));
      setReloads((value) => value + 1);
    } finally {
      setBusy(undefined);
    }
  }, [connectionId, projection, projectId, runtime, taskId]);

  const checkNow = useCallback(async (routineId: string) => {
    setBusy(`routine-${routineId}`);
    try {
      await runtime.playbook.runRoutineNow(connectionId, routineId);
      setError(undefined);
      setReloads((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  }, [connectionId, runtime]);

  if (load === "loading" && view === undefined) {
    return <View style={styles.centre}><ActivityIndicator color={color.accentStrong} /></View>;
  }

  if (load === "failed" && view === undefined) {
    return (
      <Banner
        kind="warning"
        message={error ?? "Your Mac did not answer with this Project's pipeline."}
        action="Retry"
        onAction={() => setReloads((value) => value + 1)}
      />
    );
  }

  if (view === undefined) {
    return (
      <View style={styles.emptyBlock}>
        <UnavailableNote>
          This Project is not walking a delivery pipeline, so nothing is tracking this Task
          from here to done.
        </UnavailableNote>
        <SecondaryButton label="Ask the Steward to build one" onPress={openSteward} />
      </View>
    );
  }

  /// "none" collapses even the standing step; undefined is the default where it
  /// opens itself. One row open at a time — a phone reads one question at once.
  const isOpen = (step: TaskPipelineStep) => opened === undefined
    ? step.standing === "waiting"
    : opened === step.milestone.id;
  const toggle = (step: TaskPipelineStep) => {
    setOpened(isOpen(step) ? (step.standing === "waiting" ? "none" : undefined) : step.milestone.id);
  };
  const terminusAction = terminusPositionAction(view);
  const terminusOpen = opened === "terminus";

  return (
    <View style={styles.block}>
      <View style={styles.progressRow}>
        <Text style={styles.pipelineName} numberOfLines={1}>{view.pipelineName}</Text>
        <Text style={styles.progressLabel}>{pipelineProgressLabel(view)}</Text>
      </View>
      <SegmentedMeter view={view} />
      {view.placement === "away" ? (
        <UnavailableNote>
          This Task has left the pipeline, so it is no longer asked about. Its recorded
          answers stay readable below.
        </UnavailableNote>
      ) : null}
      {error === undefined ? null : (
        <View style={styles.errorBlock}><Banner kind="warning" message={error} /></View>
      )}
      <Card>
        {view.steps.map((step, index) => (
          <PipelineStepRow
            key={step.milestone.id}
            step={step}
            view={view}
            first={index === 0}
            nowEpochMs={nowEpochMs}
            open={isOpen(step)}
            busy={busy}
            onToggle={() => toggle(step)}
            onSetPosition={(count) => void setPosition(count)}
            onCheckNow={() => void checkNow(step.milestone.routineId)}
          />
        ))}
        <Pressable
          accessibilityRole={terminusAction === undefined ? "text" : "button"}
          accessibilityState={{ expanded: terminusOpen }}
          disabled={terminusAction === undefined}
          onPress={() => setOpened((current) => (current === "terminus" ? undefined : "terminus"))}
          style={styles.row}
        >
          <Rail standing={view.placement === "done" ? "passed" : "ahead"} first={false} last human={false} />
          <View style={styles.rowBody}>
            <View style={styles.rowHead}>
              <Text style={[styles.rowTitle, view.placement === "done" ? styles.terminusDone : styles.rowTitleAhead]}>
                {view.placement === "done" ? "Done — every step cleared" : "Done"}
              </Text>
            </View>
            {terminusOpen && terminusAction !== undefined ? (
              <View style={styles.rowActions}>
                <QuietAction
                  label={busy === `position-${terminusAction.passedMilestoneCount}` ? "Moving…" : terminusAction.label}
                  disabled={busy !== undefined}
                  onPress={() => void setPosition(terminusAction.passedMilestoneCount)}
                />
              </View>
            ) : null}
          </View>
        </Pressable>
      </Card>
    </View>
  );
}

/// Position stated as countable blocks: one segment per step, filled when
/// cleared, lit at the standing step, hollow ahead.
function SegmentedMeter({ view }: { view: TaskPipelineView }) {
  return (
    <View style={styles.meter} accessibilityElementsHidden importantForAccessibility="no">
      {pipelineSegments(view).map((standing, index) => (
        <View
          // eslint-disable-next-line react/no-array-index-key -- segments are positional by definition
          key={index}
          style={[
            styles.meterSegment,
            standing === "passed" ? styles.meterPassed : null,
            standing === "waiting" ? styles.meterWaiting : null,
            view.placement === "away" ? styles.meterAway : null,
          ]}
        />
      ))}
    </View>
  );
}

/// The rail column: the line through the card and this row's node on it. The
/// line is what makes five rows read as one pipeline instead of a list.
function Rail({ standing, first, last, human }: {
  standing: TaskPipelineStep["standing"];
  first: boolean;
  last: boolean;
  human: boolean;
}) {
  return (
    <View style={styles.rail}>
      <View style={[styles.railLine, first ? styles.railLineHidden : null, standing === "passed" ? styles.railLinePassed : null]} />
      <View style={[
        styles.node,
        standing === "passed" ? styles.nodePassed : null,
        standing === "waiting" ? styles.nodeWaiting : null,
        standing === "ahead" ? styles.nodeAhead : null,
        human ? styles.nodeHuman : null,
      ]}>
        {standing === "passed" ? <Text style={styles.nodeCheck}>✓</Text> : null}
        {standing === "waiting" ? <View style={styles.nodeCore} /> : null}
      </View>
      <View style={[styles.railLine, last ? styles.railLineHidden : null]} />
    </View>
  );
}

function PipelineStepRow({ step, view, first, nowEpochMs, open, busy, onToggle, onSetPosition, onCheckNow }: {
  step: TaskPipelineStep;
  view: TaskPipelineView;
  first: boolean;
  nowEpochMs: number;
  open: boolean;
  busy: string | undefined;
  onToggle: () => void;
  onSetPosition: (passedMilestoneCount: number) => void;
  onCheckNow: () => void;
}) {
  const summary = stepRowSummary(step, nowEpochMs);
  const standing = step.standing === "waiting";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={`Step ${step.position}: ${step.milestone.title}`}
      onPress={onToggle}
      style={[styles.row, standing ? styles.rowStanding : null]}
    >
      <Rail standing={step.standing} first={first} last={false} human={step.milestone.gate === "human"} />
      <View style={styles.rowBody}>
        <View style={styles.rowHead}>
          <Text
            numberOfLines={open ? undefined : 1}
            style={[
              styles.rowTitle,
              step.standing === "passed" ? styles.rowTitlePassed : null,
              step.standing === "ahead" ? styles.rowTitleAhead : null,
            ]}
          >{step.milestone.title}</Text>
          {summary === undefined ? null : (
            <Text style={[
              styles.rowSummary,
              standing ? styles.rowSummaryStanding : null,
              summary === "stalled" ? styles.rowSummaryStalled : null,
            ]}>{summary}</Text>
          )}
        </View>
        {open ? (
          <StepDetail
            step={step}
            view={view}
            nowEpochMs={nowEpochMs}
            busy={busy}
            onSetPosition={onSetPosition}
            onCheckNow={onCheckNow}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

/// Everything below the title line: the recorded answer, who answers next and
/// when, and the row's actions. The standing step gets the screen's one primary
/// action; the positional correction is always the quiet second choice.
function StepDetail({ step, view, nowEpochMs, busy, onSetPosition, onCheckNow }: {
  step: TaskPipelineStep;
  view: TaskPipelineView;
  nowEpochMs: number;
  busy: string | undefined;
  onSetPosition: (passedMilestoneCount: number) => void;
  onCheckNow: () => void;
}) {
  const evidence = stepEvidence(step);
  const timing = stepTiming(step, nowEpochMs);
  const answers = stepAnswerSource(step);
  const position = stepPositionAction(step, view.placement);
  const checkable = stepIsCheckable(step);
  const standing = step.standing === "waiting";
  return (
    <View style={styles.detail}>
      {evidence === undefined ? null : (
        <Text style={[styles.evidence, standing ? styles.evidenceStanding : null]}>{evidence}</Text>
      )}
      <View style={styles.factRow}>
        {step.standing === "passed" ? null : (
          <Text style={[styles.fact, answers.blocked ? styles.factBlocked : null]}>
            {answers.blocked || step.milestone.gate === "human" ? answers.text : `Checked by ${answers.text}`}
          </Text>
        )}
        {timing === undefined ? null : (
          <Text style={[styles.fact, standing ? styles.factStanding : null]}>{timing}</Text>
        )}
      </View>
      {checkable || position !== undefined ? (
        <View style={styles.rowActions}>
          {checkable ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Run ${answers.text} now`}
              disabled={busy !== undefined}
              onPress={onCheckNow}
              style={({ pressed }) => [styles.checkNow, pressed && busy === undefined ? styles.checkNowPressed : null]}
            >
              <Text style={styles.checkNowLabel}>
                {busy === `routine-${step.milestone.routineId}` ? "Checking…" : "Check now"}
              </Text>
            </Pressable>
          ) : null}
          {position === undefined ? null : (
            <QuietAction
              label={busy === `position-${position.passedMilestoneCount}` ? "Moving…" : position.label}
              disabled={busy !== undefined}
              onPress={() => onSetPosition(position.passedMilestoneCount)}
            />
          )}
        </View>
      ) : null}
    </View>
  );
}

function QuietAction({ label, disabled, onPress }: {
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.quietAction, pressed && !disabled ? styles.quietActionPressed : null]}
    >
      <Text style={styles.quietActionLabel}>{label}</Text>
    </Pressable>
  );
}

/// A stale revision is the one refusal worth rewording: the pipeline moved while
/// this screen was open, and the fix is to look again rather than to retry.
function positionFailure(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /conflict|revision|stale/i.test(message)
    ? "The pipeline changed while this screen was open. It is reloaded — choose again."
    : message;
}

const NODE = 18;

const styles = StyleSheet.create({
  centre: { paddingVertical: space.lg, alignItems: "center" },
  block: { gap: space.sm },
  emptyBlock: { gap: space.sm, alignItems: "flex-start" },
  errorBlock: { paddingTop: 2 },
  progressRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.sm },
  pipelineName: { ...text.body, color: color.text, flexShrink: 1, fontWeight: "600" },
  progressLabel: { color: color.textSecondary, fontFamily: fontFamily.mono, fontSize: 11 },

  meter: { flexDirection: "row", gap: 3 },
  meterSegment: { flex: 1, height: 3, borderRadius: 2, backgroundColor: color.border },
  meterPassed: { backgroundColor: color.success },
  meterWaiting: { backgroundColor: color.accent },
  meterAway: { backgroundColor: color.borderStrong },

  row: {
    flexDirection: "row",
    minHeight: geometry.touchTarget,
    paddingHorizontal: space.md,
    gap: space.sm,
  },
  rowStanding: { backgroundColor: color.accentWash },
  rail: { width: NODE, alignItems: "center" },
  railLine: { flex: 1, width: 2, backgroundColor: color.border },
  railLineHidden: { backgroundColor: "transparent" },
  railLinePassed: { backgroundColor: "rgba(76,201,138,0.35)" },
  node: {
    width: NODE,
    height: NODE,
    borderRadius: NODE / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  nodeHuman: { borderRadius: 5 },
  nodePassed: { backgroundColor: "rgba(76,201,138,0.16)" },
  nodeWaiting: { backgroundColor: color.accent },
  nodeAhead: { borderWidth: 1.5, borderColor: color.borderStrong },
  nodeCheck: { color: color.success, fontFamily: fontFamily.mono, fontSize: 10, fontWeight: "800" },
  nodeCore: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.onAccent },

  rowBody: { flex: 1, paddingVertical: 12, gap: 6 },
  rowHead: { flexDirection: "row", alignItems: "baseline", gap: space.sm },
  rowTitle: { ...text.body, color: color.text, flex: 1, fontWeight: "600", lineHeight: 19 },
  rowTitlePassed: { color: color.textSecondary, fontWeight: "500" },
  rowTitleAhead: { color: color.textMuted, fontWeight: "500" },
  rowSummary: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 11 },
  rowSummaryStanding: { color: color.accentStrong },
  rowSummaryStalled: { color: color.warning, fontWeight: "700" },
  terminusDone: { ...text.body, flex: 1, color: color.success, fontWeight: "600", lineHeight: 19 },

  detail: { gap: 6 },
  evidence: { color: color.textSecondary, fontSize: 12, lineHeight: 18 },
  evidenceStanding: { color: color.text },
  factRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  fact: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 11 },
  factBlocked: { color: color.warning },
  factStanding: { color: color.accentStrong },

  rowActions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, paddingTop: 2 },
  checkNow: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: space.md,
    borderRadius: radius.control,
    backgroundColor: color.accent,
  },
  checkNowPressed: { backgroundColor: color.accentStrong },
  checkNowLabel: { color: color.onAccent, fontFamily: fontFamily.mono, fontSize: 12, fontWeight: "800" },
  quietAction: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: space.md,
    borderRadius: radius.control,
    backgroundColor: color.bgHover,
  },
  quietActionPressed: { backgroundColor: color.border },
  quietActionLabel: { color: color.textSecondary, fontSize: 12, fontWeight: "600" },
});
