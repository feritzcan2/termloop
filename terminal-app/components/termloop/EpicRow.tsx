import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, type } from '../../lib/design';

export interface EpicRowProps {
  name: string;
  count: number;
  open: boolean;
  current?: boolean;
  compact?: boolean;
  onPress: () => void;
}

export function EpicRow({ name, count, open, current, compact, onPress }: EpicRowProps) {
  const tint = current ? colors.selEdge : open ? colors.ink1 : colors.ink2;
  const subTint = current ? colors.selEdge : open ? colors.ink2 : colors.ink3;
  const countTint = current ? colors.selEdge : colors.ink4;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        compact && styles.rowCompact,
        current && styles.rowCurrent,
        pressed && styles.rowPressed,
      ]}
    >
      <View style={styles.discCell}>
        <Text style={[styles.disc, { color: subTint }]}>{open ? '▼' : '▶'}</Text>
      </View>
      <Text
        style={[
          styles.name,
          compact && styles.nameCompact,
          { color: tint },
          current && styles.nameGlow,
        ]}
        numberOfLines={1}
      >
        {name.toUpperCase()}
      </Text>
      <View style={[styles.countPill, current && styles.countPillCurrent]}>
        <Text style={[styles.count, { color: countTint }]}>{String(count).padStart(2, '0')}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    paddingLeft: 12,
    paddingRight: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    minHeight: 44,
  },
  rowCompact: {
    paddingVertical: 10,
    paddingLeft: 10,
    paddingRight: 12,
    minHeight: 40,
  },
  rowCurrent: {
    backgroundColor: 'rgba(61,109,255,0.06)',
  },
  rowPressed: {
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  discCell: {
    width: 28,
    alignItems: 'center',
  },
  disc: {
    fontFamily: font.monoSemi,
    fontSize: 9,
    includeFontPadding: false,
  },
  name: {
    flex: 1,
    ...type.epicName,
    includeFontPadding: false,
  },
  nameCompact: {
    fontSize: 10.5,
    letterSpacing: 1.8,
  },
  nameGlow: {
    textShadowColor: colors.selGlow,
    textShadowRadius: 8,
  },
  count: {
    ...type.epicCount,
    textAlign: 'right',
  },
  countPill: {
    minWidth: 28,
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.03)',
    alignItems: 'center',
  },
  countPillCurrent: {
    backgroundColor: 'rgba(122,160,255,0.12)',
  },
});
