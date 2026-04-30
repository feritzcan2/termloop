import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors, font, type } from '../../lib/design';

export interface CmdBarProps {
  label: string;
  kbd?: string;
  onPress?: () => void;
  disabled?: boolean;
  compact?: boolean;
}

export function CmdBar({ label, kbd, onPress, disabled, compact }: CmdBarProps) {
  function handlePress() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onPress?.();
  }
  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.bar,
        compact && styles.barCompact,
        pressed && !disabled && styles.barPressed,
        disabled && styles.barDisabled,
      ]}
    >
      <Text style={[styles.plus, disabled && styles.textDisabled]}>+</Text>
      <Text
        style={[styles.label, compact && styles.labelCompact, disabled && styles.textDisabled]}
        numberOfLines={1}
      >
        {label.toUpperCase()}
      </Text>
      {kbd && (
        <View style={[styles.kbd, disabled && styles.kbdDisabled]}>
          <Text style={[styles.kbdText, disabled && styles.textDisabled]}>{kbd}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.lineStrong,
    backgroundColor: 'rgba(61,109,255,0.04)',
    gap: 10,
  },
  barCompact: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 8,
  },
  barPressed: {
    backgroundColor: 'rgba(61,109,255,0.1)',
  },
  barDisabled: {
    opacity: 0.4,
  },
  textDisabled: {
    color: colors.ink3,
  },
  kbdDisabled: {
    borderColor: colors.ink3,
  },
  plus: {
    fontFamily: font.monoBold,
    fontSize: 14,
    color: colors.selEdge,
    includeFontPadding: false,
  },
  label: {
    ...type.cmdLabel,
    color: colors.ink2,
    flex: 1,
    includeFontPadding: false,
  },
  labelCompact: {
    fontSize: 10.5,
    letterSpacing: 2.1,
  },
  kbd: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.lineStrong,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  kbdText: {
    fontFamily: font.mono,
    fontSize: 10,
    color: colors.ink2,
    letterSpacing: 0.8,
    includeFontPadding: false,
  },
});
