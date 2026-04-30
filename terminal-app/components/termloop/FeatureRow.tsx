import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors, font, status as statusMap, type, FeatureStatus } from '../../lib/design';

export interface FeatureRowProps {
  title: string;
  status: FeatureStatus;
  meta?: string;
  branch: string;
  path: string;
  bullet?: '·' | '✳';
  selected?: boolean;
  compact?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}

export function FeatureRow({
  title,
  status,
  meta,
  branch,
  path,
  bullet = '·',
  selected,
  compact,
  onPress,
  onLongPress,
}: FeatureRowProps) {
  const s = statusMap[status];
  const cursor = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!selected) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(cursor, { toValue: 0.15, duration: 550, useNativeDriver: true }),
        Animated.timing(cursor, { toValue: 1, duration: 550, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [selected, cursor]);

  function handlePress() {
    Haptics.selectionAsync().catch(() => {});
    onPress();
  }

  function handleLongPress() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    onLongPress?.();
  }

  const statusColor = selected
    ? status === 'input' ? colors.onSelWarm : colors.onSelDim
    : s.color;

  return (
    <Pressable
      onPress={handlePress}
      onLongPress={handleLongPress}
      style={({ pressed }) => [
        selected ? styles.rowSelectedOuter : styles.rowOuter,
        compact && selected && styles.rowSelectedOuterCompact,
        pressed && !selected && styles.rowPressed,
      ]}
    >
      {selected && (
        <View
          style={[styles.leftAccent, compact && styles.leftAccentCompact]}
          pointerEvents="none"
        />
      )}
      <View
        style={[
          selected ? styles.rowSelectedInner : styles.rowInner,
          compact && styles.rowInnerCompact,
          compact && selected && styles.rowSelectedInnerCompact,
        ]}
      >
        <View style={[styles.bulletCell, compact && styles.bulletCellCompact]}>
          <Text style={[styles.bullet, { color: selected ? colors.white : colors.ink3 }]}>
            {bullet}
          </Text>
        </View>
        <View style={styles.body}>
          <View style={styles.titleLine}>
            <Text
              style={[
                styles.title,
                compact && styles.titleCompact,
                { color: selected ? colors.white : colors.ink1 },
              ]}
              numberOfLines={1}
            >
              {title}
            </Text>
            {selected && (
              <Animated.View style={[styles.cursor, { opacity: cursor }]} />
            )}
          </View>
          <Text
            style={[styles.statusText, compact && styles.statusTextCompact, { color: statusColor }]}
            numberOfLines={1}
          >
            <Text style={styles.statusIcon}>{s.icon}</Text>
            {'  '}
            {s.label}
            {meta ? (
              <Text style={[styles.statusMeta, { color: selected ? colors.onSelDim : colors.ink4 }]}>
                {'  ·  '}
                {meta}
              </Text>
            ) : null}
          </Text>
          {compact ? (
            <View style={styles.pathStack}>
              <Text
                style={[styles.branchOnly, { color: selected ? colors.onSelWarm : colors.amber }]}
                numberOfLines={1}
              >
                {branch}
              </Text>
              <Text
                style={[styles.path, styles.pathOnly, { color: selected ? colors.onSelDim : colors.ink3 }]}
                numberOfLines={1}
              >
                {path}
              </Text>
            </View>
          ) : (
            <Text
              style={[styles.path, { color: selected ? colors.onSelDim : colors.ink3 }]}
              numberOfLines={1}
            >
              <Text style={{ color: selected ? colors.onSelWarm : colors.amber }}>
                {branch}
              </Text>
              <Text style={{ color: selected ? 'rgba(255,255,255,0.4)' : colors.ink4 }}>
                {'  ·  '}
              </Text>
              {path}
            </Text>
          )}
        </View>
        <Text style={[styles.chev, { color: selected ? colors.white : colors.ink4 }]}>›</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  rowOuter: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  rowSelectedOuter: {
    marginHorizontal: 10,
    marginVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.sel,
    borderWidth: 1,
    borderColor: colors.selEdge,
    shadowColor: colors.sel,
    shadowOpacity: 0.55,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
    position: 'relative',
  },
  rowSelectedOuterCompact: {
    marginHorizontal: 6,
    marginVertical: 4,
  },
  rowPressed: {
    backgroundColor: 'rgba(255,255,255,0.025)',
  },
  leftAccent: {
    position: 'absolute',
    left: -10,
    top: 6,
    bottom: 6,
    width: 3,
    borderRadius: 2,
    backgroundColor: colors.selEdge,
    shadowColor: colors.selEdge,
    shadowOpacity: 0.8,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  leftAccentCompact: {
    left: 0,
    top: 0,
    bottom: 0,
    width: 2,
    borderTopLeftRadius: 6,
    borderBottomLeftRadius: 6,
    shadowRadius: 6,
  },
  rowInner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 12,
    paddingLeft: 12,
    paddingRight: 16,
  },
  rowSelectedInner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 12,
    paddingLeft: 10,
    paddingRight: 14,
  },
  rowInnerCompact: {
    paddingVertical: 10,
    paddingLeft: 10,
    paddingRight: 12,
  },
  rowSelectedInnerCompact: {
    paddingLeft: 12,
  },
  bulletCell: {
    width: 28,
    alignItems: 'center',
    paddingTop: 2,
  },
  bulletCellCompact: {
    width: 22,
  },
  bullet: {
    fontFamily: font.monoBold,
    fontSize: 14,
    includeFontPadding: false,
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  titleLine: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  title: {
    ...type.featureTitle,
    includeFontPadding: false,
    flexShrink: 1,
  },
  titleCompact: {
    fontSize: 13,
  },
  cursor: {
    width: 6,
    height: 12,
    backgroundColor: colors.white,
    marginLeft: 5,
  },
  statusText: {
    ...type.featureStatus,
    marginTop: 5,
    includeFontPadding: false,
  },
  statusTextCompact: {
    marginTop: 4,
    fontSize: 10.5,
  },
  statusIcon: {
    fontFamily: font.monoBold,
  },
  statusMeta: {
    fontFamily: font.mono,
    includeFontPadding: false,
  },
  path: {
    ...type.featurePath,
    marginTop: 5,
    includeFontPadding: false,
  },
  pathStack: {
    marginTop: 5,
    gap: 2,
  },
  branchOnly: {
    ...type.featurePath,
    includeFontPadding: false,
  },
  pathOnly: {
    marginTop: 0,
  },
  chev: {
    fontFamily: font.monoBold,
    fontSize: 14,
    paddingTop: 2,
    marginLeft: 4,
    includeFontPadding: false,
  },
});
