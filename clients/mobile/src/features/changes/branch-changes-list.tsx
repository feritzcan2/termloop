import type { TaskBranchCommitChangeEntryDto, TaskBranchCommitDto } from "@termloop/contract/current";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { Banner, Card, CardDivider, EmptyState, SectionHeader } from "@/components/primitives";
import { ALL_BRANCH_CHANGES_ID, type BranchChanges } from "@/features/changes/use-branch-changes";
import { relativeAgeSentence } from "@/presentation/relative-time";
import { createThemedStyles, useTheme } from "@/theme/context";
import { space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

/// Committed work on the Task branch: one "all branch changes" range against the
/// base, then each commit newest first. The file rows are rendered by the owner so
/// both scopes share one row and one diff surface.
export function BranchChangesList({ branch, renderEntry }: {
  branch: BranchChanges;
  renderEntry(entry: TaskBranchCommitChangeEntryDto): ReactNode;
}) {
  const { color } = useTheme();
  const styles = useStyles();
  const commits = branch.commits;
  if (commits === undefined) {
    return branch.commitsError === undefined
      ? <View style={styles.loading}><ActivityIndicator color={color.accentStrong} /></View>
      : <Banner kind="danger" message={branch.commitsError} action="Retry" onAction={() => void branch.reload()} />;
  }
  if (commits.commits.length === 0) {
    return <EmptyState title="No commits" body={`${commits.branch_name} has no commits ahead of ${commits.base_ref ?? "its base"}.`} />;
  }
  const now = Date.now();
  const selectedLabel = branch.selectedCommitId === ALL_BRANCH_CHANGES_ID
    ? "All branch changes"
    : commits.commits.find((commit) => commit.commit_id === branch.selectedCommitId)?.short_oid ?? "Commit";
  const entries = branch.changes?.entries ?? [];
  return (
    <>
      <View style={styles.section}>
        <SectionHeader label="Commits" trailing={<Text style={styles.count}>{commits.commits.length}{commits.truncated ? "+" : ""}</Text>} />
        <Card>
          <CommitRow
            title="All branch changes"
            detail={commits.base_ref === null ? commits.branch_name : `${commits.branch_name} vs ${commits.base_ref}`}
            selected={branch.selectedCommitId === ALL_BRANCH_CHANGES_ID}
            onSelect={() => branch.selectCommit(ALL_BRANCH_CHANGES_ID)}
          />
          {commits.commits.map((commit) => (
            <View key={commit.commit_id}>
              <CardDivider />
              <CommitRow
                oid={commit.short_oid}
                title={commit.subject}
                detail={commitAge(commit, now)}
                selected={branch.selectedCommitId === commit.commit_id}
                onSelect={() => branch.selectCommit(commit.commit_id)}
              />
            </View>
          ))}
        </Card>
      </View>
      <View style={styles.section}>
        <SectionHeader label={selectedLabel} trailing={<Text style={styles.count}>{entries.length}</Text>} />
        {branch.changesError !== undefined ? (
          <Banner kind="danger" message={branch.changesError} />
        ) : branch.changes === undefined || branch.changesLoading ? (
          <View style={styles.loading}><ActivityIndicator color={color.accentStrong} /></View>
        ) : entries.length === 0 ? (
          <EmptyState title="No file changes" body="This selection changes no files." />
        ) : (
          <Card>
            {entries.map((entry, index) => (
              <View key={entry.entry_id}>
                {index === 0 ? null : <CardDivider />}
                {renderEntry(entry)}
              </View>
            ))}
          </Card>
        )}
        {branch.changes?.truncated ? <Banner kind="warning" message="This selection has more changed files than the phone can safely list." /> : null}
      </View>
    </>
  );
}

function CommitRow({ oid, title, detail, selected, onSelect }: {
  oid?: string | undefined;
  title: string;
  detail: string | undefined;
  selected: boolean;
  onSelect(): void;
}) {
  const styles = useStyles();
  return (
    <Pressable
      onPress={onSelect}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={oid === undefined ? title : `Commit ${oid}: ${title}`}
      style={({ pressed }) => [styles.row, selected ? styles.rowSelected : null, pressed ? styles.rowPressed : null]}
    >
      <View style={[styles.marker, selected ? styles.markerSelected : null]} />
      <View style={styles.rowText}>
        <Text style={[styles.title, oid === undefined ? styles.titleAll : null]} numberOfLines={2}>{title}</Text>
        <Text style={styles.detail} numberOfLines={1}>
          {oid === undefined ? null : <Text style={styles.oid}>{oid}</Text>}
          {oid !== undefined && detail !== undefined ? "  ·  " : null}
          {detail}
        </Text>
      </View>
    </Pressable>
  );
}

function commitAge(commit: TaskBranchCommitDto, now: number): string | undefined {
  return commit.authored_at_epoch_ms === null ? undefined : relativeAgeSentence(commit.authored_at_epoch_ms, now);
}

const useStyles = createThemedStyles(({ color }) => ({
  section: { gap: 6 },
  loading: { alignItems: "center", justifyContent: "center", minHeight: 72 },
  count: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 11, fontWeight: "700", fontVariant: ["tabular-nums"] },
  row: { alignItems: "center", flexDirection: "row", gap: space.md, minHeight: 52, paddingHorizontal: space.md, paddingVertical: 9 },
  rowSelected: { backgroundColor: color.accentWash },
  rowPressed: { backgroundColor: color.bgHover },
  marker: { borderColor: color.textMuted, borderRadius: 6, borderWidth: 2, height: 12, width: 12 },
  markerSelected: { backgroundColor: color.accentStrong, borderColor: color.accentStrong },
  rowText: { flex: 1, gap: 2, minWidth: 0 },
  title: { color: color.text, fontSize: 14.5, fontWeight: "600", lineHeight: 19 },
  titleAll: { fontWeight: "700" },
  detail: { color: color.textMuted, fontSize: 12, lineHeight: 16 },
  oid: { color: color.accentStrong, fontFamily: fontFamily.mono, fontWeight: "700" },
}));
