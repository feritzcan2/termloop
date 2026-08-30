import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { color, radius, space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

export interface StewardVoiceProjectOption {
  readonly id: string;
  readonly name: string;
}

export interface StewardVoiceProjectSelectorProps {
  readonly disabled: boolean;
  readonly projects: readonly StewardVoiceProjectOption[];
  readonly selectedProjectId: string | undefined;
  readonly onSelect: (projectId: string) => void;
}

export function StewardVoiceProjectSelector(props: StewardVoiceProjectSelectorProps) {
  return (
    <View style={styles.selector}>
      <Text style={styles.label}>KONUŞULAN PROJE</Text>
      <ScrollView
        contentContainerStyle={styles.options}
        horizontal
        showsHorizontalScrollIndicator={false}
      >
        {props.projects.map((project) => {
          const selected = project.id === props.selectedProjectId;
          const disabled = selected || props.disabled;
          return (
            <Pressable
              accessibilityLabel={`${project.name} projesiyle konuş`}
              accessibilityRole="button"
              accessibilityState={{ disabled, selected }}
              disabled={disabled}
              key={project.id}
              onPress={() => props.onSelect(project.id)}
              style={({ pressed }) => [
                styles.option,
                selected && styles.optionSelected,
                !selected && disabled && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <Text
                numberOfLines={1}
                style={[styles.optionText, selected && styles.optionTextSelected]}
              >
                {project.name}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  selector: { gap: space.xs },
  label: {
    color: color.textMuted,
    fontFamily: fontFamily.mono,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
  },
  options: { gap: space.sm, paddingRight: space.sm },
  option: {
    maxWidth: 190,
    minHeight: 38,
    justifyContent: "center",
    paddingHorizontal: 13,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.borderStrong,
    backgroundColor: color.bgApp,
  },
  optionSelected: { borderColor: color.success, backgroundColor: "#273c35" },
  optionText: { color: color.textSecondary, fontSize: 12, fontWeight: "700" },
  optionTextSelected: { color: color.success },
  disabled: { opacity: 0.38 },
  pressed: { opacity: 0.74, transform: [{ scale: 0.98 }] },
});
