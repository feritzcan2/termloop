import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Connection } from '../lib/types';
import { colors, font, type } from '../lib/design';

export interface ConnectionCardProps {
  connection: Connection;
  index: number;
  active?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}

type RowStatus = 'run' | 'idle' | 'setup' | 'stale';

function statusFor(c: Connection): RowStatus {
  if (c.incomplete) return 'setup';
  if (!c.lastConnected) return 'idle';
  const age = Date.now() - c.lastConnected;
  if (age < 5 * 60_000) return 'run';
  if (age < 24 * 60 * 60_000) return 'idle';
  return 'stale';
}

const STATUS_LABEL: Record<RowStatus, string> = {
  run: 'running',
  idle: 'idle',
  setup: 'setup',
  stale: 'offline',
};

const STATUS_COLOR: Record<RowStatus, string> = {
  run: colors.phos,
  idle: colors.ink3,
  setup: colors.amber,
  stale: colors.ink4,
};

function relTime(ts: number | null): string {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function ConnectionCard({
  connection,
  index,
  active,
  onPress,
  onLongPress,
}: ConnectionCardProps) {
  const s = statusFor(connection);
  const isSelected = active === true;
  const cursor = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!isSelected) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(cursor, { toValue: 0.15, duration: 550, useNativeDriver: true }),
        Animated.timing(cursor, { toValue: 1, duration: 550, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [isSelected, cursor]);

  function handlePress() {
    Haptics.selectionAsync().catch(() => {});
    onPress();
  }

  function handleLongPress() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    onLongPress?.();
  }

  const label = connection.label || connection.host || 'Untitled';
  const host = `${connection.ssh.user}@${connection.host}`;
  const port = String(connection.termloop.port);

  return (
    <Pressable
      onPress={handlePress}
      onLongPress={handleLongPress}
      style={({ pressed }) => [
        styles.row,
        pressed && styles.rowPressed,
        isSelected && styles.rowSelected,
      ]}
    >
      {isSelected && <View style={styles.leftAccent} pointerEvents="none" />}
      <View style={[styles.gutter, isSelected && styles.gutterSelected]}>
        <Text style={[styles.gutterText, isSelected && styles.gutterTextSelected]}>
          {String(index + 1).padStart(2, '0')}
        </Text>
      </View>
      <View style={styles.body}>
        <View style={styles.titleLine}>
          <Text
            style={[styles.title, isSelected && styles.titleSelected]}
            numberOfLines={1}
          >
            {label}
          </Text>
          <View style={[styles.chip, { borderColor: STATUS_COLOR[s] }]}>
            <View style={[styles.chipDot, { backgroundColor: STATUS_COLOR[s] }]} />
            <Text style={[styles.chipText, { color: STATUS_COLOR[s] }]}>
              {STATUS_LABEL[s]}
            </Text>
          </View>
          {isSelected && (
            <Animated.View style={[styles.cursor, { opacity: cursor }]} />
          )}
        </View>
        <Text style={styles.sub} numberOfLines={1}>
          <Text style={styles.host}>{host}</Text>
          <Text style={styles.sep}> · </Text>
          {port}
        </Text>
        <View style={styles.meta}>
          <Text style={styles.metaItem}>
            <Text style={styles.metaKey}>last</Text> {relTime(connection.lastConnected)}
          </Text>
          <Text style={styles.metaItem}>
            <Text style={styles.metaKey}>ssh</Text> {connection.ssh.port}
          </Text>
        </View>
      </View>
      <Text style={[styles.chev, isSelected && styles.chevSelected]}>›</Text>
    </Pressable>
  );
}

const GUTTER_W = 34;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingTop: 12,
    paddingBottom: 12,
    paddingRight: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    position: 'relative',
    backgroundColor: colors.bg,
  },
  rowPressed: {
    backgroundColor: 'rgba(255,255,255,0.025)',
  },
  rowSelected: {
    backgroundColor: 'rgba(125,227,255,0.05)',
  },
  leftAccent: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
    backgroundColor: colors.cyan,
    shadowColor: colors.cyanHot,
    shadowOpacity: 0.7,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
  },
  gutter: {
    width: GUTTER_W,
    paddingLeft: 12,
    paddingRight: 6,
    paddingTop: 2,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.line,
    alignItems: 'flex-end',
    minHeight: 42,
  },
  gutterSelected: {
    borderRightColor: 'rgba(34,211,238,0.35)',
  },
  gutterText: {
    fontFamily: font.mono,
    fontSize: 10,
    color: colors.ink4,
    includeFontPadding: false,
  },
  gutterTextSelected: {
    color: colors.cyan,
    fontFamily: font.monoSemi,
  },
  body: {
    flex: 1,
    minWidth: 0,
    paddingLeft: 10,
  },
  titleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    ...type.featureTitle,
    color: colors.ink1,
    includeFontPadding: false,
    flexShrink: 1,
  },
  titleSelected: {
    color: '#fff',
  },
  cursor: {
    width: 6,
    height: 12,
    backgroundColor: colors.cyan,
    marginLeft: -2,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipDot: {
    width: 6,
    height: 6,
    borderRadius: 999,
  },
  chipText: {
    fontFamily: font.monoMedium,
    fontSize: 9.5,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    includeFontPadding: false,
  },
  sub: {
    fontFamily: font.mono,
    fontSize: 11.5,
    color: colors.ink3,
    marginTop: 4,
    includeFontPadding: false,
  },
  host: { color: colors.ink2, fontFamily: font.monoMedium },
  sep: { color: colors.ink4 },
  meta: {
    flexDirection: 'row',
    gap: 14,
    marginTop: 6,
  },
  metaItem: {
    fontFamily: font.mono,
    fontSize: 10.5,
    color: colors.ink4,
    includeFontPadding: false,
  },
  metaKey: {
    color: colors.ink3,
  },
  chev: {
    fontFamily: font.monoBold,
    fontSize: 14,
    color: colors.ink4,
    paddingTop: 2,
    marginLeft: 4,
    includeFontPadding: false,
  },
  chevSelected: {
    color: colors.cyan,
  },
});
