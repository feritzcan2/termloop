import { parseDiff, type IChange, type IFile } from "react-native-diff-view";
import { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import type { TaskWorktreeDiffState, TaskWorktreePreImageResult } from "@termloop/contract/current";
import { reconstructFullFile, type FullFileDisplayLine } from "@/presentation/worktree-full-file";
import { color, radius, space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

/// `react-native-diff-view` owns the unified-patch parser. Its stock renderer
/// still carries a light, fixed palette, so this small native renderer consumes
/// its typed hunk model and keeps the resulting review surface in TermLoop's
/// own accessible dark theme.
export type WorktreeDiffMode = "diff" | "fullFile";

export function WorktreeDiff({ state, patch, mode = "diff", preImage, fullFileLoading = false, fullFileError }: {
  state: TaskWorktreeDiffState;
  patch: string | null;
  mode?: WorktreeDiffMode | undefined;
  preImage?: TaskWorktreePreImageResult | undefined;
  fullFileLoading?: boolean | undefined;
  fullFileError?: string | undefined;
}) {
  if (state !== "patch" || patch === null) {
    return <Text style={styles.unavailable}>{diffStateMessage(state)}</Text>;
  }
  return <ParsedPatch
    patch={patch}
    mode={mode}
    preImage={preImage}
    fullFileLoading={fullFileLoading}
    fullFileError={fullFileError}
  />;
}

function ParsedPatch({ patch, mode, preImage, fullFileLoading, fullFileError }: {
  patch: string;
  mode: WorktreeDiffMode;
  preImage: TaskWorktreePreImageResult | undefined;
  fullFileLoading: boolean;
  fullFileError: string | undefined;
}) {
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
      preImage={preImage}
      loading={fullFileLoading}
      error={fullFileError}
    />;
  }

  return (
    <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator contentContainerStyle={styles.scrollContent}>
      <View style={styles.patch}>
        {files.map((file, fileIndex) => <ParsedFile key={`${file.oldPath}:${file.newPath}:${fileIndex}`} file={file} />)}
      </View>
    </ScrollView>
  );
}

function ExpandedFile({ files, preImage, loading, error }: {
  files: readonly IFile[];
  preImage: TaskWorktreePreImageResult | undefined;
  loading: boolean;
  error: string | undefined;
}) {
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
  return (
    <View>
      <Text style={styles.fullFileSummary}>
        {reconstructed.lineCount.toLocaleString()} lines · {reconstructed.changedLineCount.toLocaleString()} changed
      </Text>
      <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator contentContainerStyle={styles.scrollContent}>
        <View style={styles.fullFile}>
          {chunks.map((chunk, index) => <FullFileChunk key={index} lines={chunk} />)}
        </View>
      </ScrollView>
    </View>
  );
}

function ParsedFile({ file }: { file: IFile }) {
  return (
    <View style={styles.file}>
      {file.hunks.map((hunk, hunkIndex) => (
        <View key={`${hunk.content}:${hunkIndex}`} style={styles.hunk}>
          <Text style={styles.hunkHeader}>{hunk.content}</Text>
          {hunk.changes.map((change, changeIndex) => (
            <DiffLine key={`${change.oldLineNumber ?? ""}:${change.newLineNumber ?? ""}:${changeIndex}`} change={change} />
          ))}
        </View>
      ))}
    </View>
  );
}

function DiffLine({ change }: { change: IChange }) {
  const isInsert = change.type === "insert";
  const isDelete = change.type === "delete";
  const oldLine = change.oldLineNumber ?? (isDelete ? change.lineNumber : undefined);
  const newLine = change.newLineNumber ?? (isInsert ? change.lineNumber : undefined);
  return (
    <View style={[styles.line, isInsert ? styles.lineInsert : null, isDelete ? styles.lineDelete : null]}>
      <Text style={styles.lineNumber}>{oldLine ?? ""}</Text>
      <Text style={styles.lineNumber}>{newLine ?? ""}</Text>
      <Text style={[styles.prefix, isInsert ? styles.insertText : isDelete ? styles.deleteText : null]}>
        {isInsert ? "+" : isDelete ? "−" : " "}
      </Text>
      <Text selectable style={[styles.code, isInsert ? styles.insertText : isDelete ? styles.deleteText : null]}>
        {change.content ?? ""}
      </Text>
    </View>
  );
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
  const width = String(lines.filter((line) => line.type === "code").length).length;
  let number = 0;
  const numbered = lines.map((line): NumberedFullFileLine => line.type === "code"
    ? { ...line, number: ++number }
    : line,
  );
  const chunks: NumberedFullFileLine[][] = [];
  for (let start = 0; start < numbered.length; start += 120) {
    chunks.push(numbered.slice(start, start + 120));
  }
  return chunks.map((chunk) => chunk.map((line) => line.type === "code"
    ? { ...line, content: `${String(line.number).padStart(width, " ")}  ${line.content}` }
    : line));
}

function FullFileChunk({ lines }: { lines: readonly NumberedFullFileLine[] }) {
  return (
    <Text selectable style={styles.fullFileCode}>
      {lines.map((line, index) => line.type === "code" ? (
        <Text key={index} style={line.changed ? styles.fullFileChanged : undefined}>{line.content}{"\n"}</Text>
      ) : (
        <Text key={index} style={styles.fullFileDeleted}>    − {line.count} {line.count === 1 ? "line" : "lines"} removed{"\n"}</Text>
      ))}
    </Text>
  );
}

const styles = StyleSheet.create({
  unavailable: { color: color.textSecondary, fontSize: 13, lineHeight: 19, padding: space.md },
  scrollContent: { minWidth: "100%" },
  patch: { minWidth: "100%" },
  file: { gap: space.md },
  hunk: { overflow: "hidden", borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth, borderColor: color.border },
  hunkHeader: {
    color: color.accentStrong,
    backgroundColor: color.accentWash,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    lineHeight: 17,
    paddingHorizontal: space.sm,
    paddingVertical: 5,
  },
  line: { flexDirection: "row", alignItems: "stretch", backgroundColor: color.bgTerminal, minWidth: "100%" },
  lineInsert: { backgroundColor: "rgba(76, 201, 138, 0.13)" },
  lineDelete: { backgroundColor: "rgba(239, 124, 130, 0.13)" },
  lineNumber: {
    width: 34,
    color: color.textMuted,
    fontFamily: fontFamily.mono,
    fontSize: 10.5,
    lineHeight: 18,
    paddingHorizontal: 4,
    textAlign: "right",
  },
  prefix: { width: 17, color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 12, lineHeight: 18, textAlign: "center" },
  code: { color: color.textSecondary, fontFamily: fontFamily.mono, fontSize: 11.5, lineHeight: 18, paddingRight: space.sm },
  insertText: { color: "#a6e8c0" },
  deleteText: { color: "#ffb6ba" },
  rawPatch: { color: color.textSecondary, fontFamily: fontFamily.mono, fontSize: 11.5, lineHeight: 18, padding: space.md },
  fullFileSummary: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 10.5, paddingHorizontal: space.md, paddingTop: space.sm },
  fullFile: { gap: 0, minWidth: "100%", padding: space.md },
  fullFileCode: { color: color.textSecondary, fontFamily: fontFamily.mono, fontSize: 11.5, lineHeight: 18 },
  fullFileChanged: { backgroundColor: "rgba(76, 201, 138, 0.18)", color: "#b9f0d0" },
  fullFileDeleted: { backgroundColor: "rgba(239, 124, 130, 0.16)", color: "#ffb6ba" },
});
