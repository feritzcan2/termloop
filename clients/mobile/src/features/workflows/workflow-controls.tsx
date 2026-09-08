import { useState, type PropsWithChildren } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { color, geometry, radius, space } from "../../theme/tokens";

export function WorkflowButton(props: { label: string; onPress(): void; disabled?: boolean; danger?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={props.label} accessibilityState={{ disabled: Boolean(props.disabled) }} disabled={props.disabled} onPress={props.onPress} style={[styles.button, props.disabled && styles.disabled]}>
    <Text style={[styles.buttonText, props.danger && { color: color.danger }]}>{props.label}</Text>
  </Pressable>;
}

export function WorkflowField(props: { label: string; value: string; change(value: string): void; disabled: boolean; multiline?: boolean; maxLength: number; placeholder?: string }) {
  return <View style={styles.field}><Text style={styles.label}>{props.label}</Text><TextInput
    accessibilityLabel={props.label} value={props.value} onChangeText={props.change} editable={!props.disabled}
    multiline={props.multiline} maxLength={props.maxLength} placeholder={props.placeholder} placeholderTextColor={color.textMuted}
    textAlignVertical={props.multiline ? "top" : "center"} style={[styles.input, props.multiline && styles.instructions]}
  /></View>;
}

export interface WorkflowOption { value: string; label: string; disabled?: boolean }

export function WorkflowSelect(props: { label: string; value: string; options: readonly WorkflowOption[]; change(value: string): void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = props.options.find((option) => option.value === props.value);
  const filtered = props.options.filter((option) => option.label.toLowerCase().includes(search.toLowerCase()));
  return <View style={styles.field}>
    <Text style={styles.label}>{props.label}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`${props.label}: ${selected?.label ?? `${props.value} (unavailable)`}`} accessibilityState={{ expanded: open, disabled: props.disabled }} disabled={props.disabled} onPress={() => { setOpen(!open); setSearch(""); }} style={styles.select}>
      <Text style={styles.value}>{selected?.label ?? `${props.value} (unavailable)`}</Text><Text style={styles.chevron}>{open ? "⌃" : "⌄"}</Text>
    </Pressable>
    {open ? <View style={styles.options}>
      {props.options.length > 6 ? <TextInput accessibilityLabel={`Search ${props.label.toLowerCase()}`} value={search} onChangeText={setSearch} editable={!props.disabled} placeholder="Search options" placeholderTextColor={color.textMuted} style={styles.input} /> : null}
      <ScrollView nestedScrollEnabled style={styles.optionScroll} keyboardShouldPersistTaps="handled">
        {filtered.map((option) => <Pressable key={option.value} accessibilityRole="radio" accessibilityLabel={option.label} accessibilityState={{ checked: props.value === option.value, disabled: Boolean(props.disabled || option.disabled) }} disabled={props.disabled || option.disabled} onPress={() => { props.change(option.value); setOpen(false); }} style={[styles.option, props.value === option.value && styles.selected, option.disabled && styles.disabled]}>
          <Text style={styles.value}>{option.label}</Text>{props.value === option.value ? <Text style={styles.chevron}>✓</Text> : null}
        </Pressable>)}
        {!filtered.length ? <Text style={styles.help}>No matching options.</Text> : null}
      </ScrollView>
    </View> : null}
  </View>;
}

export function WorkflowAdvanced(props: PropsWithChildren<{ title: string; disabled: boolean }>) {
  const [open, setOpen] = useState(false);
  return <View style={styles.advanced}>
    <Pressable accessibilityRole="button" accessibilityLabel={props.title} accessibilityState={{ expanded: open, disabled: props.disabled }} disabled={props.disabled} onPress={() => setOpen(!open)} style={styles.option}>
      <Text style={styles.label}>{props.title}</Text><Text style={styles.chevron}>{open ? "⌃" : "⌄"}</Text>
    </Pressable>
    {open ? <View style={styles.advancedFields}>{props.children}</View> : null}
  </View>;
}

const styles = StyleSheet.create({
  field: { gap: 7 }, label: { color: color.text, fontSize: 13, fontWeight: "600" },
  input: { minHeight: geometry.touchTarget, backgroundColor: color.bgRaised, borderWidth: 1, borderColor: color.borderStrong, borderRadius: radius.control, color: color.text, fontSize: 15, padding: space.md },
  instructions: { minHeight: 130 }, select: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 48, padding: space.md, borderWidth: 1, borderColor: color.border, borderRadius: radius.control, backgroundColor: color.bgRaised },
  value: { flex: 1, color: color.text, fontSize: 14, lineHeight: 20 }, chevron: { color: color.accentStrong, fontSize: 17 },
  options: { borderWidth: 1, borderColor: color.border, borderRadius: radius.control, overflow: "hidden" }, optionScroll: { maxHeight: 260 },
  option: { minHeight: geometry.touchTarget, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, padding: space.md },
  selected: { backgroundColor: color.accentWash }, disabled: { opacity: 0.45 },
  button: { minHeight: geometry.touchTarget, justifyContent: "center", alignItems: "center", paddingHorizontal: space.md },
  buttonText: { color: color.accentStrong, fontSize: 13, fontWeight: "600" }, help: { color: color.textSecondary, fontSize: 13, padding: space.md },
  advanced: { borderWidth: 1, borderColor: color.border, borderRadius: radius.control }, advancedFields: { gap: space.md, padding: space.md, paddingTop: 0 },
});
