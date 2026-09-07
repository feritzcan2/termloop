import type { AssistantPromptImproverTarget } from "@termloop/contract/current";
import { isLiveSession, type Session } from "./model.js";
import { previousImproverSession } from "./composition/improver-resume.js";

const sessionByTarget = new Map<string, string>();

function targetKey(projectId: string, target: AssistantPromptImproverTarget): string {
  return `${projectId}:${target.surface}:${target.ownerId ?? ""}`;
}

/** Remembers the exact Session returned by the inspected launch. This is a UI
    relationship only: Session and Routine remain independently durable Core
    state, while the sidebar can place the current improver beside its target. */
export function rememberPromptImproverSession(
  projectId: string,
  target: AssistantPromptImproverTarget,
  sessionId: string,
): void {
  sessionByTarget.set(targetKey(projectId, target), sessionId);
}

function livePromptImproverSession(
  projectId: string,
  target: AssistantPromptImproverTarget,
  sessions: readonly Session[],
  legacy: Parameters<typeof previousImproverSession>[3],
): Session | undefined {
  const rememberedId = sessionByTarget.get(targetKey(projectId, target));
  const remembered = rememberedId
    ? sessions.find((session) => session.id === rememberedId)
    : undefined;
  if (remembered && isLiveSession(remembered)) return remembered;
  const previous = previousImproverSession(sessions, projectId, {
    targetKind: target.surface,
    targetId: target.ownerId,
  }, legacy);
  return previous && isLiveSession(previous) ? previous : undefined;
}

export function playbookBuilderSession(
  projectId: string,
  sessions: readonly Session[],
): Session | undefined {
  return livePromptImproverSession(projectId, {
    surface: "playbook",
    ownerId: null,
  }, sessions, {
    templateRef: "builtin.builder.playbook",
    sessionName: "build: Project Playbook",
    targetNameIsUnique: true,
  });
}

export function routineBuilderSession(
  projectId: string,
  sessions: readonly Session[],
): Session | undefined {
  return livePromptImproverSession(projectId, {
    surface: "routineBuilder",
    ownerId: null,
  }, sessions, {
    templateRef: "builtin.builder.routine",
    sessionName: "build: Project Routine",
    targetNameIsUnique: true,
  });
}

export function routinePromptImproverSession(
  projectId: string,
  routine: Readonly<{ id: string; name: string }>,
  routines: readonly Readonly<{ id: string; name: string }>[],
  sessions: readonly Session[],
): Session | undefined {
  const target: AssistantPromptImproverTarget = {
    surface: "routineInstructions",
    ownerId: routine.id,
  };
  return livePromptImproverSession(projectId, target, sessions, {
    templateRef: "builtin.improver.routine-instructions",
    sessionName: `improve: ${routine.name}`,
    targetNameIsUnique: routines.filter((candidate) => candidate.name === routine.name).length === 1,
  });
}
