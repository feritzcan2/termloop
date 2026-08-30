import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";

import type {
  VoiceMode,
  VoicePhase,
  VoiceTurn,
} from "@/presentation/steward-voice-presentation";
import { voiceDetailsMaxHeight } from "@/presentation/steward-voice-presentation";
import { color, radius, space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

export interface StewardVoiceControlsProps {
  readonly active: boolean;
  readonly expanded: boolean;
  readonly projectName: string;
  readonly phase: VoicePhase;
  readonly durationMillis: number;
  readonly microphoneEnabled: boolean;
  readonly mode: VoiceMode;
  readonly unreadCount: number;
  readonly error: string | undefined;
  readonly turns: readonly VoiceTurn[];
  readonly draft: string;
  readonly editingDraft: boolean;
  readonly autoSendSeconds: number | null;
  readonly canReplay: boolean;
  readonly onStart: () => void;
  readonly onToggleExpanded: () => void;
  readonly onEnd: () => void;
  readonly onToggleMicrophone: () => void;
  readonly onReplay: () => void;
  readonly onModeChange: (mode: VoiceMode) => void;
  readonly onBeginCorrection: () => void;
  readonly onDraftChange: (value: string) => void;
  readonly onCommitDraft: () => void;
}

export function StewardVoiceControls(props: StewardVoiceControlsProps) {
  const { height: viewportHeight } = useWindowDimensions();

  if (!props.active) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Steward'la konuş"
        accessibilityHint="Mevcut projede tek konuşmalık Steward ses oturumunu başlatır"
        onPress={props.onStart}
        style={({ pressed }) => [styles.compactButton, pressed && styles.pressed]}
      >
        <MicrophoneGlyph />
        <View style={styles.liveDot} />
      </Pressable>
    );
  }

  const recentTurns = props.turns.slice(-3);
  const microphoneDisabled = ["connecting", "permission", "transcribing", "sending"].includes(props.phase);

  return (
    <View style={styles.shell}>
      {props.expanded ? (
        <ScrollView
          contentContainerStyle={styles.details}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          style={[styles.detailsViewport, { maxHeight: voiceDetailsMaxHeight(viewportHeight) }]}
        >
          <View style={styles.detailsHeader}>
            <View style={styles.headingZone}>
              <Text style={styles.eyebrow}>STEWARD • CANLI</Text>
              <Text style={styles.title}>Konuşma ayrıntıları</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Ayrıntıları kapat"
              hitSlop={8}
              onPress={props.onToggleExpanded}
              style={styles.iconButton}
            >
              <Text style={styles.chevron}>⌄</Text>
            </Pressable>
          </View>

          <View style={styles.modeRow}>
            <ModeButton
              active={props.mode === "single"}
              label="Tek konuşma"
              onPress={() => props.onModeChange("single")}
            />
            <ModeButton
              active={props.mode === "handsFree"}
              label="Sürekli"
              onPress={() => props.onModeChange("handsFree")}
            />
          </View>
          <Text style={styles.modeHint}>
            {props.mode === "single"
              ? "Bir kez dinler, cevabı okur ve mikrofon kapalı bekler."
              : "Yanıt bittikten sonra mikrofon yeniden dinlemeye başlar."}
          </Text>

          {props.phase === "reviewing" ? (
            <View style={styles.reviewCard}>
              <Text style={styles.reviewTitle}>Göndermeden önce kontrol et</Text>
              {props.editingDraft ? (
                <TextInput
                  autoFocus
                  accessibilityLabel="Düzeltilmiş konuşma metni"
                  multiline
                  onChangeText={props.onDraftChange}
                  selectionColor={color.accentStrong}
                  style={styles.draftInput}
                  value={props.draft}
                />
              ) : (
                <Text numberOfLines={4} style={styles.draftText}>{props.draft}</Text>
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
                  disabled={props.draft.trim().length === 0}
                  onPress={props.onCommitDraft}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    props.draft.trim().length === 0 && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.primaryButtonText}>
                    {props.editingDraft || props.autoSendSeconds === null
                      ? "Gönder"
                      : `${props.autoSendSeconds} sn · Gönder`}
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          {recentTurns.length === 0 ? (
            <Text style={styles.emptyTurns}>Henüz bu oturumda bir konuşma yok.</Text>
          ) : (
            <View style={styles.turns}>
              {recentTurns.map((turn) => (
                <View key={turn.id} style={styles.turn}>
                  <View style={styles.turnHeading}>
                    <Text style={styles.turnAuthor}>Sen</Text>
                    <Text style={styles.turnStatus}>{turnStatus(turn)}</Text>
                  </View>
                  <Text numberOfLines={2} style={styles.turnText}>{turn.transcript}</Text>
                  {turn.reply === null ? null : (
                    <Text numberOfLines={3} style={styles.replyText}>
                      <Text style={styles.replyAuthor}>Steward  </Text>{turn.reply.content}
                    </Text>
                  )}
                </View>
              ))}
            </View>
          )}

          {props.error === undefined ? null : <Text style={styles.error}>{props.error}</Text>}
        </ScrollView>
      ) : null}

      <View style={styles.bar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Canlı konuşma ayrıntıları"
          onPress={props.onToggleExpanded}
          style={({ pressed }) => [styles.statusZone, pressed && styles.pressed]}
        >
          <View style={styles.projectLine}>
            <View style={[styles.stateDot, dotStyle(props.phase)]} />
            <Text numberOfLines={1} style={styles.projectName}>{props.projectName}</Text>
            {props.unreadCount > 0 ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{props.unreadCount}</Text>
              </View>
            ) : null}
          </View>
          <Text numberOfLines={1} style={styles.status}>
            {voiceStatus(props.phase, props.durationMillis)}
          </Text>
        </Pressable>

        <SmallButton
          accessibilityLabel="Son cevabı tekrar oynat"
          disabled={!props.canReplay}
          label="↻"
          onPress={props.onReplay}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.microphoneEnabled ? "Mikrofonu kapat" : "Mikrofonu aç"}
          disabled={microphoneDisabled}
          onPress={props.onToggleMicrophone}
          style={({ pressed }) => [
            styles.micButton,
            props.microphoneEnabled && styles.micButtonActive,
            microphoneDisabled && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          <MicrophoneGlyph active={props.microphoneEnabled} muted={!props.microphoneEnabled} />
        </Pressable>
        <SmallButton accessibilityLabel="Canlı konuşmayı kapat" label="×" onPress={props.onEnd} />
      </View>
    </View>
  );
}

function ModeButton({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [styles.modeButton, active && styles.modeButtonActive, pressed && styles.pressed]}
    >
      <Text style={[styles.modeButtonText, active && styles.modeButtonTextActive]}>{label}</Text>
    </Pressable>
  );
}

function SmallButton({
  accessibilityLabel,
  disabled = false,
  label,
  onPress,
}: {
  accessibilityLabel: string;
  disabled?: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.smallButton, disabled && styles.disabled, pressed && styles.pressed]}
    >
      <Text style={styles.smallButtonText}>{label}</Text>
    </Pressable>
  );
}

function MicrophoneGlyph({ active = false, muted = false }: { active?: boolean; muted?: boolean }) {
  return (
    <View style={styles.mic} accessible={false}>
      <View style={[styles.micCapsule, active && styles.micCapsuleActive]} />
      <View style={styles.micCradle} />
      <View style={styles.micStem} />
      {muted ? <View style={styles.micMutedSlash} /> : null}
    </View>
  );
}

function voiceStatus(phase: VoicePhase, durationMs: number): string {
  switch (phase) {
    case "connecting": return "Mac’e bağlanıyor";
    case "ready": return "Hazır · mikrofon kapalı";
    case "permission": return "Mikrofon hazırlanıyor";
    case "listening": return `Dinliyor · ${(Math.max(0, durationMs) / 1_000).toFixed(1)} sn`;
    case "transcribing": return "Yazıya çeviriyor";
    case "reviewing": return "Metni kontrol et";
    case "sending": return "Gönderiliyor";
    case "thinking": return "Steward düşünüyor";
    case "speaking": return "Steward konuşuyor";
    case "reconnecting": return "Mac’e yeniden ulaşılıyor";
    case "offline": return "Mac’e ulaşılamıyor";
    case "error": return "Tekrar denemeye hazır";
  }
}

function turnStatus(turn: VoiceTurn): string {
  switch (turn.status) {
    case "received": return "alındı";
    case "sent": return "gönderiliyor";
    case "thinking": return "Steward düşünüyor";
    case "answered": return "cevap geldi";
    case "speaking": return "seslendiriliyor";
    case "spoken": return "okundu";
    case "failed": return "tamamlanamadı";
  }
}

function dotStyle(phase: VoicePhase) {
  if (["offline", "error"].includes(phase)) return styles.dotDanger;
  if (["reconnecting", "connecting"].includes(phase)) return styles.dotWarning;
  if (["listening", "speaking"].includes(phase)) return styles.dotLive;
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
    shadowColor: "#000",
    shadowOpacity: 0.34,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 8,
  },
  pressed: { opacity: 0.74, transform: [{ scale: 0.98 }] },
  disabled: { opacity: 0.38 },
  liveDot: {
    position: "absolute", right: 4, top: 4, width: 9, height: 9, borderRadius: 5,
    backgroundColor: color.success, borderWidth: 1.5, borderColor: color.bgApp,
  },
  shell: {
    width: "100%",
    maxWidth: 560,
    borderRadius: radius.sheet,
    borderWidth: 1,
    borderColor: color.borderStrong,
    backgroundColor: color.bgRaised,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.42,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 14,
  },
  detailsViewport: { borderBottomWidth: 1, borderBottomColor: color.rule },
  details: { padding: space.lg, gap: space.md },
  detailsHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headingZone: { flex: 1 },
  eyebrow: { color: color.success, fontFamily: fontFamily.mono, fontSize: 10, fontWeight: "800", letterSpacing: 1.2 },
  title: { color: color.text, fontSize: 17, fontWeight: "700", marginTop: 2 },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  chevron: { color: color.textSecondary, fontSize: 27, lineHeight: 28 },
  modeRow: { flexDirection: "row", gap: space.sm },
  modeButton: {
    minHeight: 38, justifyContent: "center", paddingHorizontal: 13, borderRadius: radius.pill,
    borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.bgApp,
  },
  modeButtonActive: { borderColor: color.accentStrong, backgroundColor: color.accentWash },
  modeButtonText: { color: color.textSecondary, fontSize: 12, fontWeight: "700" },
  modeButtonTextActive: { color: color.accentStrong },
  modeHint: { color: color.textMuted, fontSize: 11, lineHeight: 15 },
  reviewCard: { borderRadius: radius.card, padding: space.md, gap: space.sm, backgroundColor: color.accentWash },
  reviewTitle: { color: color.accentStrong, fontFamily: fontFamily.mono, fontSize: 11, fontWeight: "800" },
  draftText: { color: color.text, fontSize: 14, lineHeight: 20 },
  draftInput: {
    minHeight: 62, maxHeight: 116, color: color.text, fontSize: 14, lineHeight: 20,
    borderWidth: 1, borderColor: color.accentStrong, borderRadius: radius.control,
    paddingHorizontal: space.sm, paddingVertical: space.sm, backgroundColor: color.bgApp,
  },
  reviewActions: { flexDirection: "row", justifyContent: "flex-end", gap: space.sm },
  secondaryButton: { minHeight: 38, justifyContent: "center", paddingHorizontal: 13 },
  secondaryButtonText: { color: color.textSecondary, fontSize: 12, fontWeight: "700" },
  primaryButton: { minHeight: 38, justifyContent: "center", paddingHorizontal: 14, borderRadius: radius.control, backgroundColor: color.accent },
  primaryButtonText: { color: color.onAccent, fontSize: 12, fontWeight: "800" },
  emptyTurns: { color: color.textMuted, fontSize: 12, paddingVertical: space.sm },
  turns: { gap: space.sm },
  turn: { gap: 3, paddingTop: space.xs },
  turnHeading: { flexDirection: "row", justifyContent: "space-between", gap: space.sm },
  turnAuthor: { color: color.text, fontSize: 11, fontWeight: "800" },
  turnStatus: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 10 },
  turnText: { color: color.textSecondary, fontSize: 13, lineHeight: 18 },
  replyText: { color: color.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 3 },
  replyAuthor: { color: color.accentStrong, fontWeight: "800" },
  error: { color: color.danger, fontSize: 12, lineHeight: 17 },
  bar: { minHeight: 72, flexDirection: "row", alignItems: "center", padding: 10, gap: 6 },
  statusZone: { flex: 1, minWidth: 0, minHeight: 48, justifyContent: "center", paddingHorizontal: 3 },
  projectLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  stateDot: { width: 7, height: 7, borderRadius: 4 },
  dotReady: { backgroundColor: color.textMuted },
  dotLive: { backgroundColor: color.success },
  dotWarning: { backgroundColor: color.warning },
  dotDanger: { backgroundColor: color.danger },
  projectName: { flexShrink: 1, color: color.text, fontSize: 12, fontWeight: "800" },
  badge: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: "center", justifyContent: "center", backgroundColor: color.danger },
  badgeText: { color: color.onAccent, fontFamily: fontFamily.mono, fontSize: 9, fontWeight: "900" },
  status: { color: color.textSecondary, fontFamily: fontFamily.mono, fontSize: 10, marginTop: 3 },
  smallButton: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: color.bgApp },
  smallButtonText: { color: color.textSecondary, fontSize: 24, lineHeight: 25 },
  micButton: {
    width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center",
    backgroundColor: color.bgApp, borderWidth: 1.5, borderColor: color.borderStrong,
  },
  micButtonActive: { backgroundColor: color.danger, borderColor: "#ff9aa2" },
  mic: { width: 20, height: 25, alignItems: "center" },
  micCapsule: { width: 9, height: 15, borderRadius: 6, borderWidth: 2, borderColor: color.onAccent },
  micCapsuleActive: { backgroundColor: color.onAccent },
  micCradle: {
    position: "absolute", top: 8, width: 16, height: 11,
    borderLeftWidth: 2, borderRightWidth: 2, borderBottomWidth: 2, borderColor: color.onAccent,
    borderBottomLeftRadius: 9, borderBottomRightRadius: 9,
  },
  micStem: { width: 2, height: 5, backgroundColor: color.onAccent },
  micMutedSlash: {
    position: "absolute", top: 1, width: 2, height: 25, borderRadius: 1,
    backgroundColor: color.danger, transform: [{ rotate: "-42deg" }],
  },
});
