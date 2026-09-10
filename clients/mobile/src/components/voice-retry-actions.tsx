import { Pressable, StyleSheet, Text, View } from "react-native";
import { color, geometry, radius, space } from "../theme/tokens";

export function VoiceRetryActions({ retryable, busy, recordingSaved, onRetry, onCancel }: {
  retryable: boolean;
  busy: boolean;
  recordingSaved: boolean;
  onRetry(): void;
  onCancel(): void;
}) {
  return <View style={styles.container}>
    {recordingSaved ? <Text style={styles.hint}>Kaydın saklandı.</Text> : null}
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" accessibilityLabel="Ses kaydını iptal et" onPress={onCancel} style={styles.cancel}>
        <Text style={styles.cancelText}>İptal</Text>
      </Pressable>
      {!retryable || busy ? null : <Pressable accessibilityRole="button" accessibilityLabel={recordingSaved ? "Aynı ses kaydını tekrar dene" : "Mikrofonu tekrar başlat"} onPress={onRetry} style={styles.retry}>
        <Text style={styles.retryText}>Tekrar dene</Text>
      </Pressable>}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  container: { gap: space.xs },
  hint: { color: color.textSecondary, fontSize: 12, lineHeight: 17 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: space.sm },
  cancel: { minHeight: geometry.touchTarget, paddingHorizontal: space.sm, justifyContent: "center" },
  cancelText: { color: color.textSecondary, fontSize: 12, fontWeight: "600" },
  retry: { minHeight: geometry.touchTarget, paddingHorizontal: space.md, justifyContent: "center", borderRadius: radius.control, backgroundColor: color.accent },
  retryText: { color: color.onAccent, fontSize: 12, fontWeight: "700" },
});
