import { createThemedStyles } from "@/theme/context";
import { useEffect, useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import {
  ACCESSORY_KEYS,
  NO_MODIFIERS,
  accessoryKeyText,
  hasModifier,
  parseKeySequence,
  type AccessoryKey,
  type TerminalModifiers,
} from "@/presentation/terminal-keys";
import { radius, space, terminalGeometry } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";
import { createKeyRepeat, KEY_REPEAT_INTERVAL_MS } from "./key-repeat";
import type { TerminalInputMode } from "./composer-memory";
import type { CustomTerminalKey } from "./terminal-preferences-store";

const MODIFIERS: readonly { key: keyof TerminalModifiers; glyph: string; name: string }[] = [
  { key: "ctrl", glyph: "ctrl", name: "Control" },
  { key: "alt", glyph: "alt", name: "Alt" },
  { key: "shift", glyph: "⇧", name: "Shift" },
];

/// The keys a phone keyboard lacks.
///
/// The leading key switches between composing a whole turn and live typing, where
/// every keystroke goes straight to the PTY the way a shell, a REPL, or vim expects.
///
/// Modifiers are sticky for one key: arm Ctrl, then press a key here or type a
/// character, and the chord is sent and the modifier released. The modifiers and the
/// quick-command launcher stay pinned at the edges; the keys between them scroll.
///
/// Holding a repeatable key repeats it. The first send waits for the press to commit
/// rather than firing on touch-down, so a finger that starts scrolling the row never
/// sends an arrow on its way past.
export function TerminalKeyBar({ canSend, inputMode, onInputModeChange, modifiers, onModifiersChange, customKeys, onSend, onOpenQuickCommands }: {
  canSend: boolean;
  inputMode: TerminalInputMode;
  onInputModeChange: (mode: TerminalInputMode) => void;
  modifiers: TerminalModifiers;
  onModifiersChange: (modifiers: TerminalModifiers) => void;
  customKeys: readonly CustomTerminalKey[];
  onSend: (text: string) => void;
  onOpenQuickCommands: () => void;
}) {
  const styles = useStyles();
  const repeat = useMemo(() => createKeyRepeat(), []);
  useEffect(() => repeat.stop, [repeat]);
  useEffect(() => { if (!canSend) repeat.stop(); }, [canSend, repeat]);

  const sendAccessory = (key: AccessoryKey) => {
    onSend(accessoryKeyText(key.id, modifiers));
    onModifiersChange(NO_MODIFIERS);
  };
  const sendCustom = (key: CustomTerminalKey) => {
    const parsed = parseKeySequence(key.sequence);
    if (parsed.ok) onSend(parsed.text);
    onModifiersChange(NO_MODIFIERS);
  };

  return (
    <View style={styles.bar}>
      <View style={styles.pinned}>
        <Pressable
          onPress={() => onInputModeChange(inputMode === "live" ? "compose" : "live")}
          accessibilityRole="switch"
          accessibilityLabel="Live typing"
          accessibilityHint="When on, each keystroke goes straight to the terminal."
          accessibilityState={{ checked: inputMode === "live" }}
          style={({ pressed }) => [
            styles.key,
            inputMode === "live" ? styles.keyArmed : null,
            pressed ? styles.keyPressed : null,
          ]}
        >
          <Text style={[styles.keyGlyph, inputMode === "live" ? styles.keyGlyphArmed : null]}>live</Text>
        </Pressable>
        <View style={styles.separator} />
        {MODIFIERS.map((modifier) => {
          const armed = modifiers[modifier.key];
          return (
            <Pressable
              key={modifier.key}
              onPress={() => onModifiersChange({ ...modifiers, [modifier.key]: !armed })}
              disabled={!canSend}
              accessibilityRole="togglebutton"
              accessibilityLabel={modifier.name}
              accessibilityState={{ checked: armed, disabled: !canSend }}
              style={({ pressed }) => [
                styles.key,
                armed ? styles.keyArmed : null,
                pressed && canSend ? styles.keyPressed : null,
                !canSend && styles.keyDisabled,
              ]}
            >
              <Text style={[styles.keyGlyph, armed ? styles.keyGlyphArmed : null]}>{modifier.glyph}</Text>
            </Pressable>
          );
        })}
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.keys}
        keyboardShouldPersistTaps="always"
        style={styles.scroll}
      >
        {ACCESSORY_KEYS.map((key) => (
          <Pressable
            key={key.id}
            onPress={() => sendAccessory(key)}
            onLongPress={key.repeatable ? () => {
              const text = accessoryKeyText(key.id, modifiers);
              repeat.start(() => onSend(text), KEY_REPEAT_INTERVAL_MS);
            } : undefined}
            onPressOut={key.repeatable ? () => {
              repeat.stop();
              if (hasModifier(modifiers)) onModifiersChange(NO_MODIFIERS);
            } : undefined}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityLabel={key.name}
            accessibilityHint={key.repeatable ? "Hold to repeat." : undefined}
            accessibilityState={{ disabled: !canSend }}
            style={({ pressed }) => [
              styles.key,
              pressed && canSend ? styles.keyPressed : null,
              !canSend && styles.keyDisabled,
            ]}
          >
            <Text style={styles.keyGlyph}>{key.glyph}</Text>
          </Pressable>
        ))}
        {customKeys.map((key) => (
          <Pressable
            key={key.id}
            onPress={() => sendCustom(key)}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityLabel={`Custom key ${key.label}`}
            accessibilityState={{ disabled: !canSend }}
            style={({ pressed }) => [
              styles.key,
              styles.customKey,
              pressed && canSend ? styles.keyPressed : null,
              !canSend && styles.keyDisabled,
            ]}
          >
            <Text style={styles.keyGlyph} numberOfLines={1}>{key.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <View style={styles.pinned}>
        <Pressable
          onPress={onOpenQuickCommands}
          accessibilityRole="button"
          accessibilityLabel="Quick commands"
          style={({ pressed }) => [styles.key, pressed ? styles.keyPressed : null]}
        >
          <Text style={styles.quickGlyph}>⚡︎</Text>
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = createThemedStyles(({ color }) => ({
  bar: { flexDirection: "row", alignItems: "center", paddingVertical: space.sm },
  pinned: { flexDirection: "row", gap: 5, paddingHorizontal: space.sm },
  scroll: { flex: 1 },
  separator: { width: 1, alignSelf: "stretch", marginVertical: 6, backgroundColor: color.rule },
  keys: { gap: 5, alignItems: "center" },
  key: {
    minWidth: terminalGeometry.keyMinWidth,
    height: terminalGeometry.keyRowHeight,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.control,
    backgroundColor: color.bgRaised,
  },
  customKey: { borderStyle: "dashed" },
  keyArmed: { borderColor: color.accent, backgroundColor: color.accentWash },
  keyPressed: { backgroundColor: color.bgHover },
  keyDisabled: { opacity: 0.45 },
  keyGlyph: { color: color.textSecondary, fontFamily: fontFamily.mono, fontSize: 12.5 },
  keyGlyphArmed: { color: color.accentStrong, fontWeight: "700" },
  quickGlyph: { color: color.accentStrong, fontSize: 15 },
}));
