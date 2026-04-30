import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
} from 'react-native';
import * as Haptics from 'expo-haptics';

export type KeyboardBarAction =
  | { kind: 'input'; value: string }
  | { kind: 'ctrl-toggle'; active: boolean }
  | { kind: 'select-toggle'; active: boolean }
  | { kind: 'scroll'; lines: number }
  | { kind: 'paste' };

interface KeyboardBarProps {
  onAction: (action: KeyboardBarAction) => void;
  selectActive?: boolean;
}

type SlotKind =
  | 'input'
  | 'ctrl'
  | 'select'
  | 'scroll'
  | 'paste'
  | 'scroll-enter'
  | 'scroll-exit'
  | 'divider';

interface KeySlot {
  label: string;
  kind: SlotKind;
  value?: string;
  longValue?: string; // sent on long-press (overrides value)
  longLabel?: string; // small badge for long-press hint
  lines?: number;
  repeatable?: boolean;
  accent?: 'primary' | 'danger';
}

// Shown when scroll mode is OFF. Leftmost key toggles scroll mode on.
const KEYS: KeySlot[] = [
  { label: 'Scroll ↕', kind: 'scroll-enter', accent: 'primary' },
  { label: '|', kind: 'divider' },
  { label: 'Esc', kind: 'input', value: '\x1b' },
  { label: 'Tab', kind: 'input', value: '\t' },
  { label: 'Ctrl', kind: 'ctrl' },
  { label: 'Sel', kind: 'select' },
  { label: 'Paste', kind: 'paste' },
  { label: '\u2191', kind: 'input', value: '\x1b[A', repeatable: true },
  { label: '\u2193', kind: 'input', value: '\x1b[B', repeatable: true },
  { label: '\u2190', kind: 'input', value: '\x1b[D', repeatable: true },
  { label: '\u2192', kind: 'input', value: '\x1b[C', repeatable: true },
  { label: 'Alt', kind: 'input', value: '\x1b' },
  { label: '|', kind: 'divider' },
  { label: '|', kind: 'input', value: '|' },
  { label: '>', kind: 'input', value: '>', longValue: '<', longLabel: '<' },
  { label: '&', kind: 'input', value: '&', longValue: '&&', longLabel: '&&' },
  { label: '~', kind: 'input', value: '~', longValue: '^', longLabel: '^' },
  { label: '$', kind: 'input', value: '$', longValue: '#', longLabel: '#' },
  { label: '*', kind: 'input', value: '*', longValue: '?', longLabel: '?' },
  { label: '/', kind: 'input', value: '/', longValue: '\\', longLabel: '\\' },
  { label: '(', kind: 'input', value: '(', longValue: '[', longLabel: '[' },
  { label: ')', kind: 'input', value: ')', longValue: ']', longLabel: ']' },
  { label: '{', kind: 'input', value: '{', longValue: '<', longLabel: '<' },
  { label: '}', kind: 'input', value: '}', longValue: '>', longLabel: '>' },
  { label: '`', kind: 'input', value: '`' },
  { label: '"', kind: 'input', value: '"', longValue: "'", longLabel: "'" },
  { label: '-', kind: 'input', value: '-', longValue: '_', longLabel: '_' },
];

// Shown when scroll mode is ON. Scroll mode enters tmux copy-mode
// (Ctrl-b [) so the user can scroll through tmux's history buffer —
// Claude's TUI redraws in place so xterm's own scrollback stays empty.
// Word navigation keys (Alt-b / Alt-f) assume tmux's default emacs
// copy-mode bindings; Sel starts a tmux selection (Space), Copy copies
// via xterm's drag-select which writes the visible selection to the
// iPhone clipboard on release.
const SCROLL_KEYS: KeySlot[] = [
  { label: 'Exit', kind: 'scroll-exit', accent: 'danger' },
  { label: '|', kind: 'divider' },
  { label: 'Sel', kind: 'select' }, // toggles xterm's finger-drag selection → iPhone clipboard
  { label: 'Mark', kind: 'input', value: ' ' }, // tmux: begin selection at cursor (emacs copy-mode Space)
  { label: '|', kind: 'divider' },
  { label: 'PgUp', kind: 'scroll', lines: -12 },
  { label: 'PgDn', kind: 'scroll', lines: 12 },
  { label: '\u2191', kind: 'input', value: '\x1b[A', repeatable: true },
  { label: '\u2193', kind: 'input', value: '\x1b[B', repeatable: true },
  { label: '\u21E0 W', kind: 'input', value: '\x1bb', repeatable: true }, // Alt-b: word back
  { label: 'W \u21E2', kind: 'input', value: '\x1bf', repeatable: true }, // Alt-f: word forward
];

export function KeyboardBar({ onAction, selectActive = false }: KeyboardBarProps) {
  const [ctrlActive, setCtrlActive] = useState(false);
  const [scrollMode, setScrollMode] = useState(false);
  const repeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const longPressFiredRef = useRef(false);

  const hapticTap = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const handlePress = useCallback(
    (key: KeySlot) => {
      // Skip the regular onPress if a long-press just fired for this gesture.
      if (longPressFiredRef.current) {
        longPressFiredRef.current = false;
        return;
      }
      hapticTap();
      switch (key.kind) {
        case 'input': {
          onAction({ kind: 'input', value: key.value ?? '' });
          if (ctrlActive) {
            setCtrlActive(false);
            onAction({ kind: 'ctrl-toggle', active: false });
          }
          return;
        }
        case 'ctrl': {
          const next = !ctrlActive;
          setCtrlActive(next);
          onAction({ kind: 'ctrl-toggle', active: next });
          return;
        }
        case 'select':
          onAction({ kind: 'select-toggle', active: !selectActive });
          return;
        case 'scroll':
          onAction({ kind: 'scroll', lines: key.lines ?? 0 });
          return;
        case 'paste':
          onAction({ kind: 'paste' });
          return;
        case 'scroll-enter':
          // Enter tmux copy-mode (Ctrl-b [) then swap the bar to scroll-only.
          onAction({ kind: 'input', value: '\x02[' });
          setScrollMode(true);
          return;
        case 'scroll-exit':
          // Exit tmux copy-mode (Esc) and restore the main bar.
          onAction({ kind: 'input', value: '\x1b' });
          setScrollMode(false);
          return;
      }
    },
    [ctrlActive, hapticTap, onAction, selectActive]
  );

  const handleLongPress = useCallback(
    (key: KeySlot) => {
      if (key.kind !== 'input' || !key.longValue) return;
      longPressFiredRef.current = true;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      onAction({ kind: 'input', value: key.longValue });
      if (ctrlActive) {
        setCtrlActive(false);
        onAction({ kind: 'ctrl-toggle', active: false });
      }
    },
    [ctrlActive, onAction]
  );

  const handlePressIn = useCallback(
    (key: KeySlot) => {
      if (key.kind === 'input' && key.repeatable) {
        repeatTimer.current = setInterval(() => {
          onAction({ kind: 'input', value: key.value ?? '' });
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }, 100);
        return;
      }
      if (key.kind === 'scroll') {
        repeatTimer.current = setInterval(() => {
          onAction({ kind: 'scroll', lines: key.lines ?? 0 });
        }, 120);
      }
    },
    [onAction]
  );

  const handlePressOut = useCallback(() => {
    if (repeatTimer.current) {
      clearInterval(repeatTimer.current);
      repeatTimer.current = null;
    }
  }, []);

  const isActive = useCallback(
    (key: KeySlot) => {
      if (key.kind === 'ctrl') return ctrlActive;
      if (key.kind === 'select') return selectActive;
      return false;
    },
    [ctrlActive, selectActive]
  );

  const keys = scrollMode ? SCROLL_KEYS : KEYS;

  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.contentContainer}
      style={styles.container}
    >
      {keys.map((key, i) => {
        if (key.kind === 'divider') {
          return <View key={`div-${i}`} style={styles.divider} />;
        }
        const active = isActive(key);
        const accentStyle =
          key.accent === 'primary'
            ? styles.keyPrimary
            : key.accent === 'danger'
            ? styles.keyDanger
            : null;
        const accentTextStyle =
          key.accent === 'primary' || key.accent === 'danger' ? styles.keyTextAccent : null;
        return (
          <TouchableOpacity
            key={`${key.label}-${i}`}
            style={[styles.key, accentStyle, active && !accentStyle && styles.keyActive]}
            onPress={() => handlePress(key)}
            onLongPress={() => handleLongPress(key)}
            onPressIn={() => handlePressIn(key)}
            onPressOut={handlePressOut}
            delayLongPress={300}
            activeOpacity={0.6}
          >
            <Text
              style={[
                styles.keyText,
                active && !accentStyle && styles.keyTextActive,
                accentTextStyle,
              ]}
            >
              {key.label}
            </Text>
            {key.longLabel ? <Text style={styles.longHint}>{key.longLabel}</Text> : null}
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 0,
    backgroundColor: '#1e1f29',
    borderTopWidth: 1,
    borderTopColor: '#44475a',
  },
  contentContainer: {
    paddingVertical: 6,
    paddingHorizontal: 6,
    gap: 6,
    alignItems: 'center',
  },
  key: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: '#44475a',
    minWidth: 40,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  keyActive: {
    backgroundColor: '#bd93f9',
  },
  keyPrimary: {
    backgroundColor: '#50fa7b',
    paddingHorizontal: 16,
  },
  keyDanger: {
    backgroundColor: '#ff5555',
    paddingHorizontal: 16,
  },
  keyText: {
    color: '#f8f8f2',
    fontSize: 14,
    fontWeight: '600',
  },
  keyTextActive: {
    color: '#282a36',
  },
  keyTextAccent: {
    color: '#282a36',
    fontWeight: '700',
  },
  longHint: {
    position: 'absolute',
    top: 1,
    right: 3,
    color: '#6272a4',
    fontSize: 8,
    fontWeight: '700',
  },
  divider: {
    width: 1,
    height: 24,
    backgroundColor: '#44475a',
    marginHorizontal: 4,
  },
});
