import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";

import { StewardVoiceProjectSelector } from "@/components/steward-voice-project-selector";
import { canSwitchVoiceProject } from "@/presentation/steward-voice-project-selection";
import type { VoicePhase } from "@/presentation/steward-voice-presentation";
import { voiceDockWidth } from "@/presentation/steward-voice-presentation";
import { color, radius, space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

export interface StewardVoiceControlsProps {
  readonly active: boolean;
  readonly projects: readonly { id: string; name: string; connectionName: string }[];
  readonly selectedProjectId: string | undefined;
  readonly projectName: string;
  readonly phase: VoicePhase;
  readonly durationMillis: number;
  readonly error: string | undefined;
  readonly draft: string;
  readonly editingDraft: boolean;
  readonly onStart: () => void;
  readonly onClose: () => void;
  readonly onToggleRecording: () => void;
  readonly onSelectProject: (projectId: string) => void;
  readonly onBeginCorrection: () => void;
  readonly onDraftChange: (value: string) => void;
  readonly onCommitDraft: () => void;
}

export function StewardVoiceControls(props: StewardVoiceControlsProps) {
  const { width: viewportWidth } = useWindowDimensions();

  if (!props.active) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Steward'a sesli mesaj gönder"
        accessibilityHint="Ses kaydı ve gönderim ekranını açar"
        onPress={props.onStart}
        style={({ pressed }) => [styles.compactButton, pressed && styles.pressed]}
      >
        <MicrophoneGlyph />
      </Pressable>
    );
  }

  const recordingEnabled = ["ready", "listening", "error"].includes(props.phase);

  return (
    <View style={[styles.shell, { width: voiceDockWidth(viewportWidth) }]}>
      <View style={styles.details}>
        <View style={styles.detailsHeader}>
          <View style={styles.headingZone}>
            <Text style={styles.eyebrow}>STEWARD • SESLİ MESAJ</Text>
            <Text style={styles.title}>Kaydet ve gönder</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Sesli mesajı kapat"
            hitSlop={8}
            onPress={props.onClose}
            style={styles.iconButton}
          >
            <Text style={styles.closeGlyph}>×</Text>
          </Pressable>
        </View>

        <StewardVoiceProjectSelector
          disabled={!canSwitchVoiceProject(props.phase)}
          onSelect={props.onSelectProject}
          projects={props.projects}
          selectedProjectId={props.selectedProjectId}
        />

        {props.phase === "reviewing" ? (
          <View style={styles.reviewCard}>
            <Text style={styles.reviewTitle}>Göndermeden önce kontrol et</Text>
            {props.editingDraft ? (
              <TextInput
                autoFocus
                accessibilityLabel="Düzeltilmiş sesli mesaj metni"
                multiline
                onChangeText={props.onDraftChange}
                selectionColor={color.accentStrong}
                style={styles.draftInput}
                value={props.draft}
              />
            ) : (
              <Text numberOfLines={5} style={styles.draftText}>{props.draft}</Text>
            )}
            <View style={styles.reviewActions}>
              <Pressable
                accessibilityRole="button"
                onPress={props.onBeginCorrection}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
              >
                <Text style={styles.secondaryButtonText}>Düzelt</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Sesli mesajı Steward'a gönder"
                disabled={props.draft.trim().length === 0}
                onPress={props.onCommitDraft}
                style={({ pressed }) => [
                  styles.primaryButton,
                  props.draft.trim().length === 0 && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.primaryButtonText}>Gönder</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {props.phase === "sent" ? (
          <View style={styles.sentCard}>
            <Text style={styles.sentTitle}>Gönderildi</Text>
            <Text style={styles.sentBody}>
              Steward yanıtladığında bildirim göndereceğiz. Bu ekranda beklemene gerek yok.
            </Text>
          </View>
        ) : null}

        {props.phase === "ready" ? (
          <Text style={styles.hint}>Mikrofona dokun, mesajını söyle, metni kontrol edip gönder.</Text>
        ) : null}
        {props.error === undefined ? null : <Text style={styles.error}>{props.error}</Text>}
      </View>

      <View style={styles.bar}>
        <View style={styles.statusZone}>
          <View style={styles.projectLine}>
            <View style={[styles.stateDot, dotStyle(props.phase)]} />
            <Text numberOfLines={1} style={styles.projectName}>{props.projectName}</Text>
          </View>
          <Text numberOfLines={1} style={styles.status}>
            {voiceStatus(props.phase, props.durationMillis)}
          </Text>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.phase === "listening" ? "Kaydı bitir" : "Sesli mesaj kaydet"}
          disabled={!recordingEnabled}
          onPress={props.onToggleRecording}
          style={({ pressed }) => [
            styles.micButton,
            props.phase === "listening" && styles.micButtonActive,
            !recordingEnabled && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          <MicrophoneGlyph active={props.phase === "listening"} />
        </Pressable>
      </View>
    </View>
  );
}

function MicrophoneGlyph({ active = false }: { active?: boolean }) {
  return (
    <View style={styles.mic} accessible={false}>
      <View style={[styles.micCapsule, active && styles.micCapsuleActive]} />
      <View style={styles.micCradle} />
      <View style={styles.micStem} />
    </View>
  );
}

function voiceStatus(phase: VoicePhase, durationMs: number): string {
  switch (phase) {
    case "ready": return "Kayda hazır";
    case "permission": return "Mikrofon hazırlanıyor";
    case "listening": return `Kaydediliyor · ${(Math.max(0, durationMs) / 1_000).toFixed(1)} sn`;
    case "transcribing": return "Yazıya çeviriliyor";
    case "reviewing": return "Göndermeden önce kontrol et";
    case "sending": return "Gönderiliyor";
    case "sent": return "Gönderildi";
    case "error": return "Tekrar kaydetmeye hazır";
  }
}

function dotStyle(phase: VoicePhase) {
  if (phase === "error") return styles.dotDanger;
  if (["permission", "transcribing", "sending"].includes(phase)) return styles.dotWarning;
  if (phase === "listening") return styles.dotRecording;
  if (phase === "sent") return styles.dotSent;
  return styles.dotReady;
}

const styles = StyleSheet.create({
  compactButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.accent,
    borderWidth: 1,
    borderColor: color.accentStrong,
    shadowColor: color.shadow,
    shadowOpacity: 0.34,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 8,
  },
  pressed: { opacity: 0.74, transform: [{ scale: 0.98 }] },
  disabled: { opacity: 0.38 },
  shell: {
    maxWidth: 560,
    borderRadius: radius.sheet,
    borderWidth: 1,
    borderColor: color.borderStrong,
    backgroundColor: color.bgRaised,
    overflow: "hidden",
    shadowColor: color.shadow,
    shadowOpacity: 0.42,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 14,
  },
  details: { padding: space.lg, gap: space.md, borderBottomWidth: 1, borderBottomColor: color.rule },
  detailsHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headingZone: { flex: 1 },
  eyebrow: { color: color.accentStrong, fontFamily: fontFamily.mono, fontSize: 10, fontWeight: "800", letterSpacing: 1.2 },
  title: { color: color.text, fontSize: 17, fontWeight: "700", marginTop: 2 },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  closeGlyph: { color: color.textSecondary, fontSize: 28, lineHeight: 29 },
  reviewCard: { borderRadius: radius.card, padding: space.md, gap: space.sm, backgroundColor: color.accentWash },
  reviewTitle: { color: color.accentStrong, fontFamily: fontFamily.mono, fontSize: 11, fontWeight: "800" },
  draftText: { color: color.text, fontSize: 14, lineHeight: 20 },
  draftInput: {
    minHeight: 62,
    maxHeight: 116,
    color: color.text,
    fontSize: 14,
    lineHeight: 20,
    borderWidth: 1,
    borderColor: color.accentStrong,
    borderRadius: radius.control,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    backgroundColor: color.bgApp,
  },
  reviewActions: { flexDirection: "row", justifyContent: "flex-end", gap: space.sm },
  secondaryButton: { minHeight: 38, justifyContent: "center", paddingHorizontal: 13 },
  secondaryButtonText: { color: color.textSecondary, fontSize: 12, fontWeight: "700" },
  primaryButton: { minHeight: 38, justifyContent: "center", paddingHorizontal: 14, borderRadius: radius.control, backgroundColor: color.accent },
  primaryButtonText: { color: color.onAccent, fontSize: 12, fontWeight: "800" },
  sentCard: { borderRadius: radius.card, padding: space.md, gap: 4, backgroundColor: color.successWash },
  sentTitle: { color: color.success, fontFamily: fontFamily.mono, fontSize: 11, fontWeight: "900" },
  sentBody: { color: color.textSecondary, fontSize: 12, lineHeight: 17 },
  hint: { color: color.textMuted, fontSize: 12, lineHeight: 17 },
  error: { color: color.danger, fontSize: 12, lineHeight: 17 },
  bar: { minHeight: 72, flexDirection: "row", alignItems: "center", padding: 10, gap: 8 },
  statusZone: { flex: 1, minWidth: 0, minHeight: 48, justifyContent: "center", paddingHorizontal: 3 },
  projectLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  stateDot: { width: 7, height: 7, borderRadius: 4 },
  dotReady: { backgroundColor: color.textMuted },
  dotRecording: { backgroundColor: color.danger },
  dotWarning: { backgroundColor: color.warning },
  dotDanger: { backgroundColor: color.danger },
  dotSent: { backgroundColor: color.success },
  projectName: { flexShrink: 1, color: color.text, fontSize: 12, fontWeight: "800" },
  status: { color: color.textSecondary, fontFamily: fontFamily.mono, fontSize: 10, marginTop: 3 },
  micButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.accent,
    borderWidth: 1.5,
    borderColor: color.accentStrong,
  },
  micButtonActive: { backgroundColor: color.danger, borderColor: color.dangerBorder },
  mic: { width: 20, height: 25, alignItems: "center" },
  micCapsule: { width: 9, height: 15, borderRadius: 6, borderWidth: 2, borderColor: color.onAccent },
  micCapsuleActive: { backgroundColor: color.onAccent },
  micCradle: {
    position: "absolute",
    top: 8,
    width: 16,
    height: 11,
    borderBottomWidth: 2,
    borderLeftWidth: 2,
    borderRightWidth: 2,
    borderColor: color.onAccent,
    borderBottomLeftRadius: 9,
    borderBottomRightRadius: 9,
  },
  micStem: { width: 2, height: 5, marginTop: 18, backgroundColor: color.onAccent },
});
