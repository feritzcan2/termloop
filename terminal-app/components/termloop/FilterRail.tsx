import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, type } from '../../lib/design';

export interface FilterRailItem {
  key: string;
  label: string;
  count?: number;
}

export function FilterRail({
  items,
  value,
  compact = false,
  onChange,
}: {
  items: FilterRailItem[];
  value: string;
  compact?: boolean;
  onChange: (key: string) => void;
}) {
  return (
    <View style={styles.wrap}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[styles.content, compact && styles.contentCompact]}
      >
        {items.map((item) => {
          const selected = item.key === value;
          return (
            <Pressable
              key={item.key}
              onPress={() => onChange(item.key)}
              style={({ pressed }) => [
                styles.pill,
                compact && styles.pillCompact,
                selected && styles.pillSelected,
                pressed && styles.pillPressed,
              ]}
            >
              <Text
                style={[styles.label, compact && styles.labelCompact, selected && styles.labelSelected]}
                numberOfLines={1}
              >
                {item.label}
              </Text>
              {typeof item.count === 'number' && (
                <Text style={[styles.count, compact && styles.countCompact, selected && styles.countSelected]}>
                  {String(item.count).padStart(2, '0')}
                </Text>
              )}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    backgroundColor: colors.bg,
  },
  content: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  contentCompact: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.lineStrong,
    backgroundColor: 'rgba(255,255,255,0.025)',
  },
  pillCompact: {
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  pillSelected: {
    backgroundColor: 'rgba(61,109,255,0.16)',
    borderColor: colors.selEdge,
    shadowColor: colors.selEdge,
    shadowOpacity: 0.22,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  pillPressed: {
    opacity: 0.8,
  },
  label: {
    ...type.featureStatus,
    color: colors.ink2,
    includeFontPadding: false,
  },
  labelCompact: {
    fontSize: 10.5,
  },
  labelSelected: {
    color: colors.white,
  },
  count: {
    ...type.featurePath,
    color: colors.ink4,
    includeFontPadding: false,
  },
  countCompact: {
    fontSize: 10,
  },
  countSelected: {
    color: colors.onSelDim,
  },
});
