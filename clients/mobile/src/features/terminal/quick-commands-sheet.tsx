import { useTheme, createThemedStyles } from "@/theme/context";
import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";

import { PrimaryButton } from "@/components/primitives";
import { keyboardAvoidingBehavior } from "@/platform/presentation";
import { geometry, radius, space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";
import { useTerminalPreferences, useTerminalPreferencesStore } from "./terminal-preferences";
import {
  MAX_QUICK_COMMANDS,
  MAX_QUICK_COMMAND_BODY,
  MAX_QUICK_COMMAND_LABEL,
  newLocalId,
  quickCommandProblem,
  quickCommandTitle,
  type QuickCommand,
} from "./terminal-preferences-store";

/// Saved commands and prompts, one tap from the terminal.
///
/// Kept on this phone. Running one sends its body to the attached Session exactly
/// as saved, optionally followed by Return; Insert puts it in the composer instead
/// so it can be edited before it is sent.
export function QuickCommandsSheet({ visible, canSend, onClose, onRun, onInsert }: {
  visible: boolean;
  canSend: boolean;
  onClose: () => void;
  onRun: (command: QuickCommand) => void;
  /// Absent while the terminal takes live keystrokes and has no composer to fill.
  onInsert?: ((body: string) => void) | undefined;
}) {
  const { color } = useTheme();
  const styles = useStyles();
  const { quickCommands } = useTerminalPreferences();
  const store = useTerminalPreferencesStore();
  const [editing, setEditing] = useState<QuickCommand | undefined>(undefined);
  const [label, setLabel] = useState("");
  const [body, setBody] = useState("");
  const [enter, setEnter] = useState(true);

  useEffect(() => { if (!visible) setEditing(undefined); }, [visible]);

  const edit = (command: QuickCommand | undefined) => {
    const target = command ?? { id: newLocalId(), label: "", body: "", enter: true };
    setEditing(target);
    setLabel(target.label);
    setBody(target.body);
    setEnter(target.enter);
  };
  const problem = editing === undefined ? undefined : quickCommandProblem(label, body);
  const existing = editing !== undefined && quickCommands.some(({ id }) => id === editing.id);
  const save = () => {
    if (editing === undefined || problem !== undefined) return;
    void store.saveQuickCommand({ id: editing.id, label: label.trim(), body, enter });
    setEditing(undefined);
  };
  const remove = () => {
    if (editing === undefined) return;
    void store.removeQuickCommand(editing.id);
    setEditing(undefined);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={editing === undefined ? onClose : () => setEditing(undefined)}>
      <View style={styles.layer}>
        <Pressable style={styles.backdrop} accessibilityRole="button" accessibilityLabel="Close quick commands" onPress={onClose} />
        <KeyboardAvoidingView behavior={keyboardAvoidingBehavior} style={styles.keyboardAvoiding}>
          <View style={styles.sheet} accessibilityViewIsModal>
            <View style={styles.handle} />
            <View style={styles.header}>
              {editing === undefined ? <View style={styles.headerButton} /> : (
                <Pressable onPress={() => setEditing(undefined)} accessibilityRole="button" accessibilityLabel="Back to quick commands" style={styles.headerButton}>
                  <Text style={styles.headerGlyph}>‹</Text>
                </Pressable>
              )}
              <View style={styles.headerCopy}>
                <Text style={styles.title}>{editing === undefined ? "Quick commands" : existing ? "Edit command" : "New command"}</Text>
                <Text style={styles.subtitle}>Saved on this phone</Text>
              </View>
              <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={styles.headerButton}>
                <Text style={styles.closeGlyph}>×</Text>
              </Pressable>
            </View>

            {editing === undefined ? (
              <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                {quickCommands.length === 0 ? (
                  <Text style={styles.empty}>
                    Save a shell command or an agent prompt you send often. It runs in whichever terminal is open.
                  </Text>
                ) : quickCommands.map((command) => (
                  <View key={command.id} style={styles.row}>
                    <Pressable
                      onPress={() => { onRun(command); onClose(); }}
                      onLongPress={() => edit(command)}
                      disabled={!canSend}
                      accessibilityRole="button"
                      accessibilityLabel={`Run ${quickCommandTitle(command)}`}
                      accessibilityHint={command.enter ? "Sends it and presses Return. Long-press to edit." : "Types it without pressing Return. Long-press to edit."}
                      accessibilityState={{ disabled: !canSend }}
                      style={({ pressed }) => [styles.run, pressed && canSend ? styles.pressed : null, !canSend && styles.disabled]}
                    >
                      <Text style={styles.rowLabel} numberOfLines={1}>{quickCommandTitle(command)}</Text>
                      <Text style={styles.rowBody} numberOfLines={1}>{command.body.replace(/\n/g, " ⏎ ")}{command.enter ? " ⏎" : ""}</Text>
                    </Pressable>
                    {onInsert === undefined ? null : (
                      <Pressable
                        onPress={() => { onInsert(command.body); onClose(); }}
                        accessibilityRole="button"
                        accessibilityLabel={`Insert ${quickCommandTitle(command)} into the composer`}
                        style={({ pressed }) => [styles.rowAction, pressed ? styles.pressed : null]}
                      >
                        <Text style={styles.rowActionLabel}>Insert</Text>
                      </Pressable>
                    )}
                    <Pressable
                      onPress={() => edit(command)}
                      accessibilityRole="button"
                      accessibilityLabel={`Edit ${quickCommandTitle(command)}`}
                      style={({ pressed }) => [styles.rowAction, pressed ? styles.pressed : null]}
                    >
                      <Text style={styles.rowActionLabel}>Edit</Text>
                    </Pressable>
                  </View>
                ))}
                {quickCommands.length >= MAX_QUICK_COMMANDS ? (
                  <Text style={styles.note}>The phone keeps up to {MAX_QUICK_COMMANDS} commands. Remove one to add another.</Text>
                ) : (
                  <Pressable onPress={() => edit(undefined)} accessibilityRole="button" style={({ pressed }) => [styles.add, pressed ? styles.pressed : null]}>
                    <Text style={styles.addLabel}>+ New command</Text>
                  </Pressable>
                )}
              </ScrollView>
            ) : (
              <ScrollView style={styles.scroll} contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
                <Text style={styles.fieldLabel}>Name (optional)</Text>
                <TextInput
                  value={label}
                  onChangeText={setLabel}
                  maxLength={MAX_QUICK_COMMAND_LABEL}
                  placeholder="Run tests"
                  placeholderTextColor={color.textMuted}
                  accessibilityLabel="Command name"
                  style={styles.field}
                />
                <Text style={styles.fieldLabel}>Command or prompt</Text>
                <TextInput
                  value={body}
                  onChangeText={setBody}
                  maxLength={MAX_QUICK_COMMAND_BODY}
                  placeholder="pnpm test"
                  placeholderTextColor={color.textMuted}
                  accessibilityLabel="Command text"
                  autoCorrect={false}
                  autoCapitalize="none"
                  spellCheck={false}
                  multiline
                  style={[styles.field, styles.bodyField]}
                />
                <View style={styles.switchRow}>
                  <View style={styles.switchCopy}>
                    <Text style={styles.rowLabel}>Press Return</Text>
                    <Text style={styles.rowBody}>Off types it and leaves it on the prompt to edit.</Text>
                  </View>
                  <Switch value={enter} onValueChange={setEnter} accessibilityLabel="Press Return after the command" />
                </View>
                {problem === undefined || body.length === 0 ? null : <Text style={styles.problem}>{problem}</Text>}
                <PrimaryButton label="Save" onPress={save} disabled={problem !== undefined} />
                {existing ? (
                  <Pressable onPress={remove} accessibilityRole="button" style={({ pressed }) => [styles.add, pressed ? styles.pressed : null]}>
                    <Text style={styles.removeLabel}>Delete command</Text>
                  </Pressable>
                ) : null}
              </ScrollView>
            )}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const useStyles = createThemedStyles(({ color }) => ({
  layer: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: color.scrim },
  keyboardAvoiding: { maxHeight: "88%", justifyContent: "flex-end" },
  sheet: {
    maxHeight: "100%",
    paddingTop: space.sm,
    paddingBottom: space.xl,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    backgroundColor: color.bgRaised,
  },
  handle: {
    alignSelf: "center",
    width: geometry.sheetHandle.width,
    height: geometry.sheetHandle.height,
    marginBottom: space.xs,
    borderRadius: radius.pill,
    backgroundColor: color.borderStrong,
  },
  header: { minHeight: 58, flexDirection: "row", alignItems: "center", paddingHorizontal: space.sm },
  headerButton: { width: geometry.touchTarget, height: geometry.touchTarget, alignItems: "center", justifyContent: "center" },
  headerGlyph: { color: color.textSecondary, fontSize: 34, lineHeight: 36 },
  closeGlyph: { color: color.textSecondary, fontSize: 25, lineHeight: 28 },
  headerCopy: { flex: 1, minWidth: 0, gap: 3, alignItems: "center" },
  title: { color: color.text, fontSize: 16, fontWeight: "700" },
  subtitle: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 10 },
  scroll: { flexGrow: 0 },
  content: { paddingHorizontal: space.sm, paddingBottom: space.md, gap: 2 },
  row: { flexDirection: "row", alignItems: "center", gap: space.xs },
  run: { flex: 1, minWidth: 0, minHeight: 54, justifyContent: "center", gap: 2, paddingHorizontal: space.md, borderRadius: radius.control },
  pressed: { backgroundColor: color.accentWash },
  disabled: { opacity: 0.42 },
  rowLabel: { color: color.text, fontSize: 14, fontWeight: "600" },
  rowBody: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 11 },
  rowAction: { minHeight: geometry.touchTarget, justifyContent: "center", paddingHorizontal: space.sm, borderRadius: radius.control },
  rowActionLabel: { color: color.accentStrong, fontFamily: fontFamily.mono, fontSize: 11, fontWeight: "700" },
  add: { minHeight: geometry.touchTarget, justifyContent: "center", paddingHorizontal: space.md, borderRadius: radius.control },
  addLabel: { color: color.accentStrong, fontSize: 14, fontWeight: "600" },
  removeLabel: { color: color.danger, fontSize: 14, fontWeight: "600", textAlign: "center" },
  empty: { paddingHorizontal: space.md, paddingVertical: space.lg, color: color.textMuted, fontSize: 12, lineHeight: 17 },
  note: { paddingHorizontal: space.md, paddingVertical: space.sm, color: color.textMuted, fontSize: 11, lineHeight: 16 },
  form: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.sm },
  fieldLabel: { color: color.textSecondary, fontSize: 12, fontWeight: "600" },
  field: {
    minHeight: geometry.touchTarget,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.bgApp,
    color: color.text,
    fontFamily: fontFamily.mono,
    fontSize: 13,
  },
  bodyField: { minHeight: 88, maxHeight: 180, textAlignVertical: "top" },
  switchRow: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.xs },
  switchCopy: { flex: 1, gap: 2 },
  problem: { color: color.danger, fontSize: 12 },
}));
