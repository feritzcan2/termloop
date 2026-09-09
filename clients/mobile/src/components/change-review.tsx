import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { ChangeReview } from "@/features/changes/use-change-review";
import { MAX_REVIEW_NOTE_CHARS } from "@/presentation/change-review-notes";
import { sessionLabel } from "@/presentation/dto-readers";
import { color, geometry, radius, space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";
import { Banner, Card, EmptyState, PrimaryButton, SecondaryButton, SectionHeader } from "./primitives";

export function ChangeReviewEditor({ review }: { review: ChangeReview }) {
  const note = review.draft;
  if (!note) return null;
  return (
    <View style={styles.editor}>
      <Text style={styles.path} numberOfLines={2}>{note.displayPath}:{note.lineNumber} ({note.lineSide})</Text>
      <TextInput
        key={note.key}
        accessibilityLabel={`Feedback on ${note.lineSide} line ${note.lineNumber}`}
        autoFocus multiline maxLength={MAX_REVIEW_NOTE_CHARS}
        placeholder="Write feedback for this line…" placeholderTextColor={color.textMuted}
        value={note.body} onChangeText={review.updateDraft} style={styles.input}
        editable={!review.sending} textAlignVertical="top"
      />
      <View style={styles.actions}>
        <Text style={styles.hint}>{note.body.length}/{MAX_REVIEW_NOTE_CHARS}{note.body.trim() ? " · Added to batch" : ""}</Text>
        <SecondaryButton label="Remove" onPress={() => review.remove(note.key)} />
        <SecondaryButton label="Done" onPress={review.finishDraft} />
      </View>
    </View>
  );
}

export function ChangeReviewPanel({ review, observationId, onBackToDiff }: {
  review: ChangeReview;
  observationId: string | undefined;
  onBackToDiff?: (() => void) | undefined;
}) {
  const [preview, setPreview] = useState(false);
  return (
    <ScrollView contentContainerStyle={styles.panel} keyboardShouldPersistTaps="handled">
      {onBackToDiff ? <SecondaryButton label="Back to diff" onPress={onBackToDiff} /> : null}
      {review.sent ? <Banner kind="info" message="Feedback sent to the agent." /> : null}
      {review.notes.length === 0 ? <EmptyState title="No pending feedback" body="Tap + beside a line in Diff or Full file to add feedback. Comments stay here while you review other files." /> : (
        <>
          <SectionHeader label={`${review.notes.length} pending comments`} />
          {review.notes.map((note) => (
            <Card key={note.key} style={styles.note}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Edit feedback on ${note.displayPath}, ${note.lineSide} line ${note.lineNumber}`}
                disabled={review.sending} onPress={() => review.edit(note)} style={styles.noteBody}>
                <Text style={styles.path}>{note.displayPath}:{note.lineNumber} ({note.lineSide})</Text>
                <Text style={styles.hint}>{note.side}{note.observationId !== observationId ? " · Earlier snapshot" : ""}</Text>
                <Text style={styles.body}>{note.body}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={`Remove feedback on ${note.displayPath}, ${note.lineSide} line ${note.lineNumber}`}
                disabled={review.sending} onPress={() => review.remove(note.key)} style={styles.remove}>
                <Text style={styles.removeText}>Remove</Text>
              </Pressable>
            </Card>
          ))}
          <SectionHeader label="Send to agent" />
          {review.agents.length === 0 ? <Text style={styles.body}>No active agent in this Task. Your comments are kept here.</Text> : review.agents.map((session) => (
            <Pressable key={session.id} accessibilityRole="radio" accessibilityState={{ checked: review.target?.id === session.id, disabled: review.sending }}
              disabled={review.sending} onPress={() => review.setTargetId(session.id)} style={[styles.agent, review.target?.id === session.id ? styles.agentSelected : null]}>
              <Text style={styles.body}>{review.target?.id === session.id ? "●" : "○"} {sessionLabel(session)}{review.agents.length > 1 ? ` · ${session.id.slice(0, 6)}` : ""}</Text>
            </Pressable>
          ))}
          <SecondaryButton label={preview ? "Hide message preview" : "Preview message"} onPress={() => setPreview((current) => !current)} />
          {preview ? <Text selectable style={styles.preview}>{review.message}</Text> : null}
          {review.tooLarge ? <Banner kind="warning" message="Feedback exceeds the 64 KiB limit. Shorten or remove a comment before sending." /> : null}
          <PrimaryButton label={review.sending ? "Sending…" : `Send ${review.notes.length} ${review.notes.length === 1 ? "comment" : "comments"}`}
            disabled={review.sending || !review.target || review.tooLarge} busy={review.sending} onPress={() => void review.send()} />
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  panel: { padding: space.md, gap: space.md },
  editor: { padding: space.md, gap: space.sm, borderTopColor: color.rule, borderTopWidth: StyleSheet.hairlineWidth },
  input: { color: color.text, backgroundColor: color.bgRaised, borderColor: color.border, borderWidth: 1, borderRadius: radius.control, minHeight: 88, maxHeight: 150, padding: space.sm, fontSize: 14 },
  actions: { flexDirection: "row", alignItems: "center", gap: space.sm },
  path: { color: color.text, fontFamily: fontFamily.mono, fontSize: 12, lineHeight: 18 },
  hint: { color: color.textMuted, fontSize: 11, flexShrink: 1 },
  body: { color: color.textSecondary, fontSize: 14, lineHeight: 20 },
  note: { padding: space.sm },
  noteBody: { gap: space.sm, minHeight: geometry.touchTarget },
  remove: { alignSelf: "flex-end", minHeight: geometry.touchTarget, justifyContent: "center", paddingHorizontal: space.sm },
  removeText: { color: color.danger, fontSize: 12 },
  agent: { minHeight: geometry.touchTarget, justifyContent: "center", padding: space.sm, borderRadius: radius.control },
  agentSelected: { backgroundColor: color.accentWash },
  preview: { color: color.textSecondary, fontFamily: fontFamily.mono, fontSize: 12, lineHeight: 18 },
});
