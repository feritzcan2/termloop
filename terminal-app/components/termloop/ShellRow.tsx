import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors, font, type } from '../../lib/design';

export interface ShellRowProps {
  user: string;
  host: string;
  path: string;
  compact?: boolean;
  onPress?: () => void;
}

export function ShellRow({ user, host, path, compact, onPress }: ShellRowProps) {
  function handlePress() {
    if (!onPress) return;
    Haptics.selectionAsync().catch(() => {});
    onPress();
  }

  return (
    <Pressable
      onPress={handlePress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.bulletCell}>
        <Text style={styles.bullet}>»</Text>
      </View>
      {compact ? (
        <View style={styles.promptBlock}>
          <Text style={styles.prompt} numberOfLines={1}>
            <Text style={styles.user}>{user}</Text>
            <Text style={styles.at}>@</Text>
            <Text style={styles.host}>{host}</Text>
          </Text>
          <Text style={[styles.prompt, styles.pathLine]} numberOfLines={1}>
            <Text style={styles.sep}>:</Text>
            <Text style={styles.path}>{path}</Text>
          </Text>
        </View>
      ) : (
        <Text style={styles.prompt} numberOfLines={1}>
          <Text style={styles.user}>{user}</Text>
          <Text style={styles.at}>@</Text>
          <Text style={styles.host}>{host}</Text>
          <Text style={styles.sep}>:</Text>
          <Text style={styles.path}>{path}</Text>
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingVertical: 12,
    paddingLeft: 12,
    paddingRight: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  rowPressed: {
    backgroundColor: 'rgba(255,255,255,0.025)',
  },
  bulletCell: {
    width: 28,
    alignItems: 'center',
    paddingTop: 1,
  },
  bullet: {
    fontFamily: font.monoBold,
    fontSize: 11,
    color: colors.ink4,
    includeFontPadding: false,
  },
  prompt: {
    ...type.shellPrompt,
    flex: 1,
    includeFontPadding: false,
  },
  promptBlock: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  pathLine: {
    flex: 0,
  },
  user: { color: colors.cyan, fontFamily: font.monoSemi },
  at: { color: colors.ink4 },
  host: { color: colors.ink2, fontFamily: font.monoMedium },
  sep: { color: colors.ink4 },
  path: { color: colors.ink3 },
});
