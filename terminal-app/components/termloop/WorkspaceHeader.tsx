import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { colors, type } from '../../lib/design';

export interface WorkspaceHeaderStat {
  label: string;
  value: string;
  tone?: 'default' | 'run' | 'input' | 'idle';
}

export function WorkspaceHeader({
  name,
  compact = false,
  badge,
  subtitle,
  stats,
}: {
  name: string;
  compact?: boolean;
  badge?: string;
  subtitle?: string;
  stats?: WorkspaceHeaderStat[];
}) {
  const opacity = useRef(new Animated.Value(1)).current;
  const hasMeta = Boolean(badge || subtitle || stats?.length);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.15, duration: 550, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 550, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return (
    <View style={[styles.shell, hasMeta && styles.shellWithMeta]}>
      <View style={styles.row}>
        <Text style={[styles.name, compact && styles.nameCompact]} numberOfLines={1}>
          {name.toUpperCase()}
        </Text>
        <Text style={[styles.sep, compact && styles.sepCompact]}>/</Text>
        <Animated.View style={[styles.caret, { opacity }]} />
        {badge && (
          <View style={[styles.badge, compact && styles.badgeCompact]}>
            <Text style={styles.badgeText}>{badge}</Text>
          </View>
        )}
      </View>
      {subtitle && (
        <Text style={[styles.subtitle, compact && styles.subtitleCompact]} numberOfLines={1}>
          {subtitle}
        </Text>
      )}
      {stats && stats.length > 0 && (
        <View style={styles.statsRow}>
          {stats.map((stat) => (
            <View
              key={`${stat.label}-${stat.value}`}
              style={[
                styles.statPill,
                stat.tone === 'run' && styles.statPillRun,
                stat.tone === 'input' && styles.statPillInput,
                stat.tone === 'idle' && styles.statPillIdle,
              ]}
            >
              <Text style={styles.statLabel}>{stat.label}</Text>
              <Text style={styles.statValue}>{stat.value}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    backgroundColor: colors.bg,
  },
  shellWithMeta: {
    gap: 8,
    paddingBottom: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  name: {
    ...type.workspaceName,
    color: colors.ink2,
    flexShrink: 1,
    minWidth: 0,
    textAlign: 'center',
  },
  sep: {
    ...type.workspaceName,
    color: colors.ink4,
  },
  nameCompact: {
    fontSize: 10,
    letterSpacing: 2.4,
  },
  sepCompact: {
    fontSize: 10,
    letterSpacing: 2.4,
  },
  badge: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.lineStrong,
    backgroundColor: 'rgba(125,227,255,0.08)',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeCompact: {
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  badgeText: {
    fontFamily: type.tabLabel.fontFamily,
    fontSize: 9.5,
    letterSpacing: 1.3,
    color: colors.cyan,
    includeFontPadding: false,
  },
  subtitle: {
    fontFamily: type.featurePath.fontFamily,
    fontSize: 11,
    color: colors.ink3,
    textAlign: 'center',
    includeFontPadding: false,
  },
  subtitleCompact: {
    fontSize: 10,
  },
  statsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
  },
  statPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.lineStrong,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  statPillRun: {
    backgroundColor: 'rgba(125,227,255,0.08)',
  },
  statPillInput: {
    backgroundColor: 'rgba(255,180,84,0.08)',
  },
  statPillIdle: {
    backgroundColor: 'rgba(255,255,255,0.025)',
  },
  statLabel: {
    fontFamily: type.featurePath.fontFamily,
    fontSize: 10,
    color: colors.ink3,
    letterSpacing: 0.6,
    includeFontPadding: false,
  },
  statValue: {
    fontFamily: type.featureStatus.fontFamily,
    fontSize: 10.5,
    color: colors.ink1,
    includeFontPadding: false,
  },
  caret: {
    width: 6,
    height: 12,
    backgroundColor: colors.selEdge,
    shadowColor: colors.selEdge,
    shadowOpacity: 0.6,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
});
