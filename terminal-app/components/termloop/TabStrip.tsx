import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, type } from '../../lib/design';

export type TabKey = 'work' | 'agents';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'work', label: 'Work' },
  { key: 'agents', label: 'Agents' },
];

export function TabStrip({
  value,
  onChange,
  compact = false,
}: {
  value: TabKey;
  onChange: (k: TabKey) => void;
  compact?: boolean;
}) {
  return (
    <View style={[styles.row, compact && styles.rowCompact]}>
      {TABS.map((t) => {
        const on = t.key === value;
        return (
          <Pressable
            key={t.key}
            style={[styles.tab, compact && styles.tabCompact, on && styles.tabOn]}
            onPress={() => onChange(t.key)}
            hitSlop={6}
          >
            <Text style={[styles.label, compact && styles.labelCompact, on && styles.labelOn]}>
              {t.label.toUpperCase()}
            </Text>
            {on && <View style={[styles.underline, compact && styles.underlineCompact]} />}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingTop: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  rowCompact: {
    paddingTop: 8,
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    position: 'relative',
  },
  tabCompact: {
    paddingVertical: 10,
  },
  tabOn: {
    backgroundColor: 'rgba(61,109,255,0.08)',
  },
  label: {
    ...type.tabLabel,
    color: colors.ink3,
  },
  labelCompact: {
    fontSize: 10,
    letterSpacing: 2.2,
  },
  labelOn: {
    color: colors.ink1,
  },
  underline: {
    position: 'absolute',
    left: '22%',
    right: '22%',
    bottom: -StyleSheet.hairlineWidth,
    height: 2,
    backgroundColor: colors.selEdge,
    shadowColor: colors.selEdge,
    shadowOpacity: 0.6,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  underlineCompact: {
    left: '18%',
    right: '18%',
  },
});
