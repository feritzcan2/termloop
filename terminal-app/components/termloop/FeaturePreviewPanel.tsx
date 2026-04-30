import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, status as statusMap, type, FeatureStatus } from '../../lib/design';

export function FeaturePreviewPanel({
  title,
  status,
  summary,
  activity,
  branch,
  path,
  epicName,
  agent,
}: {
  title: string;
  status: FeatureStatus;
  summary: string;
  activity: string;
  branch: string;
  path: string;
  epicName: string;
  agent?: string;
}) {
  const state = statusMap[status];

  return (
    <View style={styles.panel}>
      <View style={styles.eyebrowRow}>
        <Text style={styles.eyebrow}>WORK PREVIEW</Text>
        <View style={styles.statusPill}>
          <Text style={styles.statusPillText}>
            {state.icon} {state.label.toUpperCase()}
          </Text>
        </View>
      </View>

      <Text style={styles.title}>{title}</Text>
      <Text style={styles.summary}>{summary}</Text>

      <View style={styles.metaGrid}>
        <View style={styles.metaCard}>
          <Text style={styles.metaLabel}>Epic</Text>
          <Text style={styles.metaValue}>{epicName}</Text>
        </View>
        <View style={styles.metaCard}>
          <Text style={styles.metaLabel}>Branch</Text>
          <Text style={styles.metaValue}>{branch}</Text>
        </View>
        <View style={styles.metaCard}>
          <Text style={styles.metaLabel}>Agent</Text>
          <Text style={styles.metaValue}>{agent || 'Unassigned'}</Text>
        </View>
        <View style={styles.metaCard}>
          <Text style={styles.metaLabel}>Last Activity</Text>
          <Text style={styles.metaValue}>{activity}</Text>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Workspace Path</Text>
        <Text style={styles.path}>{path}</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Quick Actions</Text>
        <View style={styles.actions}>
          {['Open Terminal', 'Reply', 'Files'].map((label) => (
            <Pressable key={label} style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}>
              <Text style={styles.actionText}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    flex: 1,
    minHeight: 0,
    backgroundColor: colors.bgInk,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.lineStrong,
    borderRadius: 22,
    padding: 20,
    gap: 18,
  },
  eyebrowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  eyebrow: {
    ...type.tabLabel,
    fontSize: 10,
    letterSpacing: 2.1,
    color: colors.ink3,
  },
  statusPill: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: 'rgba(125,227,255,0.08)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.lineStrong,
  },
  statusPillText: {
    ...type.featureStatus,
    color: colors.cyan,
    fontSize: 10.5,
    includeFontPadding: false,
  },
  title: {
    fontFamily: type.featureTitle.fontFamily,
    fontSize: 22,
    lineHeight: 28,
    color: colors.ink1,
  },
  summary: {
    fontFamily: type.featurePath.fontFamily,
    fontSize: 12.5,
    lineHeight: 20,
    color: colors.ink2,
  },
  metaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  metaCard: {
    minWidth: '47%',
    flexGrow: 1,
    padding: 12,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    gap: 5,
  },
  metaLabel: {
    ...type.featurePath,
    color: colors.ink3,
    fontSize: 10,
    letterSpacing: 0.5,
    includeFontPadding: false,
  },
  metaValue: {
    ...type.featureStatus,
    color: colors.ink1,
    includeFontPadding: false,
  },
  section: {
    gap: 8,
  },
  sectionTitle: {
    ...type.tabLabel,
    fontSize: 10,
    letterSpacing: 1.8,
    color: colors.ink3,
  },
  path: {
    ...type.featurePath,
    color: colors.ink2,
    lineHeight: 18,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  action: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(61,109,255,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.selEdge,
  },
  actionPressed: {
    opacity: 0.8,
  },
  actionText: {
    ...type.featureStatus,
    color: colors.white,
    includeFontPadding: false,
  },
});
