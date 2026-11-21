import { createThemedStyles } from "@/theme/context";
import { parseDiff, type IChange, type IFile } from "react-native-diff-view";
import { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { TaskWorktreeDiffState, TaskWorktreePreImageResult } from "@termloop/contract/current";
import { reconstructFullFile, type FullFileDisplayLine } from "@/presentation/worktree-full-file";
import { diffReviewLine, reviewLineKey, type ReviewLine } from "@/presentation/change-review-notes";
import { space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

/// `react-native-diff-view` owns the unified-patch parser. Its stock renderer
/// carries a fixed palette, so this small native renderer consumes its typed
/// hunk model and keeps the review surface inside TermLoop's selected theme.
export type WorktreeDiffMode = "diff" | "fullFile";
export type WorktreeDiffReview = {
  notedLines: ReadonlySet<string>;
  onSelectLine(line: ReviewLine): void;
};

export function WorktreeDiff({ state, patch, mode = "diff", wrap = true, preImage, fullFileLoading = false, fullFileError, review }: {
  state: TaskWorktreeDiffState;
  patch: string | null;
  mode?: WorktreeDiffMode | undefined;
  /// Soft-wrap long lines instead of scrolling sideways. A phone is too narrow
  /// for sideways scrolling to be the default way to read code.
  wrap?: boolean | undefined;
  preImage?: TaskWorktreePreImageResult | undefined;
  fullFileLoading?: boolean | undefined;
  fullFileError?: string | undefined;
  review?: WorktreeDiffReview | undefined;
}) {
  const styles = useStyles();
  if (state !== "patch" || patch === null) {
    return <Text style={styles.unavailable}>{diffStateMessage(state)}</Text>;
  }
  return <ParsedPatch
    patch={patch}
    mode={mode}
    wrap={wrap}
    preImage={preImage}
    fullFileLoading={fullFileLoading}
    fullFileError={fullFileError}
    review={review}
  />;
}

function ParsedPatch({ patch, mode, wrap, preImage, fullFileLoading, fullFileError, review }: {
  patch: string;
  mode: WorktreeDiffMode;
  wrap: boolean;
  preImage: TaskWorktreePreImageResult | undefined;
  fullFileLoading: boolean;
  fullFileError: string | undefined;
  review: WorktreeDiffReview | undefined;
}) {
  const styles = useStyles();
  const files = useMemo(() => {
    try {
      return parseDiff(patch);
    } catch {
      return [];
    }
  }, [patch]);

  if (files.length === 0) {
    return <Text style={styles.rawPatch}>{patch.slice(0, 12_000)}</Text>;
  }

  if (mode === "fullFile") {
    return <ExpandedFile
      files={files}
      wrap={wrap}
      preImage={preImage}
      loading={fullFileLoading}
      error={fullFileError}
      review={review}
    />;
  }

  const body = (
    <View style={wrap ? styles.patchWrapped : styles.patch}>
      {files.map((file, fileIndex) => <ParsedFile key={`${file.oldPath}:${file.newPath}:${fileIndex}`} file={file} wrap={wrap} review={files.length === 1 ? review : undefined} />)}
    </View>
  );
  return wrap ? body : (
    <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator contentContainerStyle={styles.scrollContent}>
      {body}
    </ScrollView>
  );
}

function ExpandedFile({ files, wrap, preImage, loading, error, review }: {
  files: readonly IFile[];
  wrap: boolean;
  preImage: TaskWorktreePreImageResult | undefined;
  loading: boolean;
  error: string | undefined;
  review: WorktreeDiffReview | undefined;
}) {
  const styles = useStyles();
  if (loading) return <Text style={styles.unavailable}>Loading the full file…</Text>;
  if (error !== undefined) return <Text style={styles.unavailable}>{error}</Text>;
  if (preImage === undefined) return <Text style={styles.unavailable}>The full file is not available yet.</Text>;

  const source = sourceForFullFile(preImage);
  if (source === undefined) return <Text style={styles.unavailable}>{preImageMessage(preImage.state)}</Text>;
  const reconstructed = reconstructFullFile(files, source);
  if (reconstructed.state === "unavailable") {
    return <Text style={styles.unavailable}>Full file unavailable: {reconstructed.reason}</Text>;
  }
  if (reconstructed.lineCount === 0) return <Text style={styles.unavailable}>This file was removed.</Text>;
  const chunks = numberedLineChunks(reconstructed.displayLines);
  const body = (
    <View style={styles.fullFile}>
      {chunks.map((chunk, index) => <FullFileChunk key={index} lines={chunk} review={review} />)}
    </View>
  );
  return (
    <View>
      <Text style={styles.fullFileSummary}>
        {reconstructed.lineCount.toLocaleString()} lines · {reconstructed.changedLineCount.toLocaleString()} changed
      </Text>
      {wrap ? body : (
        <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator contentContainerStyle={styles.scrollContent}>
          {body}
        </ScrollView>
      )}
    </View>
  );
}

function ParsedFile({ file, wrap, review }: { file: IFile; wrap: boolean; review: WorktreeDiffReview | undefined }) {
  const styles = useStyles();
  // Nested code is often indented eight or more columns, which on a phone is a
  // third of the screen spent on whitespace. Drop the indentation every shown
  // line shares; relative structure stays intact.
  const indent = sharedIndent(file);
  return (
    <View>
      {file.hunks.map((hunk, hunkIndex) => {
        const context = hunk.content.replace(/^@@[^@]*@@\s?/, "").trim();
        return (
        <View key={`${hunk.content}:${hunkIndex}`} style={[styles.hunk, hunkIndex === 0 ? null : styles.hunkFollowing]}>
          {context ? <Text style={styles.hunkHeader} numberOfLines={wrap ? 2 : 1}>{context}</Text> : hunkIndex === 0 ? null : <View style={styles.hunkGap} />}
          {hunk.changes.map((change, changeIndex) => (
            <DiffLine key={`${change.oldLineNumber ?? ""}:${change.newLineNumber ?? ""}:${changeIndex}`} change={change} indent={indent} wrap={wrap} review={review} />
          ))}
        </View>
        );
      })}
    </View>
  );
}

function DiffLine({ change, indent, wrap, review }: { change: IChange; indent: number; wrap: boolean; review: WorktreeDiffReview | undefined }) {
  const styles = useStyles();
  const isInsert = change.type === "insert";
  const isDelete = change.type === "delete";
  const line = diffReviewLine(change);
  const noted = line !== undefined && review?.notedLines.has(reviewLineKey(line));
  const commentable = review !== undefined && line !== undefined;
  return (
    <Pressable
      accessibilityRole={commentable ? "button" : undefined}
      accessibilityLabel={commentable ? `${noted ? "Edit feedback on" : "Comment on"} ${line.lineSide} line ${line.lineNumber}` : undefined}
      disabled={!commentable}
      onPress={commentable ? () => review.onSelectLine(line) : undefined}
      style={({ pressed }) => [
        styles.line,
        isInsert ? styles.lineInsert : isDelete ? styles.lineDelete : null,
        noted ? styles.lineNoted : null,
        pressed ? styles.linePressed : null,
      ]}
    >
      <View style={[styles.marker, isInsert ? styles.markerInsert : isDelete ? styles.markerDelete : null, noted ? styles.markerNoted : null]} />
      <Text style={[styles.prefix, isInsert ? styles.insertText : isDelete ? styles.deleteText : null]} accessibilityElementsHidden>
        {isInsert ? "+" : isDelete ? "−" : " "}
      </Text>
      <Text selectable={!commentable} style={[styles.code, wrap ? styles.codeWrapped : null, isDelete ? styles.codeDeleted : null]}>
        {(change.content ?? "").slice(indent)}
      </Text>
      {noted ? <Text style={styles.notedGlyph} accessibilityElementsHidden>●</Text> : null}
    </Pressable>
  );
}

function sharedIndent(file: IFile): number {
  let shared: number | undefined;
  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      const content = change.content ?? "";
      if (content.trim().length === 0) continue;
      const leading = content.length - content.trimStart().length;
      shared = shared === undefined ? leading : Math.min(shared, leading);
      if (shared === 0) return 0;
    }
  }
  return shared ?? 0;
}

function diffStateMessage(state: TaskWorktreeDiffState): string {
  switch (state) {
    case "binary": return "This is a binary file, so no text diff is available.";
    case "truncated": return "This patch is too large to show in full on the phone.";
    case "nonUtf8": return "This file is not UTF-8 text, so its diff is not shown.";
    case "notShown": return "This file has no reviewable text diff.";
    case "patch": return "This patch is unavailable.";
  }
}

function sourceForFullFile(preImage: TaskWorktreePreImageResult): string | undefined {
  // A newly added file has no old-side blob. Its bounded patch contains the
  // source, so applying it to an empty pre-image reconstructs the current file.
  if (preImage.state === "absent") return "";
  return preImage.state === "content" ? preImage.content ?? undefined : undefined;
}

function preImageMessage(state: TaskWorktreePreImageResult["state"]): string {
  switch (state) {
    case "content": return "The full file could not be read.";
    case "absent": return "The full file could not be reconstructed.";
    case "binary": return "This binary file cannot be shown as text.";
    case "notShown": return "This content is outside the mobile review surface.";
    case "truncated": return "This file exceeds the safe full-file limit.";
    case "nonUtf8": return "This file is not UTF-8 text.";
  }
}

type NumberedFullFileLine =
  | { type: "code"; content: string; changed: boolean; number: number }
  | { type: "deleted"; count: number };

function numberedLineChunks(lines: readonly FullFileDisplayLine[]): readonly (readonly NumberedFullFileLine[])[] {
  let number = 0;
  const numbered = lines.map((line): NumberedFullFileLine => line.type === "code"
    ? { ...line, number: ++number }
    : line,
  );
  const chunks: NumberedFullFileLine[][] = [];
  for (let start = 0; start < numbered.length; start += 120) {
    chunks.push(numbered.slice(start, start + 120));
  }
  return chunks;
}

function FullFileChunk({ lines, review }: { lines: readonly NumberedFullFileLine[]; review: WorktreeDiffReview | undefined }) {
  const styles = useStyles();
  return (
    <Text selectable={!review} style={styles.fullFileCode}>
      {lines.map((line, index) => line.type === "code" ? (
        <Text key={index} style={line.changed ? styles.fullFileChanged : undefined}
          accessibilityRole={review ? "button" : undefined}
          accessibilityLabel={review ? `${review.notedLines.has(`new:${line.number}`) ? "Edit feedback on" : "Comment on"} new line ${line.number}` : undefined}
          onPress={review ? () => review.onSelectLine({ lineSide: "new", lineNumber: line.number }) : undefined}>
          {review?.notedLines.has(`new:${line.number}`) ? "● " : ""}{line.content}{"\n"}
        </Text>
      ) : (
        <Text key={index} style={styles.fullFileDeleted}>− {line.count} {line.count === 1 ? "line" : "lines"} removed{"\n"}</Text>
      ))}
    </Text>
  );
}

const codeFont = { fontFamily: fontFamily.mono, fontSize: 12.5, lineHeight: 19 } as const;

const useStyles = createThemedStyles(({ color }) => ({
  unavailable: { color: color.textSecondary, fontSize: 14, lineHeight: 20, padding: space.md },
  scrollContent: { minWidth: "100%" },
  patch: { minWidth: "100%" },
  patchWrapped: { width: "100%" },
  hunk: { backgroundColor: color.bgTerminal, paddingVertical: space.xs },
  hunkFollowing: { borderTopColor: color.border, borderTopWidth: StyleSheet.hairlineWidth },
  hunkGap: { height: space.xs },
  hunkHeader: {
    ...codeFont,
    color: color.accentStrong,
    fontSize: 11.5,
    fontWeight: "600",
    marginBottom: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  line: { flexDirection: "row", alignItems: "flex-start", minWidth: "100%" },
  lineInsert: { backgroundColor: color.successWash },
  lineDelete: { backgroundColor: color.dangerWash },
  lineNoted: { backgroundColor: color.accentWash },
  linePressed: { backgroundColor: color.bgHover },
  marker: { alignSelf: "stretch", width: 3 },
  markerInsert: { backgroundColor: color.success },
  markerDelete: { backgroundColor: color.danger },
  markerNoted: { backgroundColor: color.accentStrong },
  prefix: { ...codeFont, width: 18, color: color.textMuted, fontWeight: "700", textAlign: "center" },
  code: { ...codeFont, color: color.text, paddingRight: space.md },
  codeWrapped: { flex: 1, flexShrink: 1 },
  codeDeleted: { color: color.textSecondary },
  notedGlyph: { ...codeFont, color: color.accentStrong, fontSize: 10, paddingRight: space.sm },
  insertText: { color: color.success },
  deleteText: { color: color.danger },
  rawPatch: { ...codeFont, color: color.text, padding: space.md },
  fullFileSummary: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 11, paddingHorizontal: space.md, paddingTop: space.sm },
  fullFile: { minWidth: "100%", padding: space.md },
  fullFileCode: { ...codeFont, color: color.text },
  fullFileChanged: { backgroundColor: color.successWash, color: color.text },
  fullFileDeleted: { backgroundColor: color.dangerWash, color: color.danger, fontSize: 11.5 },
}));
