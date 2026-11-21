import type { TaskWorktreeChangeKind } from "@termloop/contract/current";
import { Text, View } from "react-native";

import { createThemedStyles, useTheme } from "@/theme/context";
import { fontFamily } from "@/theme/typography";

export function KindBadge({ kind }: { kind: TaskWorktreeChangeKind }) {
  const styles = useStyles();
  const { color } = useTheme();
  const tint = kindColor(kind, color);
  return (
    <View style={[styles.badge, { borderColor: tint }]} accessibilityElementsHidden>
      <Text style={[styles.glyph, { color: tint }]}>{kindGlyph(kind)}</Text>
    </View>
  );
}

export function kindLabel(kind: TaskWorktreeChangeKind): string {
  return kind === "untracked" ? "new" : kind;
}

// The generated reader tolerates unknown enum values, so every switch keeps a
// neutral fallback for a kind a newer Mac may report.
function kindColor(kind: TaskWorktreeChangeKind, color: ReturnType<typeof useTheme>["color"]): string {
  switch (kind) {
    case "added":
    case "untracked": return color.success;
    case "deleted": return color.danger;
    case "unmerged": return color.warning;
    default: return color.accentStrong;
  }
}

function kindGlyph(kind: TaskWorktreeChangeKind): string {
  switch (kind) {
    case "added":
    case "untracked": return "A";
    case "deleted": return "D";
    case "renamed": return "R";
    case "copied": return "C";
    case "unmerged": return "!";
    default: return "M";
  }
}

const useStyles = createThemedStyles(() => ({
  badge: { alignItems: "center", borderRadius: 6, borderWidth: 1.5, height: 24, justifyContent: "center", width: 24 },
  glyph: { fontFamily: fontFamily.mono, fontSize: 12, fontWeight: "800" },
}));
