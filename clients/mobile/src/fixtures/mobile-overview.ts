import type {
  AgentCapabilityDto,
  AgentStatusDto,
  CompanionMessageDto,
  PlaybookDto,
  PlaybookRuntimeResult,
  ProjectDto,
  SessionDto,
  TaskDto,
  TaskWorktreeChangeListResult,
  TaskWorktreeDiffResult,
  TaskWorktreePreImageResult,
} from "@termloop/contract/current";

const now = 1_786_617_600_000;

export const fixtureProjects: ProjectDto[] = [
  {
    id: "project-termloop-next",
    name: "TermLoop Next",
    folder_path: "/Users/demo/Projects/termloop-next",
  },
];

export const fixtureTasks: TaskDto[] = [
  {
    id: "task-mobile",
    project_id: "project-termloop-next",
    title: "Build the mobile client foundation",
    brief: "Create the Expo shell and late-attach-ready presentation.",
    jira_url: null,
    status: "open",
    archived_at_epoch_ms: null,
    branch: { repository_root: "/Users/demo/Projects/termloop-next", name: "termloop/mobile" },
    worktree: { path: "/Users/demo/Projects/termloop-mobile" },
    rank: 0,
    created_at_epoch_ms: now - 7_200_000,
    updated_at_epoch_ms: now - 120_000,
    worktree_health: {
      observation_sequence: 42,
      observed_at_epoch_ms: now - 15_000,
      path_state: "present",
      registration_state: "matching",
      head_state: "matching",
      launch_ready: true,
      checked_out_branch: "termloop/mobile",
      change_count: 4,
      tracked_state: "changed",
      staged_state: "clean",
      untracked_state: "absent",
      ignored_state: "absent",
      submodule_state: "absent",
      worktree_lock_state: "absent",
      index_lock_state: "absent",
      upstream_state: "notConfigured",
      summary: "attention",
    },
    worktree_presence: {
      observation_sequence: 42,
      observed_at_epoch_ms: now - 15_000,
      attached_sessions: [{ session_id: "session-claude", kind: "Agent" }],
      total_count: 1,
      terminal_count: 0,
      agent_count: 1,
      truncated: false,
    },
  },
];

/// One bounded worktree observation for the native Changes screen. These are
/// fixtures only: the real phone asks core for a fresh observation before it
/// lets a reviewer inspect a patch.
export const fixtureTaskWorktreeChanges: TaskWorktreeChangeListResult = {
  task_id: "task-mobile",
  observation_id: "mock-mobile-changes-42",
  worktree_generation: 1,
  truncated: false,
  entries: [
    {
      entry_id: "mock-task-route", display_path: "src/app/task/[taskId].tsx", original_display_path: null,
      path_encoding: "utf8", side: "unstaged", kind: "modified", render_state: "available",
    },
    {
      entry_id: "mock-task-presentation", display_path: "src/presentation/task-presentation.ts", original_display_path: null,
      path_encoding: "utf8", side: "unstaged", kind: "modified", render_state: "available",
    },
    {
      entry_id: "mock-task-tests", display_path: "test/presentation/task-presentation.test.ts", original_display_path: null,
      path_encoding: "utf8", side: "unstaged", kind: "added", render_state: "available",
    },
    {
      entry_id: "mock-task-image", display_path: "assets/review.png", original_display_path: null,
      path_encoding: "utf8", side: "untracked", kind: "untracked", render_state: "notShown",
    },
  ],
};

export const fixtureTaskWorktreeDiffs: Record<string, TaskWorktreeDiffResult> = {
  "mock-task-route": {
    task_id: "task-mobile", observation_id: "mock-mobile-changes-42", entry_id: "mock-task-route", state: "patch",
    patch: `diff --git a/src/app/task/[taskId].tsx b/src/app/task/[taskId].tsx
index 4f3a2a1..a93fe9d 100644
--- a/src/app/task/[taskId].tsx
+++ b/src/app/task/[taskId].tsx
@@ -116,6 +116,10 @@ export default function TaskRoute() {
         <Section label="Worktree">
           <Text style={styles.mono}>{task.worktree.path}</Text>
+          <SecondaryButton
+            label="Review changes"
+            onPress={() => router.push("/task/[taskId]/changes")}
+          />
         </Section>
`,
  },
  "mock-task-presentation": {
    task_id: "task-mobile", observation_id: "mock-mobile-changes-42", entry_id: "mock-task-presentation", state: "patch",
    patch: `diff --git a/src/presentation/task-presentation.ts b/src/presentation/task-presentation.ts
index 2a39954..7caa9d8 100644
--- a/src/presentation/task-presentation.ts
+++ b/src/presentation/task-presentation.ts
@@ -154,6 +154,9 @@ export function taskChangeCount(task: TaskDto): number | undefined {
   return count > 0 ? count : undefined;
 }
+
+export function taskChangeLabel(count: number): string {
+  return \`${"${count}"} changes\`;
+}
`,
  },
  "mock-task-tests": {
    task_id: "task-mobile", observation_id: "mock-mobile-changes-42", entry_id: "mock-task-tests", state: "patch",
    patch: `diff --git a/test/presentation/task-presentation.test.ts b/test/presentation/task-presentation.test.ts
new file mode 100644
index 0000000..c33fd20
--- /dev/null
+++ b/test/presentation/task-presentation.test.ts
@@ -0,0 +1,5 @@
+import { expect, test } from "vitest";
+
+test("shows the change count", () => {
+  expect("4 changes").toBe("4 changes");
+});
`,
  },
  "mock-task-image": {
    task_id: "task-mobile", observation_id: "mock-mobile-changes-42", entry_id: "mock-task-image", state: "notShown", patch: null,
  },
};

export const fixtureTaskWorktreePreImages: Record<string, TaskWorktreePreImageResult> = {
  "mock-task-route": {
    task_id: "task-mobile", observation_id: "mock-mobile-changes-42", entry_id: "mock-task-route",
    state: "truncated", revision: "head", content: null,
  },
  "mock-task-presentation": {
    task_id: "task-mobile", observation_id: "mock-mobile-changes-42", entry_id: "mock-task-presentation",
    state: "notShown", revision: "head", content: null,
  },
  // An added file has no old-side text; the patch itself reconstructs the full
  // current source when the reviewer selects Full file.
  "mock-task-tests": {
    task_id: "task-mobile", observation_id: "mock-mobile-changes-42", entry_id: "mock-task-tests",
    state: "absent", revision: "head", content: null,
  },
  "mock-task-image": {
    task_id: "task-mobile", observation_id: "mock-mobile-changes-42", entry_id: "mock-task-image",
    state: "notShown", revision: "head", content: null,
  },
};

export const fixtureSessions: SessionDto[] = [
  {
    id: "session-claude",
    project_id: "project-termloop-next",
    name: "Mobile architecture",
    kind: "Agent",
    process: {
      program: "claude",
      args: [],
      cwd: "/Users/demo/Projects/termloop-mobile",
      agent_id: "claude",
      template_ref: null,
      template_version: null,
    },
    lifecycle_state: "running",
    runtime_epoch: 17,
    archived_at_epoch_ms: null,
    resume_failure_reason: null,
    retryable: false,
    closable: false,
    forkable: true,
    ask_to_source_session_id: null,
    run_configuration_id: null,
  },
];

export const fixtureAgentStatuses: AgentStatusDto[] = [
  {
    sessionId: "session-claude",
    status: "awaitingInput",
    source: "hook",
    observedAtEpochMs: now - 30_000,
  },
];

export const fixtureReplay = new TextEncoder().encode(
  "TermLoop Mobile foundation\r\n$ pnpm --filter @termloop/mobile check\r\n✓ ready for review\r\n",
);

/// A pipeline the mock Project is walking, standing at its third question. It
/// exists so the phone's pipeline surface can be read without a paired Mac, and
/// it is a presentation fixture only — never durable truth.
export const fixturePlaybook: PlaybookDto = {
  projectId: "project-termloop-next",
  revision: 6,
  activePipelineName: "Dev PR to production",
  milestones: [
    {
      id: "code-done",
      title: "Did the agent finish the code?",
      gate: "automatic",
      routineId: "routine-code",
      retryDelaySeconds: 600,
      completeWhen: "The Task branch has commits and no agent is still working.",
      whileWaiting: { mode: "off", instructions: "" },
      workerId: "worker-1",
      approver: null,
    },
    {
      id: "self-review",
      title: "Has a reviewer agent read the diff?",
      gate: "automatic",
      routineId: "routine-review",
      retryDelaySeconds: 900,
      completeWhen: "A reviewer agent has reported on the branch diff.",
      whileWaiting: { mode: "off", instructions: "" },
      workerId: "worker-1",
      approver: null,
    },
    {
      id: "review-requested",
      title: "Has a human review been requested?",
      gate: "automatic",
      routineId: "routine-request",
      retryDelaySeconds: 720,
      completeWhen: "A review request naming this pull request exists.",
      whileWaiting: { mode: "ask", instructions: "Offer to request review." },
      workerId: "worker-1",
      approver: null,
    },
    {
      id: "approved",
      title: "Did the reviewer approve the pull request?",
      gate: "human",
      routineId: "",
      retryDelaySeconds: 0,
      completeWhen: "The named reviewer explicitly approves the pull request.",
      whileWaiting: { mode: "off", instructions: "" },
      workerId: "worker-1",
      approver: "Nurguyl",
    },
    {
      id: "deployed",
      title: "Is the change running in production?",
      gate: "automatic",
      routineId: "routine-deploy",
      retryDelaySeconds: 1800,
      completeWhen: "The deploy pipeline reports the merge commit as live.",
      whileWaiting: { mode: "off", instructions: "" },
      workerId: "worker-1",
      approver: null,
    },
  ],
  savedPipelines: [],
  updatedAtEpochMs: now - 900_000,
};

export const fixturePlaybookRuntime: PlaybookRuntimeResult = {
  activePipelineName: "Dev PR to production",
  processingTaskId: null,
  steps: [
    {
      milestoneId: "code-done",
      routineId: "routine-code",
      waitingTaskIds: [],
      nextAttemptAtEpochMs: null,
      progress: [{
        taskId: "task-mobile",
        verdict: "passed",
        evidence: "Branch has 6 commits and no agent is working.",
        decidedAtEpochMs: now - 5_400_000,
        nextAttemptAtEpochMs: null,
      }],
    },
    {
      milestoneId: "self-review",
      routineId: "routine-review",
      waitingTaskIds: [],
      nextAttemptAtEpochMs: null,
      progress: [{
        taskId: "task-mobile",
        verdict: "passed",
        evidence: "The reviewer agent reported no blocking findings on the 14-file diff.",
        decidedAtEpochMs: now - 1_800_000,
        nextAttemptAtEpochMs: null,
      }],
    },
    {
      milestoneId: "review-requested",
      routineId: "routine-request",
      waitingTaskIds: ["task-mobile"],
      nextAttemptAtEpochMs: now + 660_000,
      progress: [{
        taskId: "task-mobile",
        verdict: "waiting",
        evidence: "No review request naming pull request #482 has been seen in the channel yet.",
        decidedAtEpochMs: now - 600_000,
        nextAttemptAtEpochMs: now + 660_000,
      }],
    },
    {
      milestoneId: "approved",
      routineId: "",
      waitingTaskIds: [],
      nextAttemptAtEpochMs: null,
      progress: [],
    },
    {
      milestoneId: "deployed",
      routineId: "routine-deploy",
      waitingTaskIds: [],
      nextAttemptAtEpochMs: null,
      progress: [],
    },
  ],
  doneTaskIds: [],
  stateRevision: 118,
};

export const fixtureRoutines: readonly { id: string; name: string; enabled: boolean }[] = [
  { id: "routine-code", name: "Code completion check", enabled: true },
  { id: "routine-review", name: "Reviewer agent", enabled: true },
  { id: "routine-request", name: "Review request watcher", enabled: true },
  { id: "routine-deploy", name: "Deploy watcher", enabled: false },
];

export const fixtureAgentCapabilities: AgentCapabilityDto[] = [
  {
    agent_id: "claude", label: "Claude", available: true, version: "5.0.1",
    integration_level: "full", degraded_reason: null,
    models: ["default", "opus[1m]", "fable", "sonnet", "haiku", "opus"],
    permissions: ["default", "acceptEdits", "plan", "bypassPermissions"],
    reasoning: ["default", "low", "medium", "high", "xhigh", "max"],
    observation_supported: true, quick_action_supported: true,
    tracked_helpers_supported: true, resume_supported: true, native_fork_supported: true,
  },
  {
    agent_id: "codex", label: "Codex", available: true, version: "0.51.0",
    integration_level: "full", degraded_reason: null,
    models: ["default", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.5-pro"],
    permissions: ["default", "acceptEdits", "plan", "bypassPermissions"],
    reasoning: ["default", "low", "medium", "high", "xhigh", "max"],
    observation_supported: true, quick_action_supported: true,
    tracked_helpers_supported: true, resume_supported: true, native_fork_supported: true,
  },
  {
    agent_id: "gemini", label: "Gemini CLI", available: true, version: "0.39.1",
    integration_level: "launchOnly", degraded_reason: "observationUnavailable",
    models: ["default", "auto", "pro", "flash", "flash-lite"],
    permissions: ["default", "acceptEdits", "plan", "bypassPermissions"],
    reasoning: ["default"], observation_supported: false, quick_action_supported: false,
    tracked_helpers_supported: false, resume_supported: false, native_fork_supported: false,
  },
];

export const fixtureStewardTranscript: CompanionMessageDto[] = [
  {
    id: "companion-1",
    projectId: "project-termloop-next",
    sequence: 1,
    author: "user",
    kind: "reply",
    content: "Where is the mobile task standing?",
    createdAtEpochMs: now - 1_200_000,
  },
  {
    id: "companion-2",
    projectId: "project-termloop-next",
    sequence: 2,
    author: "steward",
    kind: "reply",
    content: "It cleared code and self-review and is waiting on a human review request. Next check in about 11 minutes.",
    createdAtEpochMs: now - 1_140_000,
  },
  {
    id: "companion-3",
    projectId: "project-termloop-next",
    sequence: 3,
    author: "steward",
    kind: "suggestion",
    content: "I can ask the reviewer on the channel now. Accept to let me send it.",
    createdAtEpochMs: now - 300_000,
  },
];
