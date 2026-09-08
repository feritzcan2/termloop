import type { WorkflowStepDto, WorkflowStepResultDto } from "@termloop/contract/current";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Screen, ScreenHeader } from "../../components/screen";
import { workflowResultLabel } from "../../presentation/workflow-execution";
import { color, radius, space } from "../../theme/tokens";
import { WorkflowButton } from "./workflow-controls";

export function WorkflowResultSheet(props: { step: WorkflowStepDto; result: WorkflowStepResultDto; close(): void }) {
  return <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={props.close}>
    <SafeAreaProvider><Screen>
      <ScreenHeader title="Step result" right={<WorkflowButton label="Done" onPress={props.close} />} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>{props.step.title}</Text>
        <View style={styles.meta}>
          <Text style={styles.outcome}>{workflowResultLabel(props.result.outcome)}</Text>
          <Text style={styles.caption}>Round {props.result.reviewCycle} · {new Date(props.result.completedAtEpochMs).toLocaleString()}</Text>
        </View>
        <Text style={styles.caption}>Recorded by the lead agent. Select text to copy. This saved result stays fixed while you read it.</Text>
        <Text selectable style={styles.result}>{props.result.summary}</Text>
      </ScrollView>
    </Screen></SafeAreaProvider>
  </Modal>;
}

const styles = StyleSheet.create({
  content: { padding: space.screen, gap: space.lg, paddingBottom: space.xl },
  title: { color: color.text, fontSize: 24, fontWeight: "700", lineHeight: 31 },
  meta: { backgroundColor: color.accentWash, borderRadius: radius.card, padding: space.lg, gap: space.sm },
  outcome: { color: color.accentStrong, fontSize: 17, fontWeight: "700" },
  caption: { color: color.textSecondary, fontSize: 12, lineHeight: 19 },
  result: { color: color.text, fontSize: 16, lineHeight: 25 },
});
