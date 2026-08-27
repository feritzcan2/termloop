import { StyleSheet, Text, View } from "react-native";

import { color, radius } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

export function AgentAvatar({ agentId, active }: {
  agentId: string | null;
  active: boolean;
}) {
  const claude = agentId === "claude";
  const label = claude ? "C" : agentId === "codex" ? "CX" : "A";
  const tint = claude ? color.agentClaude : agentId === "codex" ? color.agentCodex : color.accentStrong;
  return (
    <View
      accessibilityElementsHidden
      style={[
        styles.avatar,
        { borderColor: tint, backgroundColor: `${tint}${active ? "2E" : "18"}` },
      ]}
    >
      <Text style={[styles.label, { color: tint }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: radius.control,
  },
  label: { fontFamily: fontFamily.mono, fontSize: 10, fontWeight: "800" },
});
