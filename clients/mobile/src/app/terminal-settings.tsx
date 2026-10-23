import { useTheme, createThemedStyles } from "@/theme/context";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";

import { Card, CardDivider, PrimaryButton, SectionHeader } from "@/components/primitives";
import { Screen, ScreenHeader } from "@/components/screen";
import { useTerminalPreferences, useTerminalPreferencesStore } from "@/features/terminal/terminal-preferences";
import {
  MAX_CUSTOM_KEYS,
  MAX_CUSTOM_KEY_LABEL,
  MAX_CUSTOM_KEY_SEQUENCE,
  customKeyProblem,
  newLocalId,
  type CustomTerminalKey,
} from "@/features/terminal/terminal-preferences-store";
import { geometry, radius, space, terminalGeometry } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

/// How this phone types into a terminal. Nothing here reaches the Mac.
export default function TerminalSettingsRoute() {
  const { color } = useTheme();
  const styles = useStyles();
  const preferences = useTerminalPreferences();
  const store = useTerminalPreferencesStore();
  const [editing, setEditing] = useState<CustomTerminalKey | undefined>(undefined);
  const [label, setLabel] = useState("");
  const [sequence, setSequence] = useState("");

  const edit = (key: CustomTerminalKey | undefined) => {
    const target = key ?? { id: newLocalId(), label: "", sequence: "" };
    setEditing(target);
    setLabel(target.label);
    setSequence(target.sequence);
  };
  const problem = editing === undefined ? undefined : customKeyProblem(label, sequence);
  const existing = editing !== undefined && preferences.customKeys.some(({ id }) => id === editing.id);

  return (
    <Screen>
      <ScreenHeader back="Settings" title="Terminal" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.section}>
          <SectionHeader label="Text size" />
          <Card>
            <View style={styles.sizes}>
              {terminalGeometry.fontSizes.map((size, index) => {
                const selected = preferences.textSizeIndex === index;
                return (
                  <Pressable
                    key={size}
                    onPress={() => void store.setTextSizeIndex(index)}
                    accessibilityRole="radio"
                    accessibilityLabel={`${size} point`}
                    accessibilityState={{ selected }}
                    style={[styles.size, selected ? styles.sizeSelected : null]}
                  >
                    <Text style={[styles.sizeGlyph, { fontSize: size }, selected ? styles.sizeGlyphSelected : null]}>Aa</Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.cardNote}>Pinch the terminal to step through the same sizes.</Text>
          </Card>
        </View>

        <View style={styles.section}>
          <SectionHeader label="Typing" />
          <Card>
            <View style={styles.switchRow}>
              <View style={styles.switchCopy}>
                <Text style={styles.rowTitle}>Autocorrect & capitals</Text>
                <Text style={styles.rowDetail}>
                  Off keeps iOS from rewriting commands, flags, and paths in the composer. Live typing never autocorrects.
                </Text>
              </View>
              <Switch
                value={preferences.autocorrect}
                onValueChange={(value) => void store.setAutocorrect(value)}
                accessibilityLabel="Autocorrect and automatic capitals in the composer"
              />
            </View>
          </Card>
        </View>

        <View style={styles.section}>
          <SectionHeader label="Custom keys" />
          <Card>
            {preferences.customKeys.length === 0 && editing === undefined ? (
              <Text style={styles.cardNote}>
                Add keys to the end of the terminal key row, such as a Ctrl+R history search or a tmux prefix.
              </Text>
            ) : null}
            {preferences.customKeys.map((key, index) => (
              <View key={key.id}>
                {index === 0 ? null : <CardDivider />}
                <Pressable
                  onPress={() => edit(key)}
                  accessibilityRole="button"
                  accessibilityLabel={`Edit custom key ${key.label}`}
                  style={({ pressed }) => [styles.keyRow, pressed ? styles.pressed : null]}
                >
                  <Text style={styles.keyLabel}>{key.label}</Text>
                  <Text style={styles.keySequence} numberOfLines={1}>{key.sequence}</Text>
                </Pressable>
              </View>
            ))}
          </Card>

          {editing === undefined ? (
            preferences.customKeys.length >= MAX_CUSTOM_KEYS
              ? <Text style={styles.note}>The key row holds up to {MAX_CUSTOM_KEYS} custom keys.</Text>
              : (
                <Pressable onPress={() => edit(undefined)} accessibilityRole="button" style={({ pressed }) => [styles.add, pressed ? styles.pressed : null]}>
                  <Text style={styles.addLabel}>+ Add custom key</Text>
                </Pressable>
              )
          ) : (
            <Card style={styles.form}>
              <Text style={styles.fieldLabel}>Label</Text>
              <TextInput
                value={label}
                onChangeText={setLabel}
                maxLength={MAX_CUSTOM_KEY_LABEL}
                placeholder="^R"
                placeholderTextColor={color.textMuted}
                accessibilityLabel="Custom key label"
                autoCorrect={false}
                autoCapitalize="none"
                style={styles.field}
              />
              <Text style={styles.fieldLabel}>Sends</Text>
              <TextInput
                value={sequence}
                onChangeText={setSequence}
                maxLength={MAX_CUSTOM_KEY_SEQUENCE}
                placeholder="\cR"
                placeholderTextColor={color.textMuted}
                accessibilityLabel="Custom key sequence"
                autoCorrect={false}
                autoCapitalize="none"
                spellCheck={false}
                style={styles.field}
              />
              <Text style={styles.hint}>
                {"\\e Escape · \\cX Ctrl+X · \\r Return · \\t Tab · \\xHH a byte. Other text is sent as typed, without Return."}
              </Text>
              {problem === undefined || (label.length === 0 && sequence.length === 0) ? null : <Text style={styles.problem}>{problem}</Text>}
              <PrimaryButton
                label="Save key"
                disabled={problem !== undefined}
                onPress={() => {
                  if (editing === undefined || problem !== undefined) return;
                  void store.saveCustomKey({ id: editing.id, label: label.trim(), sequence });
                  setEditing(undefined);
                }}
              />
              <View style={styles.formActions}>
                <Pressable onPress={() => setEditing(undefined)} accessibilityRole="button" style={styles.add}>
                  <Text style={styles.addLabel}>Cancel</Text>
                </Pressable>
                {existing ? (
                  <Pressable
                    onPress={() => {
                      void store.removeCustomKey(editing.id);
                      setEditing(undefined);
                    }}
                    accessibilityRole="button"
                    style={styles.add}
                  >
                    <Text style={styles.removeLabel}>Delete key</Text>
                  </Pressable>
                ) : null}
              </View>
            </Card>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

const useStyles = createThemedStyles(({ color }) => ({
  content: { gap: space.lg, padding: space.screen, paddingBottom: space.xl },
  section: { gap: space.sm },
  sizes: { flexDirection: "row", justifyContent: "space-between", padding: space.sm },
  size: {
    flex: 1,
    height: geometry.touchTarget,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
  },
  sizeSelected: { backgroundColor: color.accentWash },
  sizeGlyph: { color: color.textSecondary, fontFamily: fontFamily.mono },
  sizeGlyphSelected: { color: color.accentStrong, fontWeight: "700" },
  cardNote: { paddingHorizontal: space.md, paddingBottom: space.md, paddingTop: space.xs, color: color.textMuted, fontSize: 12, lineHeight: 17 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md },
  switchCopy: { flex: 1, gap: 3 },
  rowTitle: { color: color.text, fontSize: 14, fontWeight: "600" },
  rowDetail: { color: color.textMuted, fontSize: 12, lineHeight: 17 },
  keyRow: { minHeight: geometry.touchTarget, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.md },
  pressed: { backgroundColor: color.accentWash },
  keyLabel: { minWidth: 48, color: color.text, fontFamily: fontFamily.mono, fontSize: 13, fontWeight: "700" },
  keySequence: { flex: 1, color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 12 },
  add: { minHeight: geometry.touchTarget, justifyContent: "center", paddingHorizontal: space.md },
  addLabel: { color: color.accentStrong, fontSize: 14, fontWeight: "600" },
  removeLabel: { color: color.danger, fontSize: 14, fontWeight: "600" },
  note: { paddingHorizontal: space.md, color: color.textMuted, fontSize: 12 },
  form: { padding: space.md, gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: color.border },
  formActions: { flexDirection: "row", justifyContent: "space-between" },
  fieldLabel: { color: color.textSecondary, fontSize: 12, fontWeight: "600" },
  field: {
    minHeight: geometry.touchTarget,
    paddingHorizontal: space.md,
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.bgApp,
    color: color.text,
    fontFamily: fontFamily.mono,
    fontSize: 13,
  },
  hint: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 10.5, lineHeight: 15 },
  problem: { color: color.danger, fontSize: 12 },
}));
