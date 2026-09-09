import type {
  TaskDto,
  TaskWorktreeChangeEntryDto,
  TaskWorktreeChangeListResult,
  TaskWorktreeDiffResult,
  TaskWorktreePreImageResult,
} from "@termloop/contract/current";
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ChangeReviewEditor, ChangeReviewPanel } from "@/components/change-review";
import { Banner, Card, CardDivider, EmptyState, SecondaryButton, SectionHeader, StatePill } from "@/components/primitives";
import { Screen, ScreenHeader } from "@/components/screen";
import { WorktreeDiff } from "@/components/worktree-diff";
import { useMobileRuntime } from "@/composition/runtime-context";
import { useConnections } from "@/features/connection/connection-store";
import { useOverview } from "@/features/overview/overview-store";
import { useChangeReview, type ChangeReview } from "@/features/changes/use-change-review";
import { reviewLineKey } from "@/presentation/change-review-notes";
import { basename } from "@/presentation/dto-readers";
import { keyboardAvoidingBehavior } from "@/platform/presentation";
import {
  nextUnreviewedEntryId,
  reviewProgress,
  reviewedEntries,
  unreviewedSections,
} from "@/presentation/worktree-change-review";
import { color, geometry, radius, space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

type LoadState = "idle" | "loading" | "ready" | "failed";

/// One Task checkout, one current worktree observation. This is intentionally a
/// review surface rather than a Git client: every patch is addressed by the
/// observation returned with its file list. Checkmarks and feedback are temporary
/// presentation state scoped to the selected Mac and Task.
export default function TaskChangesRoute() {
  const { taskId, connectionId } = useLocalSearchParams<{ taskId: string; connectionId?: string }>();
  const connections = useConnections();
  const selectingConnection = connectionId !== undefined && connections.selectedId !== connectionId;
  const connection = selectingConnection ? undefined : connections.selected;
  const overview = useOverview();
  const task = overview.overview?.tasks.find((candidate) => candidate.id === taskId);
  useEffect(() => {
    if (connectionId !== undefined && connections.selectedId !== connectionId) connections.select(connectionId);
  }, [connectionId, connections.select, connections.selectedId]);
  if (selectingConnection) return <Screen><ScreenHeader back="Task" title="Changes" /><ActivityIndicator color={color.accentStrong} /></Screen>;
  if (!connection) return <UnavailableChanges title="No Mac selected" body="Select a paired Mac before reading this Task's worktree." />;
  if (!task) return <UnavailableChanges title="Task unavailable" body="This Task is no longer in the selected Mac's current projection." />;
  if (!task.worktree) return <UnavailableChanges title="No worktree" body="Create a worktree on your Mac before reviewing changes here." />;
  return <TaskChangesScreen key={`${connection.id}:${task.id}`} connectionId={connection.id} task={task} />;
}

function TaskChangesScreen({ connectionId, task }: { connectionId: string; task: TaskDto }) {
  const runtime = useMobileRuntime();
  const overview = useOverview();
  const review = useChangeReview(runtime, connectionId, task, overview.overview?.sessions ?? []);
  const listSequence = useRef(0);
  const taskId = task.id;
  const [load, setLoad] = useState<LoadState>("idle");
  const [changes, setChanges] = useState<TaskWorktreeChangeListResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [reviewedEntryIds, setReviewedEntryIds] = useState<ReadonlySet<string>>(() => new Set());
  const [reviewedExpanded, setReviewedExpanded] = useState(false);
  const [selectedEntryId, setSelectedEntryId] = useState<string | undefined>();
  const [diff, setDiff] = useState<TaskWorktreeDiffResult | undefined>();
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | undefined>();
  const [fullFile, setFullFile] = useState(false);
  const [preImage, setPreImage] = useState<TaskWorktreePreImageResult | undefined>();
  const [preImageLoading, setPreImageLoading] = useState(false);
  const [preImageError, setPreImageError] = useState<string | undefined>();

  const reload = useCallback(async () => {
    const sequence = ++listSequence.current;
    setLoad("loading");
    setError(undefined);
    try {
      const next = await runtime.worktreeChanges.listTask(connectionId, taskId);
      if (sequence !== listSequence.current) return;
      setChanges(next);
      // A refresh is a new Git observation, not proof that the previous review
      // still covers the new checkout. Start the temporary review tracker over.
      setReviewedEntryIds(new Set());
      setReviewedExpanded(false);
      setSelectedEntryId(undefined);
      setDiff(undefined);
      setDiffError(undefined);
      setFullFile(false);
      setPreImage(undefined);
      setPreImageError(undefined);
      setLoad("ready");
    } catch (cause) {
      if (sequence !== listSequence.current) return;
      setError(messageOf(cause, "This worktree could not be read."));
      setLoad("failed");
    }
  }, [connectionId, runtime.worktreeChanges, taskId]);

  useEffect(() => {
    void reload();
    return () => { listSequence.current += 1; };
  }, [reload]);

  const selectedEntry = changes?.entries.find((entry) => entry.entry_id === selectedEntryId);
  useEffect(() => {
    if (changes === undefined || selectedEntry === undefined) {
      setDiff(undefined);
      setDiffError(undefined);
      setDiffLoading(false);
      return;
    }
    if (selectedEntry.render_state !== "available") {
      setDiff({
        task_id: taskId,
        observation_id: changes.observation_id,
        entry_id: selectedEntry.entry_id,
        state: "notShown",
        patch: null,
      });
      setDiffError(undefined);
      setDiffLoading(false);
      return;
    }
    let current = true;
    setDiff(undefined);
    setDiffError(undefined);
    setDiffLoading(true);
    void runtime.worktreeChanges.diffTask(
      connectionId,
      taskId,
      changes.observation_id,
      selectedEntry.entry_id,
    ).then((next) => {
      if (!current) return;
      setDiff(next);
      setDiffLoading(false);
    }).catch((cause) => {
      if (!current) return;
      setDiffError(messageOf(cause, "This patch could not be read."));
      setDiffLoading(false);
    });
    return () => { current = false; };
  }, [changes, connectionId, runtime.worktreeChanges, selectedEntry, taskId]);

  // Full-file content is opt-in and belongs to one exact selected patch. Clear
  // it as soon as that selection changes, so a pre-image can never be shown for
  // the file the reviewer just moved on to.
  useEffect(() => {
    setFullFile(false);
    setPreImage(undefined);
    setPreImageLoading(false);
    setPreImageError(undefined);
  }, [changes?.observation_id, selectedEntry?.entry_id]);

  useEffect(() => {
    if (!fullFile || changes === undefined || selectedEntry === undefined) {
      return;
    }
    let current = true;
    setPreImage(undefined);
    setPreImageError(undefined);
    setPreImageLoading(true);
    void runtime.worktreeChanges.preImageTask(
      connectionId,
      taskId,
      changes.observation_id,
      selectedEntry.entry_id,
    ).then((next) => {
      if (!current) return;
      setPreImage(next);
      setPreImageLoading(false);
    }).catch((cause) => {
      if (!current) return;
      setPreImageError(messageOf(cause, "The full file could not be read."));
      setPreImageLoading(false);
    });
    return () => { current = false; };
  }, [changes, connectionId, fullFile, runtime.worktreeChanges, selectedEntry, taskId]);

  const sections = useMemo(
    () => changes === undefined ? [] : unreviewedSections(changes.entries, reviewedEntryIds),
    [changes, reviewedEntryIds],
  );
  const reviewed = useMemo(
    () => changes === undefined ? [] : reviewedEntries(changes.entries, reviewedEntryIds),
    [changes, reviewedEntryIds],
  );
  const progress = useMemo(
    () => changes === undefined ? { reviewed: 0, total: 0 } : reviewProgress(changes.entries, reviewedEntryIds),
    [changes, reviewedEntryIds],
  );
  const nextEntryIdAfterReview = useMemo(() => {
    if (changes === undefined || selectedEntry === undefined) return undefined;
    const afterReview = new Set(reviewedEntryIds);
    afterReview.add(selectedEntry.entry_id);
    return nextUnreviewedEntryId(changes.entries, afterReview, selectedEntry.entry_id);
  }, [changes, reviewedEntryIds, selectedEntry]);
  const selectedEntryPosition = useMemo(() => {
    if (changes === undefined || selectedEntry === undefined) return 0;
    return changes.entries.findIndex((entry) => entry.entry_id === selectedEntry.entry_id) + 1;
  }, [changes, selectedEntry]);

  const markReviewed = useCallback((entryId: string, advance = false) => {
    if (changes === undefined) return;
    const next = new Set(reviewedEntryIds);
    next.add(entryId);
    setReviewedEntryIds(next);
    if (selectedEntryId === entryId) {
      setFullFile(false);
      setSelectedEntryId(advance ? nextUnreviewedEntryId(changes.entries, next, entryId) : undefined);
    }
  }, [changes, reviewedEntryIds, selectedEntryId]);

  const markAllReviewed = useCallback(() => {
    if (changes === undefined) return;
    setReviewedEntryIds(new Set(changes.entries.map((entry) => entry.entry_id)));
    setSelectedEntryId(undefined);
  }, [changes]);

  const markUnreviewed = useCallback((entryId: string) => {
    const next = new Set(reviewedEntryIds);
    next.delete(entryId);
    setReviewedEntryIds(next);
    setSelectedEntryId(entryId);
  }, [reviewedEntryIds]);

  const clearReviewed = useCallback(() => {
    setReviewedEntryIds(new Set());
    setSelectedEntryId(undefined);
  }, []);

  const currentDiff = diff?.entry_id === selectedEntryId && diff?.observation_id === changes?.observation_id ? diff : undefined;
  const currentPreImage = preImage?.entry_id === selectedEntryId && preImage?.observation_id === changes?.observation_id ? preImage : undefined;

  return (
    <Screen>
      <ScreenHeader back="Task" title="Changes" subtitle={task.title} />
      {load === "loading" && changes === undefined ? (
        <View style={styles.centre}><ActivityIndicator color={color.accentStrong} /></View>
      ) : load === "failed" && changes === undefined ? (
        <View style={styles.centre}>
          <Banner kind="danger" message={error ?? "This worktree could not be read."} action="Retry" onAction={() => void reload()} />
        </View>
      ) : changes === undefined ? null : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={load === "loading"} onRefresh={() => void reload()} tintColor={color.textSecondary} />}
        >
          {error === undefined ? null : <Banner kind="danger" message={error} action="Retry" onAction={() => void reload()} />}
          <View style={styles.summary}>
            <View>
              <Text style={styles.summaryTitle}>{changes.entries.length} {changes.entries.length === 1 ? "change" : "changes"}</Text>
              <Text style={styles.summaryDetail}>{progress.reviewed}/{progress.total} reviewed · {reviewPercent(progress)}%</Text>
              <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: progress.total, now: progress.reviewed }} style={styles.progressTrack}>
                <View style={[styles.progressValue, { width: `${reviewPercent(progress)}%` }]} />
              </View>
            </View>
            {progress.total === 0 ? null : progress.reviewed === progress.total ? (
              <SecondaryButton label="Clear reviewed" onPress={clearReviewed} />
            ) : (
              <SecondaryButton label="Review all" onPress={markAllReviewed} />
            )}
          </View>

          {changes.truncated ? (
            <Banner kind="warning" message="This worktree has more changed files than the phone can safely list." />
          ) : null}

          {sections.map((section) => (
            <View key={section.id} style={styles.section}>
              <SectionHeader label={section.label} trailing={<Text style={styles.count}>{section.entries.length}</Text>} />
              <Card>
                {section.entries.map((entry, index) => (
                  <View key={entry.entry_id}>
                    {index === 0 ? null : <CardDivider />}
                    <ChangeRow
                      entry={entry}
                      selected={entry.entry_id === selectedEntryId}
                      onSelect={() => setSelectedEntryId(entry.entry_id)}
                      onMarkReviewed={() => markReviewed(entry.entry_id)}
                    />
                  </View>
                ))}
              </Card>
            </View>
          ))}

          {reviewed.length === 0 ? null : (
            <View style={styles.section}>
              <SectionHeader
                label="Reviewed"
                trailing={(
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={reviewedExpanded ? "Collapse reviewed files" : "Expand reviewed files"}
                    onPress={() => setReviewedExpanded((current) => !current)}
                    hitSlop={10}
                    style={styles.reviewedToggle}
                  >
                    <Text style={styles.reviewedToggleText}>{reviewed.length} {reviewedExpanded ? "⌃" : "⌄"}</Text>
                  </Pressable>
                )}
              />
              {reviewedExpanded ? (
                <Card>
                  {reviewed.map((entry, index) => (
                    <View key={entry.entry_id}>
                      {index === 0 ? null : <CardDivider />}
                      <ChangeRow
                        entry={entry}
                        selected={entry.entry_id === selectedEntryId}
                        onSelect={() => setSelectedEntryId(entry.entry_id)}
                        reviewed
                        onMarkReviewed={() => markUnreviewed(entry.entry_id)}
                      />
                    </View>
                  ))}
                </Card>
              ) : null}
            </View>
          )}

          {changes.entries.length === 0 ? (
            <EmptyState title="No changes" body="This worktree is clean in the current snapshot." />
          ) : sections.length === 0 ? (
            <EmptyState title="Review complete" body="Every file in this observation is marked reviewed. Pull to refresh before trusting a new worktree state." />
          ) : null}
        </ScrollView>
      )}
      <View style={styles.feedbackBar}>
        <SecondaryButton label={`Feedback (${review.notes.length})`} onPress={() => review.setShowNotes(true)} />
        <Text style={styles.modalFooterHint}>Add line comments, then send together</Text>
      </View>
      {selectedEntry === undefined && !review.showNotes ? null : (
        <ChangeDiffModal
          entry={selectedEntry}
          diff={currentDiff}
          loading={diffLoading}
          error={diffError}
          position={selectedEntryPosition}
          total={changes?.entries.length ?? 0}
          hasNext={nextEntryIdAfterReview !== undefined}
          fullFile={fullFile}
          fullFileAvailable={currentDiff?.state === "patch" && diffError === undefined}
          preImage={currentPreImage}
          preImageLoading={preImageLoading}
          preImageError={preImageError}
          onFullFileChange={setFullFile}
          review={review}
          observationId={changes?.observation_id}
          onReview={() => { if (selectedEntry) markReviewed(selectedEntry.entry_id, true); }}
          onClose={() => {
            if (review.sending) return;
            review.finishDraft();
            review.setShowNotes(false);
            setFullFile(false);
            setSelectedEntryId(undefined);
          }}
        />
      )}
    </Screen>
  );
}

function UnavailableChanges({ title, body }: { title: string; body: string }) {
  return (
    <Screen>
      <ScreenHeader back="Task" title="Changes" />
      <View style={styles.centre}><EmptyState title={title} body={body} /></View>
    </Screen>
  );
}

function ChangeRow({ entry, selected, reviewed = false, onSelect, onMarkReviewed }: {
  entry: TaskWorktreeChangeEntryDto;
  selected: boolean;
  reviewed?: boolean | undefined;
  onSelect(): void;
  onMarkReviewed?: (() => void) | undefined;
}) {
  return (
    <View style={[styles.row, selected ? styles.rowSelected : null]}>
      <Pressable
        onPress={onSelect}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={`${entry.kind} ${entry.display_path}`}
        accessibilityHint="Open diff"
        style={({ pressed }) => [styles.rowMain, pressed ? styles.rowMainPressed : null]}
      >
        <View style={styles.rowTitle}>
          <Text style={styles.kind}>{kindGlyph(entry.kind)}</Text>
          <Text style={styles.path} numberOfLines={2}>{entry.display_path}</Text>
        </View>
        {entry.original_display_path === null ? null : <Text style={styles.original} numberOfLines={1}>from {entry.original_display_path}</Text>}
      </Pressable>
      <Text style={styles.rowChevron} accessibilityElementsHidden>›</Text>
      {onMarkReviewed === undefined ? (
        <View style={[styles.reviewMark, styles.reviewMarkDone]}><Text style={styles.reviewMarkDoneText}>✓</Text></View>
      ) : (
        <Pressable
          onPress={onMarkReviewed}
          accessibilityRole="button"
          accessibilityLabel={`Mark ${entry.display_path} ${reviewed ? "unreviewed" : "reviewed"}`}
          style={({ pressed }) => [styles.reviewMark, reviewed ? styles.reviewMarkDone : null, pressed ? styles.reviewMarkPressed : null]}
          hitSlop={8}
        >
          <Text style={reviewed ? styles.reviewMarkDoneText : styles.reviewMarkText}>{reviewed ? "✓" : "○"}</Text>
        </Pressable>
      )}
    </View>
  );
}

function ChangeDiffModal({
  entry,
  diff,
  loading,
  error,
  position,
  total,
  hasNext,
  fullFile,
  fullFileAvailable,
  preImage,
  preImageLoading,
  preImageError,
  review,
  observationId,
  onFullFileChange,
  onReview,
  onClose,
}: {
  entry: TaskWorktreeChangeEntryDto | undefined;
  diff: TaskWorktreeDiffResult | undefined;
  loading: boolean;
  error: string | undefined;
  position: number;
  total: number;
  hasNext: boolean;
  fullFile: boolean;
  fullFileAvailable: boolean;
  preImage: TaskWorktreePreImageResult | undefined;
  preImageLoading: boolean;
  preImageError: string | undefined;
  review: ChangeReview;
  observationId: string | undefined;
  onFullFileChange(value: boolean): void;
  onReview(): void;
  onClose(): void;
}) {
  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaProvider>
      <Screen>
        <KeyboardAvoidingView style={styles.modalScroll} behavior={keyboardAvoidingBehavior}>
        <ScreenHeader
          title={review.showNotes ? "Feedback" : "Diff"}
          subtitle={review.showNotes ? `${review.notes.length} pending comments` : entry ? basename(entry.display_path) : undefined}
          right={(
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close diff"
              disabled={review.sending}
              onPress={onClose}
              hitSlop={10}
              style={({ pressed }) => [styles.closeButton, pressed ? styles.closeButtonPressed : null]}
            >
              <Text style={styles.closeButtonText}>Close</Text>
            </Pressable>
          )}
        />
        {review.error ? <Banner kind="danger" message={review.error} /> : null}
        {review.showNotes ? (
          <ChangeReviewPanel review={review} observationId={observationId} onBackToDiff={entry ? () => { review.finishDraft(); review.setShowNotes(false); } : undefined} />
        ) : entry ? <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalContent} bounces={false} keyboardShouldPersistTaps="handled">
          <View style={styles.modalMeta}>
            <Text style={styles.modalMetaLabel}>FILE {position}/{total}</Text>
            <Text style={styles.modalMetaHint}>{fullFile ? "Current file" : "Change focus"}</Text>
          </View>
          <View style={styles.viewToggle} accessibilityRole="tablist">
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: !fullFile }}
              onPress={() => onFullFileChange(false)}
              style={({ pressed }) => [styles.viewToggleButton, !fullFile ? styles.viewToggleButtonSelected : null, pressed ? styles.viewToggleButtonPressed : null]}
            >
              <Text style={[styles.viewToggleLabel, !fullFile ? styles.viewToggleLabelSelected : null]}>Diff</Text>
            </Pressable>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: fullFile, disabled: !fullFileAvailable }}
              disabled={!fullFileAvailable}
              onPress={() => onFullFileChange(true)}
              style={({ pressed }) => [
                styles.viewToggleButton,
                fullFile ? styles.viewToggleButtonSelected : null,
                !fullFileAvailable ? styles.viewToggleButtonDisabled : null,
                pressed && fullFileAvailable ? styles.viewToggleButtonPressed : null,
              ]}
            >
              <Text style={[
                styles.viewToggleLabel,
                fullFile ? styles.viewToggleLabelSelected : null,
                !fullFileAvailable ? styles.viewToggleLabelDisabled : null,
              ]}>Full file</Text>
            </Pressable>
          </View>
          <Card style={styles.diffCard}>
            <View style={styles.diffHeader}>
              <View style={styles.diffTitle}>
                <Text style={styles.diffPath} selectable>{entry.display_path}</Text>
                {entry.original_display_path === null ? null : <Text style={styles.diffOriginal}>from {entry.original_display_path}</Text>}
              </View>
              <StatePill tone="quiet" label={entry.kind} />
            </View>
            <CardDivider />
            {loading ? (
              <View style={styles.diffLoading}><ActivityIndicator color={color.accentStrong} /></View>
            ) : error === undefined ? (
              <WorktreeDiff
                state={diff?.state ?? "notShown"}
                patch={diff?.patch ?? null}
                mode={fullFile ? "fullFile" : "diff"}
                preImage={preImage}
                fullFileLoading={preImageLoading}
                fullFileError={preImageError}
                review={observationId && !review.sending ? {
                  notedLines: new Set(review.notes.filter((note) => note.observationId === observationId && note.entryId === entry.entry_id).map(reviewLineKey)),
                  onSelectLine: (line) => review.openLine(observationId, entry, line),
                } : undefined}
              />
            ) : (
              <View style={styles.diffError}><Banner kind="danger" message={error} /></View>
            )}
          </Card>
        </ScrollView> : null}
        {review.draft ? <ChangeReviewEditor review={review} /> : review.showNotes ? null : <View style={styles.modalFooter}>
          <View style={styles.feedbackBar}>
            <Text style={styles.modalFooterHint}>Tap + beside a line to add feedback</Text>
            <SecondaryButton label={`Feedback (${review.notes.length})`} onPress={() => review.setShowNotes(true)} />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={hasNext ? "Mark reviewed and open next file" : "Mark reviewed"}
            onPress={onReview}
            style={({ pressed }) => [styles.reviewNextButton, pressed ? styles.reviewNextButtonPressed : null]}
          >
            <Text style={styles.reviewNextButtonText}>{hasNext ? "Review & next  →" : "Mark reviewed  ✓"}</Text>
          </Pressable>
        </View>}
        </KeyboardAvoidingView>
      </Screen>
      </SafeAreaProvider>
    </Modal>
  );
}

function kindGlyph(kind: TaskWorktreeChangeEntryDto["kind"]): string {
  switch (kind) {
    case "added":
    case "untracked": return "A";
    case "deleted": return "D";
    case "renamed": return "R";
    case "copied": return "C";
    case "unmerged": return "!";
    case "modified": return "M";
  }
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

function reviewPercent(progress: { reviewed: number; total: number }): number {
  return progress.total === 0 ? 0 : Math.round((progress.reviewed / progress.total) * 100);
}

const styles = StyleSheet.create({
  feedbackBar: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.xs },
  centre: { flex: 1, justifyContent: "center", padding: space.screen },
  content: { gap: space.lg, padding: space.screen, paddingBottom: space.xl },
  summary: {
    alignItems: "center",
    backgroundColor: color.bgRaised,
    borderRadius: radius.card,
    flexDirection: "row",
    justifyContent: "space-between",
    gap: space.md,
    padding: space.md,
  },
  summaryTitle: { color: color.text, fontFamily: fontFamily.mono, fontSize: 15, fontWeight: "700" },
  summaryDetail: { color: color.textSecondary, fontSize: 12, marginTop: 3 },
  progressTrack: { backgroundColor: color.bgTerminal, borderRadius: radius.pill, height: 4, marginTop: space.sm, overflow: "hidden", width: 132 },
  progressValue: { backgroundColor: color.success, borderRadius: radius.pill, height: "100%" },
  section: { gap: 6 },
  count: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 11, fontWeight: "700", fontVariant: ["tabular-nums"] },
  row: { alignItems: "center", flexDirection: "row", minHeight: geometry.touchTarget, paddingLeft: space.md },
  rowSelected: { backgroundColor: color.accentWash },
  rowMain: { flex: 1, minWidth: 0, paddingVertical: 9 },
  rowMainPressed: { backgroundColor: color.bgHover },
  rowChevron: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 23, lineHeight: 25, marginRight: 2 },
  rowTitle: { alignItems: "flex-start", flexDirection: "row", gap: space.sm },
  kind: { color: color.accentStrong, fontFamily: fontFamily.mono, fontSize: 12, fontWeight: "800", width: 12 },
  path: { color: color.text, flex: 1, fontFamily: fontFamily.mono, fontSize: 12, lineHeight: 17 },
  original: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 10.5, marginLeft: 20, marginTop: 2 },
  reviewMark: { alignItems: "center", height: geometry.touchTarget, justifyContent: "center", width: geometry.touchTarget },
  reviewMarkText: { color: color.textSecondary, fontFamily: fontFamily.mono, fontSize: 22, lineHeight: 25 },
  reviewMarkPressed: { backgroundColor: color.bgHover },
  reviewMarkDone: { backgroundColor: color.successWash },
  reviewMarkDoneText: { color: color.success, fontFamily: fontFamily.mono, fontSize: 18, fontWeight: "800" },
  reviewedToggle: { minHeight: 24, justifyContent: "center", paddingLeft: space.sm },
  reviewedToggleText: { color: color.accentStrong, fontFamily: fontFamily.mono, fontSize: 12, fontWeight: "700" },
  diffCard: { overflow: "hidden" },
  diffHeader: { alignItems: "center", flexDirection: "row", gap: space.sm, padding: space.md },
  diffTitle: { flex: 1, minWidth: 0 },
  diffPath: { color: color.text, fontFamily: fontFamily.mono, fontSize: 12, lineHeight: 18 },
  diffOriginal: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 10.5, marginTop: 2 },
  diffLoading: { alignItems: "center", minHeight: 104, justifyContent: "center" },
  diffError: { padding: space.sm },
  modalContent: { gap: space.md, padding: space.screen, paddingBottom: space.xl },
  modalScroll: { flex: 1 },
  modalMeta: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  modalMetaLabel: { color: color.accentStrong, fontFamily: fontFamily.mono, fontSize: 11, fontWeight: "800", letterSpacing: 0.7 },
  modalMetaHint: { color: color.textMuted, fontSize: 11 },
  viewToggle: { alignSelf: "flex-start", backgroundColor: color.bgRaised, borderRadius: radius.control, flexDirection: "row", overflow: "hidden" },
  viewToggleButton: { alignItems: "center", justifyContent: "center", minHeight: 34, paddingHorizontal: space.md },
  viewToggleButtonSelected: { backgroundColor: color.accentWash },
  viewToggleButtonPressed: { backgroundColor: color.bgHover },
  viewToggleButtonDisabled: { opacity: 0.42 },
  viewToggleLabel: { color: color.textSecondary, fontFamily: fontFamily.mono, fontSize: 12, fontWeight: "700" },
  viewToggleLabelSelected: { color: color.accentStrong },
  viewToggleLabelDisabled: { color: color.textMuted },
  modalFooter: { alignItems: "center", borderTopColor: color.rule, borderTopWidth: StyleSheet.hairlineWidth, gap: space.sm, padding: space.md },
  modalFooterHint: { color: color.textMuted, fontSize: 11 },
  reviewNextButton: { alignItems: "center", backgroundColor: color.accentStrong, borderRadius: radius.control, justifyContent: "center", minHeight: geometry.touchTarget, paddingHorizontal: space.lg, width: "100%" },
  reviewNextButtonPressed: { backgroundColor: color.accent },
  reviewNextButtonText: { color: color.onAccent, fontFamily: fontFamily.mono, fontSize: 13, fontWeight: "800" },
  closeButton: { alignItems: "center", justifyContent: "center", minHeight: geometry.touchTarget, paddingHorizontal: space.sm },
  closeButtonPressed: { backgroundColor: color.bgHover },
  closeButtonText: { color: color.accentStrong, fontFamily: fontFamily.mono, fontSize: 12, fontWeight: "700" },
});
