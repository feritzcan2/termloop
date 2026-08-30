import { CONTRACT_IDENTITY } from "@termloop/contract/current";

import type {
  ConnectionProfile,
  MobileRuntime,
  StewardMessage,
  TerminalAttachment,
  TerminalEvent,
} from "../../application/ports";
import {
  fixtureAgentCapabilities,
  fixtureAgentStatuses,
  fixturePlaybook,
  fixturePlaybookRuntime,
  fixtureProjects,
  fixtureReplay,
  fixtureRoutines,
  fixtureSessions,
  fixtureStewardTranscript,
  fixtureTasks,
  fixtureTaskWorktreeChanges,
  fixtureTaskWorktreeDiffs,
  fixtureTaskWorktreePreImages,
} from "../../fixtures/mobile-overview";

const profiles: ConnectionProfile[] = [
  {
    id: "connection-local-mac",
    name: "Ferit's Mac",
    endpointLabel: "Mock connection",
    availability: "online",
    lastConnectedAtEpochMs: 1_786_617_480_000,
    productVersion: "0.4.1",
    contractIdentity: CONTRACT_IDENTITY,
  },
  {
    id: "connection-studio-mac",
    name: "Studio Mac",
    endpointLabel: "Mock connection",
    availability: "offline",
    lastConnectedAtEpochMs: 1_786_444_800_000,
    productVersion: "0.4.1",
    contractIdentity: CONTRACT_IDENTITY,
  },
  {
    id: "connection-old-macbook",
    name: "Old MacBook",
    endpointLabel: "Mock connection",
    availability: "revoked",
    lastConnectedAtEpochMs: 1_786_012_800_000,
    productVersion: "0.4.0",
    contractIdentity: null,
  },
  {
    id: "connection-mac-mini",
    name: "Mac mini",
    endpointLabel: "Mock connection",
    availability: "updateRequired",
    lastConnectedAtEpochMs: 1_785_753_600_000,
    productVersion: "0.3.9",
    contractIdentity: "sha256:5f0e21bc11d2f840f43f1a75fb86396e553d953cd428f0ca6e0bc8b3d930504e",
  },
];

export interface MockTerminalInspection {
  readonly inputs: Uint8Array[];
  readonly detachedSessions: string[];
  readonly positionsSet: { taskId: string; passedMilestoneCount: number }[];
  readonly routinesRun: string[];
  readonly launches: { taskId: string; agentId: string; launchTicket: string }[];
  readonly projectLaunches: { projectId: string; agentId: string; launchTicket: string }[];
}

export function createMockRuntime(): MobileRuntime & { inspection: MockTerminalInspection } {
  const inputs: Uint8Array[] = [];
  const detachedSessions: string[] = [];
  const positionsSet: { taskId: string; passedMilestoneCount: number }[] = [];
  const routinesRun: string[] = [];
  const launches: { taskId: string; agentId: string; launchTicket: string }[] = [];
  const projectLaunches: { projectId: string; agentId: string; launchTicket: string }[] = [];
  const watchTargets = new Map<string, string>();
  const voiceReceipts = new Map<string, {
    initialized: boolean;
    acknowledgedSequence: number;
    pendingUserSequence: number | null;
  }>();
  let transcript: StewardMessage[] = fixtureStewardTranscript.map((message) => ({ ...message }));
  // A counter rather than a read of the last message: two appends inside one
  // reply would otherwise both claim the same sequence, and the production
  // adapter orders the thread by exactly this field.
  let nextSequence = (transcript.at(-1)?.sequence ?? 0) + 1;
  const appended = (
    author: "user" | "steward",
    kind: StewardMessage["kind"],
    content: string,
    inputMode: StewardMessage["inputMode"] = "text",
  ): StewardMessage => {
    const sequence = nextSequence;
    nextSequence += 1;
    return {
      id: `companion-mock-${sequence}`,
      projectId: fixtureProjects[0]!.id,
      sequence,
      author,
      kind,
      inputMode,
      content,
      createdAtEpochMs: 1_786_617_600_000 + sequence * 1_000,
    };
  };

  return {
    kind: "mock",
    voiceReceipts: {
      async read(connectionId, projectId) {
        return voiceReceipts.get(`${connectionId}:${projectId}`)
          ?? { initialized: false, acknowledgedSequence: 0, pendingUserSequence: null };
      },
      async write(connectionId, projectId, receipt) {
        voiceReceipts.set(`${connectionId}:${projectId}`, { ...receipt });
      },
    },
    connections: {
      async list() {
        return profiles.map((profile) => ({ ...profile }));
      },
      resetTransports() {},
      async pair() {
        return profiles[0]!.id;
      },
    },
    control: {
      async loadOverview(connectionId) {
        if (connectionId !== profiles[0]?.id) throw new Error("mock connection not found");
        return {
          projects: fixtureProjects.map((project) => ({ ...project })),
          stewardEnabledProjectIds: fixtureProjects.map((project) => project.id),
          stewardExecutorSessionIds: {},
          tasks: fixtureTasks.map((task) => ({ ...task })),
          sessions: fixtureSessions.map((session) => ({ ...session })),
          agentStatuses: fixtureAgentStatuses.map((status) => ({ ...status })),
        };
      },
    },
    worktreeChanges: {
      async listTask(connectionId, taskId) {
        if (connectionId !== profiles[0]?.id || taskId !== fixtureTaskWorktreeChanges.task_id) {
          throw new Error("mock task worktree was not found");
        }
        return {
          ...fixtureTaskWorktreeChanges,
          entries: fixtureTaskWorktreeChanges.entries.map((entry) => ({ ...entry })),
        };
      },
      async diffTask(connectionId, taskId, observationId, entryId) {
        if (connectionId !== profiles[0]?.id || taskId !== fixtureTaskWorktreeChanges.task_id
          || observationId !== fixtureTaskWorktreeChanges.observation_id) {
          throw new Error("mock task worktree observation is stale");
        }
        const diff = fixtureTaskWorktreeDiffs[entryId];
        if (diff === undefined) throw new Error("mock task worktree entry was not found");
        return { ...diff };
      },
      async preImageTask(connectionId, taskId, observationId, entryId) {
        if (connectionId !== profiles[0]?.id || taskId !== fixtureTaskWorktreeChanges.task_id
          || observationId !== fixtureTaskWorktreeChanges.observation_id) {
          throw new Error("mock task worktree observation is stale");
        }
        const preImage = fixtureTaskWorktreePreImages[entryId];
        if (preImage === undefined) throw new Error("mock task worktree entry was not found");
        return { ...preImage };
      },
    },
    playbook: {
      async read(connectionId) {
        if (connectionId !== profiles[0]?.id) throw new Error("mock connection not found");
        return {
          playbook: { ...fixturePlaybook },
          runtime: { ...fixturePlaybookRuntime },
          routines: fixtureRoutines.map((routine) => ({ ...routine })),
          stateRevision: fixturePlaybookRuntime.stateRevision,
        };
      },
      async setTaskPosition(connectionId, params) {
        if (connectionId !== profiles[0]?.id) throw new Error("mock connection not found");
        positionsSet.push({ taskId: params.taskId, passedMilestoneCount: params.passedMilestoneCount });
      },
      async runRoutineNow(connectionId, routineId) {
        if (connectionId !== profiles[0]?.id) throw new Error("mock connection not found");
        routinesRun.push(routineId);
      },
    },
    agentLaunch: {
      async capabilities(connectionId) {
        if (connectionId !== profiles[0]?.id) throw new Error("mock connection not found");
        return fixtureAgentCapabilities.map((capability) => ({ ...capability }));
      },
      async preview(connectionId, taskId, selection) {
        if (connectionId !== profiles[0]?.id) throw new Error("mock connection not found");
        const task = fixtureTasks.find((candidate) => candidate.id === taskId);
        if (!task) throw new Error("mock task not found");
        return {
          launchTicket: `mock-ticket-${selection.agentId}`,
          program: `/usr/local/bin/${selection.agentId}`,
          args: selection.model === "default" ? [] : ["--model", selection.model],
          cwd: task.worktree?.path ?? task.branch?.repository_root ?? "/",
          model: selection.model,
          permission: selection.permission,
          reasoning: selection.reasoning,
        };
      },
      async launch(connectionId, taskId, selection, launchTicket, prompt) {
        if (connectionId !== profiles[0]?.id) throw new Error("mock connection not found");
        launches.push({ taskId, agentId: selection.agentId, launchTicket });
        return {
          sessionId: fixtureSessions[0]!.id,
          runtimeEpoch: fixtureSessions[0]!.runtime_epoch,
          promptSubmitted: prompt?.trim() ? true : null,
        };
      },
      async previewProject(connectionId, project, selection) {
        if (connectionId !== profiles[0]?.id) throw new Error("mock connection not found");
        if (!fixtureProjects.some((candidate) => candidate.id === project.id && candidate.folder_path === project.folder_path)) {
          throw new Error("mock Project not found");
        }
        return {
          launchTicket: `mock-project-ticket-${selection.agentId}`,
          program: `/usr/local/bin/${selection.agentId}`,
          args: selection.model === "default" ? [] : ["--model", selection.model],
          cwd: project.folder_path,
          model: selection.model,
          permission: selection.permission,
          reasoning: selection.reasoning,
        };
      },
      async launchProject(connectionId, project, selection, launchTicket, prompt) {
        if (connectionId !== profiles[0]?.id) throw new Error("mock connection not found");
        if (!fixtureProjects.some((candidate) => candidate.id === project.id && candidate.folder_path === project.folder_path)) {
          throw new Error("mock Project not found");
        }
        projectLaunches.push({ projectId: project.id, agentId: selection.agentId, launchTicket });
        return {
          sessionId: fixtureSessions[0]!.id,
          runtimeEpoch: fixtureSessions[0]!.runtime_epoch,
          promptSubmitted: prompt?.trim() ? true : null,
        };
      },
    },
    steward: {
      async transcript(connectionId) {
        if (connectionId !== profiles[0]?.id) throw new Error("mock connection not found");
        return transcript.map((message) => ({ ...message }));
      },
      async send(connectionId, _projectId, content) {
        if (connectionId !== profiles[0]?.id) throw new Error("mock connection not found");
        transcript = [
          ...transcript,
          appended("user", "reply", content),
          appended("steward", "reply", "Noted. I will look at it and report back here."),
        ];
        return transcript.map((message) => ({ ...message }));
      },
      async transcribeVoice(connectionId) {
        if (connectionId !== profiles[0]?.id) throw new Error("mock connection not found");
        return "Mock voice turn";
      },
      async commitVoice(connectionId, _projectId, voiceTranscript) {
        if (connectionId !== profiles[0]?.id) throw new Error("mock connection not found");
        const user = appended("user", "reply", voiceTranscript, "voice");
        transcript = [
          ...transcript,
          user,
          appended("steward", "reply", "I heard the mock voice turn clearly."),
        ];
        return { transcript: user.content, userSequence: user.sequence };
      },
      async speech(connectionId) {
        if (connectionId !== profiles[0]?.id) throw new Error("mock connection not found");
        return new Uint8Array([73, 68, 51]);
      },
      async respond(connectionId, _projectId, messageId, action) {
        if (connectionId !== profiles[0]?.id) throw new Error("mock connection not found");
        if (!transcript.some((message) => message.id === messageId)) {
          throw new Error("mock steward message not found");
        }
        transcript = [
          ...transcript,
          appended("user", action === "decline" ? "decline" : "approval", action),
        ];
        return transcript.map((message) => ({ ...message }));
      },
    },
    terminal: {
      async attach(connectionId, session, onEvent) {
        if (connectionId !== profiles[0]?.id) throw new Error("mock connection not found");
        const expected = fixtureSessions.find((candidate) => candidate.id === session.id);
        if (!expected || expected.runtime_epoch !== session.runtime_epoch) {
          throw new Error("mock terminal epoch is stale");
        }
        onEvent({ type: "state", state: "connecting" });
        onEvent({ type: "replay", bytes: fixtureReplay.slice() });
        onEvent({ type: "gap", droppedFrames: 2 });
        onEvent({ type: "state", state: "connected" });
        onEvent({ type: "live", bytes: new TextEncoder().encode("Agent is awaiting input.\r\n") });

        let detached = false;
        const attachment: TerminalAttachment = {
          async input(bytes) {
            if (detached) throw new Error("mock terminal is detached");
            inputs.push(bytes.slice());
          },
          async reconnect() {
            if (detached) throw new Error("mock terminal is detached");
          },
          async detach() {
            if (detached) return;
            detached = true;
            detachedSessions.push(session.id);
          },
        };
        return attachment;
      },
    },
    images: {
      async upload(connectionId, sessionId) {
        if (connectionId !== profiles[0]?.id || !fixtureSessions.some((session) => session.id === sessionId)) {
          throw new Error("mock image target was not found");
        }
        return `.termloop-runtime/mobile-attachments/${sessionId}/image.png`;
      },
    },
    notifications: {
      async registerDevice() {},
    },
    watch: {
      async sync() {
        return false;
      },
      async targetProject(connectionId) {
        if (connectionId !== profiles[0]?.id) throw new Error("mock connection not found");
        return watchTargets.get(connectionId) ?? null;
      },
      async setTargetProject(connectionId, projectId) {
        if (connectionId !== profiles[0]?.id || !fixtureProjects.some((project) => project.id === projectId)) {
          throw new Error("mock Watch target was not found");
        }
        watchTargets.set(connectionId, projectId);
        return { synced: false };
      },
    },
    inspection: { inputs, detachedSessions, positionsSet, routinesRun, launches, projectLaunches },
  };
}
