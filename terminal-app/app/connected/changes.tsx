import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { getActiveClient } from "../../lib/session";
import {
  type WorkspaceChangeFile,
  type WorkspaceChangesResult,
  type WorkspaceDiffLine,
} from "../../lib/termloop-client";
import { colors, monoFont, radii } from "../../lib/theme";

export default function ChangesScreen() {
  const router = useRouter();
  const { workspaceId, name } = useLocalSearchParams<{
    workspaceId?: string;
    name?: string;
  }>();
  const client = getActiveClient();
  const [changes, setChanges] = useState<WorkspaceChangesResult | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client || !workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const next = await client.getWorkspaceChanges({
        workspaceId,
        includePatch: true,
        maxPatchBytes: 240_000,
      });
      setChanges(next);
      setExpanded((current) => {
        if (Object.keys(current).length > 0) return current;
        const first = next.files[0]?.path;
        return first ? { [first]: true } : {};
      });
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => {
    if (!client) {
      router.replace("/");
      return;
    }
    load();
  }, [client, load, router]);

  const title = changes?.title || name || "Changes";
  const summary = useMemo(() => {
    if (!changes) return "";
    const count = changes.git_change_count;
    const unit = count === 1 ? "file" : "files";
    return `${count} ${unit}${changes.branch ? ` - ${changes.branch}` : ""}`;
  }, [changes]);

  return (
    <SafeAreaView style={styles.root} edges={["bottom"]}>
      <Stack.Screen
        options={{
          title: "Changes",
          headerRight: () => (
            <Pressable
              style={[styles.headerButton, loading && styles.disabled]}
              onPress={load}
              disabled={loading}
              hitSlop={8}
            >
              {loading ? (
                <ActivityIndicator color={colors.primary} size="small" />
              ) : (
                <Text style={styles.headerButtonText}>Refresh</Text>
              )}
            </Pressable>
          ),
        }}
      />

      <View style={styles.summary}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {summary ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {summary}
          </Text>
        ) : null}
        {changes?.worktree_path ? (
          <Text style={styles.path} numberOfLines={1}>
            {changes.worktree_path}
          </Text>
        ) : null}
      </View>

      {error ? (
        <Pressable style={styles.errorBanner} onPress={load}>
          <Text style={styles.errorText} numberOfLines={2}>
            {error}
          </Text>
        </Pressable>
      ) : null}

      {loading && !changes ? (
        <View style={styles.loadingPane}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : !changes || changes.files.length === 0 ? (
        <View style={styles.emptyPane}>
          <Text style={styles.emptyTitle}>No changes</Text>
          <Text style={styles.emptyText}>This worktree is clean.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {changes.files.map((file) => {
            const isExpanded = expanded[file.path] ?? false;
            return (
              <ChangedFile
                key={file.path}
                file={file}
                expanded={isExpanded}
                onToggle={() =>
                  setExpanded((current) => ({
                    ...current,
                    [file.path]: !isExpanded,
                  }))
                }
              />
            );
          })}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function ChangedFile({
  file,
  expanded,
  onToggle,
}: {
  file: WorkspaceChangeFile;
  expanded: boolean;
  onToggle: () => void;
}) {
  const hunks = file.hunks ?? [];
  return (
    <View style={styles.fileBlock}>
      <Pressable style={styles.fileHeader} onPress={onToggle}>
        <Text style={[styles.statusBadge, statusStyle(file.status)]}>
          {statusShort(file.status)}
        </Text>
        <View style={styles.fileTitleBlock}>
          <Text style={styles.filePath} numberOfLines={2}>
            {file.path}
          </Text>
          <Text style={styles.fileMeta} numberOfLines={1}>
            {file.binary
              ? "Binary"
              : `${file.additions ?? 0}+ ${(file.deletions ?? 0)}-`}
            {file.patch_truncated ? " - truncated" : ""}
          </Text>
        </View>
        <Text style={styles.expandIcon}>{expanded ? "-" : "+"}</Text>
      </Pressable>
      {expanded ? (
        file.binary ? (
          <Text style={styles.notice}>Binary file</Text>
        ) : hunks.length === 0 ? (
          <Text style={styles.notice}>No text diff available.</Text>
        ) : (
          <View style={styles.diffBlock}>
            {hunks.map((hunk, index) => (
              <View key={`${file.path}:${index}`} style={styles.hunk}>
                <Text style={styles.hunkHeader}>
                  @@ -{hunk.old_start},{hunk.old_lines} +{hunk.new_start},
                  {hunk.new_lines} @@
                </Text>
                {hunk.lines.map((line, lineIndex) => (
                  <DiffLine
                    key={`${file.path}:${index}:${lineIndex}`}
                    line={line}
                  />
                ))}
              </View>
            ))}
          </View>
        )
      ) : null}
    </View>
  );
}

function DiffLine({ line }: { line: WorkspaceDiffLine }) {
  return (
    <View style={[styles.diffLine, diffLineStyle(line.kind)]}>
      <Text style={styles.lineNumber}>{line.old_line ?? ""}</Text>
      <Text style={styles.lineNumber}>{line.new_line ?? ""}</Text>
      <Text style={[styles.lineMarker, diffTextStyle(line.kind)]}>
        {lineMarker(line.kind)}
      </Text>
      <Text style={[styles.diffText, diffTextStyle(line.kind)]}>
        {line.text || " "}
      </Text>
    </View>
  );
}

function statusShort(status: string): string {
  switch (status) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "?";
    default:
      return status.slice(0, 1).toUpperCase();
  }
}

function lineMarker(kind: string): string {
  if (kind === "add") return "+";
  if (kind === "delete") return "-";
  return " ";
}

function statusStyle(status: string) {
  if (status === "deleted") return styles.statusDeleted;
  if (status === "added" || status === "untracked") return styles.statusAdded;
  if (status === "renamed") return styles.statusRenamed;
  return styles.statusModified;
}

function diffLineStyle(kind: string) {
  if (kind === "add") return styles.diffLineAdded;
  if (kind === "delete") return styles.diffLineDeleted;
  return null;
}

function diffTextStyle(kind: string) {
  if (kind === "add") return styles.diffTextAdded;
  if (kind === "delete") return styles.diffTextDeleted;
  return null;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: 14,
    paddingTop: 8,
    gap: 8,
  },
  headerButton: {
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    backgroundColor: colors.primaryDim,
    alignItems: "center",
    justifyContent: "center",
  },
  headerButtonText: { color: colors.primary, fontSize: 12, fontWeight: "800" },
  disabled: { opacity: 0.5 },
  summary: {
    gap: 3,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  title: { color: colors.text, fontSize: 15, fontWeight: "800" },
  subtitle: { color: colors.sub, fontSize: 12, fontWeight: "700" },
  path: { color: colors.hint, fontSize: 11, fontFamily: monoFont },
  errorBanner: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerDim,
  },
  errorText: { color: colors.danger, fontSize: 12, lineHeight: 16 },
  loadingPane: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyPane: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  emptyTitle: { color: colors.text, fontSize: 15, fontWeight: "800" },
  emptyText: { color: colors.sub, fontSize: 12 },
  content: { paddingBottom: 18, gap: 8 },
  fileBlock: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    overflow: "hidden",
  },
  fileHeader: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  statusBadge: {
    width: 24,
    height: 24,
    borderRadius: radii.sm,
    borderWidth: 1,
    textAlign: "center",
    textAlignVertical: "center",
    fontSize: 12,
    fontWeight: "900",
    fontFamily: monoFont,
    overflow: "hidden",
  },
  statusModified: {
    color: colors.warn,
    borderColor: colors.warn,
    backgroundColor: colors.bgRaised,
  },
  statusAdded: {
    color: colors.success,
    borderColor: colors.successBorder,
    backgroundColor: colors.successDim,
  },
  statusDeleted: {
    color: colors.danger,
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerDim,
  },
  statusRenamed: {
    color: colors.primary,
    borderColor: colors.borderAccent,
    backgroundColor: colors.primaryDim,
  },
  fileTitleBlock: { flex: 1, minWidth: 0, gap: 2 },
  filePath: { color: colors.text, fontSize: 13, fontWeight: "800" },
  fileMeta: { color: colors.sub, fontSize: 11, fontFamily: monoFont },
  expandIcon: {
    color: colors.primary,
    fontSize: 19,
    fontWeight: "900",
    width: 22,
    textAlign: "center",
  },
  notice: {
    color: colors.sub,
    fontSize: 12,
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  diffBlock: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surfaceBg,
  },
  hunk: { paddingVertical: 6 },
  hunkHeader: {
    color: colors.primary,
    fontSize: 11,
    fontFamily: monoFont,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  diffLine: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 6,
    minHeight: 18,
  },
  diffLineAdded: { backgroundColor: colors.successDim },
  diffLineDeleted: { backgroundColor: colors.dangerDim },
  lineNumber: {
    width: 34,
    color: colors.hint,
    fontSize: 11,
    lineHeight: 18,
    fontFamily: monoFont,
    textAlign: "right",
  },
  lineMarker: {
    width: 16,
    color: colors.sub,
    fontSize: 11,
    lineHeight: 18,
    fontFamily: monoFont,
    textAlign: "center",
  },
  diffText: {
    flex: 1,
    color: colors.terminalText,
    fontSize: 11,
    lineHeight: 18,
    fontFamily: monoFont,
  },
  diffTextAdded: { color: colors.success },
  diffTextDeleted: { color: colors.danger },
});
