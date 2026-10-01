import { Pressable, Text, View } from "react-native";

import { createThemedStyles, useTheme } from "@/theme/context";
import { useAppearance } from "@/theme/provider";
import { geometry, radius, space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

export function AppearanceSelector() {
  const { mode } = useTheme();
  const { setMode } = useAppearance();
  const styles = useStyles();
  return (
    <View style={styles.row}>
      <View style={styles.identity}>
        <Text style={styles.label}>Görünüm</Text>
        <Text style={styles.detail}>{mode === "dark" ? "Ghostty" : "Light"}</Text>
      </View>
      <View style={styles.options} accessibilityRole="radiogroup" accessibilityLabel="Görünüm">
        {(["light", "dark"] as const).map((option) => (
          <Pressable
            key={option}
            accessibilityRole="radio"
            accessibilityLabel={option === "light" ? "Light" : "Dark — Ghostty"}
            accessibilityState={{ checked: mode === option }}
            onPress={() => { void setMode(option); }}
            style={[styles.option, mode === option && styles.selected]}
          >
            <Text style={[styles.optionLabel, mode === option && styles.selectedLabel]}>
              {option === "light" ? "Light" : "Dark"}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const useStyles = createThemedStyles(({ color }) => ({
  row: { flexDirection: "row", alignItems: "center", gap: space.md },
  identity: { flex: 1, gap: 3 },
  label: { color: color.text, fontFamily: fontFamily.mono, fontSize: 12, fontWeight: "600" },
  detail: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 11 },
  options: { flexDirection: "row", padding: 3, gap: 3, borderRadius: radius.control, backgroundColor: color.bgSidebar },
  option: { minHeight: geometry.touchTarget, minWidth: 66, paddingHorizontal: space.md, alignItems: "center", justifyContent: "center", borderRadius: 6 },
  selected: { backgroundColor: color.accent },
  optionLabel: { color: color.textSecondary, fontFamily: fontFamily.mono, fontSize: 12, fontWeight: "600" },
  selectedLabel: { color: color.onAccent },
}));
