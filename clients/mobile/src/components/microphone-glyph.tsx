import { StyleSheet, View } from "react-native";

import { color } from "@/theme/tokens";

export function MicrophoneGlyph({ active = false }: { active?: boolean }) {
  return (
    <View style={styles.mic} accessible={false}>
      <View style={[styles.capsule, active && styles.capsuleActive]} />
      <View style={styles.cradle} />
      <View style={styles.stem} />
    </View>
  );
}

const styles = StyleSheet.create({
  mic: { width: 20, height: 25, alignItems: "center" },
  capsule: { width: 9, height: 15, borderRadius: 6, borderWidth: 2, borderColor: color.onAccent },
  capsuleActive: { backgroundColor: color.onAccent },
  cradle: {
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
  stem: { width: 2, height: 5, marginTop: 18, backgroundColor: color.onAccent },
});
