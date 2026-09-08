import type { AgentStatusDto, SessionDto, WorkflowExecutionDto, WorkflowStepDto, WorkflowStepResultDto } from "@termloop/contract/current";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Banner, StatePill } from "../../components/primitives";
import { relativeAge, relativeAgeSentence } from "../../presentation/relative-time";
import { workflowExecutionView, workflowResultLabel, type WorkflowAgentView, type WorkflowStepView } from "../../presentation/workflow-execution";
import { color, geometry, radius, space, toneColor } from "../../theme/tokens";
import { WorkflowAdvanced, WorkflowButton } from "./workflow-controls";
import { WorkflowResultSheet } from "./workflow-result-sheet";

export function WorkflowExecutionCard(props: {
  execution: WorkflowExecutionDto;
  sessions: readonly SessionDto[];
  statuses: readonly AgentStatusDto[];
  online: boolean;
  agentDataStale: boolean;
  checkedAt: number | undefined;
  refreshing: boolean;
  error: string | undefined;
  refresh(): void;
  openSession(sessionId: string): void;
}) {
  const { execution, online } = props;
  const view = workflowExecutionView(execution, props.sessions, props.statuses);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<{ step: WorkflowStepDto; result: WorkflowStepResultDto }>();
  const stale = !online || props.error !== undefined;
  const agentStale = stale || props.agentDataStale;
  const now = Date.now();
  const firstReview = execution.steps.findIndex((step) => step.kind === "review");
  const reviewCount = execution.steps.filter((step) => step.kind === "review").length;
  const age = relativeAge(execution.startedAtEpochMs, view.completed ? execution.updatedAtEpochMs : stale ? props.checkedAt ?? execution.updatedAtEpochMs : now);

  return <View style={styles.content}>
    <View style={styles.nameRow}><Text accessibilityRole="header" style={styles.name}>{execution.workflowName}</Text><StatePill label={view.label} tone={stale ? "quiet" : view.tone} /></View>
    <View style={[styles.hero, (stale || execution.status === "paused") && styles.heroMuted]}>
      <Text style={styles.eyebrow}>{stale ? "LAST KNOWN STATE" : view.completed ? "FINAL OUTCOME" : "HAPPENING NOW"}</Text>
      <Text style={styles.headline}>{view.headline}</Text>
      <Text style={styles.detail}>{view.detail}</Text>
      <View style={styles.facts}>
        <Text style={styles.fact}>{view.progress}</Text>
        {reviewCount > 0 ? <Text style={styles.fact}>Round {execution.reviewCycle} / {execution.maxReviewCycles}</Text> : null}
        <Text style={styles.fact}>{view.completed ? "Duration" : "Elapsed"} {age === "now" ? "<10s" : age}</Text>
      </View>
      <View accessibilityRole="progressbar" accessibilityLabel="Workflow outcomes recorded" accessibilityValue={{ min: 0, max: view.rows.length, now: view.done, text: `${view.done} of ${view.rows.length} step outcomes recorded. Review rounds can revisit steps.` }} style={styles.meter}>
        {view.rows.map((row) => <View key={row.step.id} style={[styles.segment, (row.state === "complete" || row.state === "skipped") && styles.segmentDone, (row.state === "current" || row.state === "recording") && styles.segmentCurrent, stale && styles.segmentStale]} />)}
      </View>
    </View>

    {!online ? <Banner kind="warning" message={`Offline — showing saved progress.${props.checkedAt === undefined ? "" : ` Last checked at ${new Date(props.checkedAt).toLocaleTimeString()}.`} Agent states may have changed.`} />
      : props.error ? <Banner kind="warning" message="Updates are delayed. Saved progress is still readable; refresh to check the Mac again." />
      : props.agentDataStale ? <Banner kind="warning" message="Agent states are temporarily unavailable. Workflow progress is shown separately from the last known agent states." /> : null}

    {!agentStale && view.attentionAgents.length ? <View style={styles.attention}>
      <Text style={styles.attentionTitle}>Needs your attention</Text>
      {view.attentionAgents.map((agent) => <AgentLink key={agent.id} agent={agent} label={agent.provider} online={online} stale={false} open={props.openSession} />)}
    </View> : null}

    <View style={styles.leadRow}>
      <Text style={styles.eyebrow}>{view.completed ? "LEAD AGENT" : execution.status === "paused" ? "RECOVERY" : "CURRENT AGENTS"}</Text>
      {(view.completed || execution.status === "paused" ? [view.lead] : view.currentAgents).map((agent) => <AgentLink key={agent.id} agent={agent} label={agent.id === view.lead.id ? `${agent.provider} · lead` : agent.provider} online={online} stale={agentStale} open={props.openSession} />)}
      {!view.completed && execution.status !== "paused" && !view.currentAgents.some((agent) => agent.id === view.lead.id) ? <WorkflowButton label={`Open lead agent · ${view.lead.provider}`} disabled={!online || !view.lead.available} onPress={() => props.openSession(view.lead.id)} /> : null}
    </View>
    <View style={styles.sectionHead}><Text style={styles.sectionTitle}>Steps & results</Text><Text style={styles.hint}>Tap a step for details</Text></View>
    <View>
      {view.rows.map((row) => {
        const isCurrent = row.state === "current" || row.state === "recording";
        const open = expanded[row.step.id] ?? isCurrent;
        return <View key={row.step.id}>
          {row.index === firstReview && reviewCount > 1 ? <View style={styles.parallel}><Text style={styles.parallelTitle}>PARALLEL REVIEW · {reviewCount} AGENTS</Text><Text style={styles.hint}>Each reviewer has its own outcome.</Text></View> : null}
          <View style={styles.step}>
            <View style={styles.rail} accessibilityElementsHidden>
              <View style={[styles.number, isCurrent && styles.numberCurrent, (row.state === "complete" || row.state === "skipped") && styles.numberDone]}><Text style={[styles.numberText, isCurrent && styles.numberTextCurrent]}>{row.state === "complete" ? "✓" : row.state === "skipped" ? "–" : row.index + 1}</Text></View>
              {row.index < view.rows.length - 1 ? <View style={styles.line} /> : null}
            </View>
            <View style={[styles.stepBody, isCurrent && styles.currentBody]}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Step ${row.index + 1}: ${row.step.title}. ${row.label}`} accessibilityState={{ expanded: open }} onPress={() => setExpanded((value) => ({ ...value, [row.step.id]: !open }))} style={styles.stepToggle}>
                <View style={styles.stepTitleArea}><Text style={styles.stepTitle}>{row.step.title}</Text><Text style={styles.owner}>{row.owner}</Text></View>
                <Text style={styles.chevron}>{open ? "⌃" : "⌄"}</Text>
              </Pressable>
              <View style={styles.stepMeta}><Text style={[styles.stepStatus, { color: stale ? color.textMuted : row.tone === "done" ? color.success : row.tone === "quiet" ? color.textMuted : toneColor[row.tone] }]}>{row.label}</Text>
                {row.agent && isCurrent ? <Text style={styles.hint}>{agentStale ? "Last known: " : ""}{row.agent.status}</Text> : null}
              </View>
              {row.result ? <ResultPreview row={row} expanded={open} show={() => setResult({ step: row.step, result: row.result! })} /> : null}
              {open ? <View style={styles.stepDetails}>
                <Text style={styles.detail}>{row.detail}</Text>
                {row.agent ? <AgentLink agent={row.agent} label={`Open ${row.agent.provider}`} online={online} stale={agentStale} open={props.openSession} /> : <Text style={styles.hint}>The agent conversation will appear here when it starts.</Text>}
                <WorkflowAdvanced title="Step instructions" disabled={false}><Text selectable style={styles.instructions}>{row.step.instructions}</Text></WorkflowAdvanced>
              </View> : null}
            </View>
          </View>
        </View>;
      })}
    </View>
    {execution.steps.some((step) => step.kind === "fix") ? <Text style={styles.loop}>↳ Fixes return to all reviewers while review rounds remain. A review limit is not an approval.</Text> : null}
    <WorkflowAdvanced title="Workflow goal" disabled={false}><Text selectable style={styles.instructions}>{execution.goal}</Text></WorkflowAdvanced>
    <View style={styles.syncRow}><View style={styles.syncText}>
      <Text style={styles.hint}>{!online ? "Offline snapshot" : props.error ? "Updates delayed" : props.refreshing ? "Checking the Mac…" : "Auto-refresh on"}{props.checkedAt === undefined ? " · Waiting for first sync" : ` · Checked ${online ? relativeAgeSentence(props.checkedAt, now) : new Date(props.checkedAt).toLocaleTimeString()}`}</Text>
      <Text style={styles.hint}>Latest saved result per step; earlier review rounds may be replaced.</Text>
    </View><WorkflowButton label="Refresh progress" disabled={!online || props.refreshing} onPress={props.refresh} /></View>
    {result ? <WorkflowResultSheet step={result.step} result={result.result} close={() => setResult(undefined)} /> : null}
  </View>;
}

function AgentLink(props: { agent: WorkflowAgentView; label: string; online: boolean; stale: boolean; open(id: string): void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`${props.label}: ${props.agent.name}. ${props.stale ? "Last known: " : ""}${props.agent.status}`} accessibilityState={{ disabled: !props.online || !props.agent.available }} disabled={!props.online || !props.agent.available} onPress={() => props.open(props.agent.id)} style={[styles.agent, (!props.online || !props.agent.available) && styles.disabled]}>
    <View style={styles.agentText}><Text style={styles.agentName}>{props.label}</Text><Text style={styles.hint} numberOfLines={1}>{props.agent.name}</Text></View>
    <Text style={styles.agentState}>{props.stale ? "Last known · " : ""}{props.agent.status}</Text><Text style={styles.chevron}>›</Text>
  </Pressable>;
}

function ResultPreview({ row, expanded, show }: { row: WorkflowStepView; expanded: boolean; show(): void }) {
  const result = row.result!;
  return <Pressable accessibilityRole="button" accessibilityLabel={`Read result: ${row.step.title}, round ${result.reviewCycle}, ${workflowResultLabel(result.outcome)}`} onPress={show} style={styles.resultPreview}>
    <Text style={styles.resultMeta}>{row.previousRound ? "PREVIOUS ROUND" : "SAVED RESULT"} · {result.reviewCycle} · {workflowResultLabel(result.outcome)}</Text>
    {expanded ? <Text style={styles.resultText} numberOfLines={2}>{result.summary}</Text> : null}
    <Text style={styles.resultAction}>Read full result →</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  content: { gap: space.lg }, nameRow: { gap: space.sm, alignItems: "flex-start" }, name: { color: color.text, fontSize: 21, lineHeight: 28, fontWeight: "700" },
  hero: { backgroundColor: color.accentWash, borderRadius: radius.card, padding: space.lg, gap: space.sm }, heroMuted: { backgroundColor: color.bgSidebar },
  eyebrow: { color: color.textSecondary, fontSize: 10, lineHeight: 16, letterSpacing: 1, fontWeight: "700" }, headline: { color: color.text, fontSize: 19, lineHeight: 25, fontWeight: "700" },
  detail: { color: color.textSecondary, fontSize: 13, lineHeight: 20 }, facts: { flexDirection: "row", flexWrap: "wrap", gap: space.md, marginTop: space.sm }, fact: { color: color.accentStrong, fontSize: 11, fontWeight: "600" },
  meter: { flexDirection: "row", gap: 5, marginTop: space.sm }, segment: { flex: 1, height: 5, backgroundColor: color.border, borderRadius: 3 }, segmentDone: { backgroundColor: color.success }, segmentCurrent: { backgroundColor: color.accent }, segmentStale: { opacity: 0.45 },
  leadRow: { gap: space.sm }, sectionHead: { gap: 4 }, sectionTitle: { color: color.text, fontSize: 16, fontWeight: "700" }, hint: { color: color.textMuted, fontSize: 11, lineHeight: 17 },
  attention: { backgroundColor: color.dangerWash, borderRadius: radius.card, padding: space.md, gap: space.sm }, attentionTitle: { color: color.attention, fontSize: 14, fontWeight: "700" },
  parallel: { marginLeft: 38, marginBottom: space.md, gap: 3 }, parallelTitle: { color: color.accentStrong, fontSize: 10, lineHeight: 16, fontWeight: "700", letterSpacing: 0.6 },
  step: { flexDirection: "row", gap: space.sm }, rail: { width: 28, alignItems: "center" }, number: { height: 28, width: 28, borderRadius: 14, borderWidth: 1, borderColor: color.borderStrong, alignItems: "center", justifyContent: "center", backgroundColor: color.bgRaised }, numberCurrent: { backgroundColor: color.accentStrong, borderColor: color.accentStrong }, numberDone: { backgroundColor: color.successWash, borderColor: color.success }, numberText: { color: color.textSecondary, fontSize: 12, fontWeight: "700" }, numberTextCurrent: { color: color.onAccent }, line: { flex: 1, minHeight: 16, width: 1, backgroundColor: color.border },
  stepBody: { flex: 1, minWidth: 0, padding: space.md, paddingTop: 0, marginBottom: space.md, borderRadius: radius.control }, currentBody: { backgroundColor: color.accentWash, paddingTop: space.sm },
  stepToggle: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: geometry.touchTarget }, stepTitleArea: { flex: 1, minWidth: 0, gap: 3 }, stepTitle: { color: color.text, fontSize: 14, fontWeight: "600", lineHeight: 20 }, owner: { color: color.textSecondary, fontSize: 11, lineHeight: 17 }, chevron: { color: color.accentStrong, fontSize: 18 }, stepMeta: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: 5 }, stepStatus: { fontSize: 11, fontWeight: "700", lineHeight: 17 }, stepDetails: { gap: space.md, marginTop: space.md },
  agent: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, minHeight: geometry.touchTarget, padding: space.sm, backgroundColor: color.bgRaised, borderWidth: 1, borderColor: color.border, borderRadius: radius.control }, agentText: { flex: 1, minWidth: 70, gap: 2 }, agentName: { color: color.accentStrong, fontSize: 13, fontWeight: "600", lineHeight: 19 }, agentState: { color: color.textSecondary, fontSize: 11, lineHeight: 17, maxWidth: "50%" }, disabled: { opacity: 0.6 },
  resultPreview: { borderLeftWidth: 2, borderLeftColor: color.borderStrong, paddingLeft: space.sm, gap: 5, marginTop: space.sm, minHeight: geometry.touchTarget }, resultMeta: { color: color.textMuted, fontSize: 9, lineHeight: 15, fontWeight: "600" }, resultText: { color: color.textSecondary, fontSize: 12, lineHeight: 18 }, resultAction: { color: color.accentStrong, fontSize: 11, fontWeight: "600", lineHeight: 19 },
  instructions: { color: color.text, fontSize: 13, lineHeight: 21 }, loop: { color: color.textSecondary, fontSize: 12, lineHeight: 19 }, syncRow: { gap: space.sm }, syncText: { gap: 4 },
});
