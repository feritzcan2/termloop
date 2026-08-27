import { useEffect, useRef } from "react";
import type { SessionRelocationPreviewDto } from "@termloop/contract/current";
import type { Task } from "./model.js";
import { taskStage } from "./task-presentation.js";

export type BackgroundSessionRelocationIntent = {
  sessionId: string;
  taskId: string;
  mode: "resume" | "fresh";
  provisioning: boolean;
};

export function BackgroundSessionRelocation({ intents, tasks, preview, relocate, finish, reopen, repairProviderHistory }: {
  intents: readonly BackgroundSessionRelocationIntent[];
  tasks: readonly Task[];
  preview(sessionId: string, taskId: string, mode: "resume" | "fresh"): Promise<SessionRelocationPreviewDto>;
  relocate(
    sessionId: string,
    taskId: string,
    operationId: string,
    relocationTicket: string,
    mode: "resume" | "fresh",
    manifestDigest: string,
  ): Promise<boolean>;
  finish(taskId: string): void;
  reopen(intent: BackgroundSessionRelocationIntent): void;
  repairProviderHistory(sessionId: string): void;
}) {
  const claimedTaskIds = useRef(new Set<string>());

  useEffect(() => {
    const activeTaskIds = new Set(intents.map((intent) => intent.taskId));
    for (const taskId of claimedTaskIds.current) {
      if (!activeTaskIds.has(taskId)) claimedTaskIds.current.delete(taskId);
    }
    for (const intent of intents) {
      if (intent.provisioning || claimedTaskIds.current.has(intent.taskId)) continue;
      const task = tasks.find((candidate) => candidate.id === intent.taskId);
      if (!task) continue;
      const stage = taskStage(task, false);
      if (stage.id !== "ready") {
        if (stage.id === "provisioning" || stage.id === "planning" || stage.id === "branchOnly" || stage.id === "observing") continue;
        finish(intent.taskId);
        reopen(intent);
        continue;
      }
      claimedTaskIds.current.add(intent.taskId);
      void (async () => {
        let shouldReopen = false;
        try {
          const result = await preview(intent.sessionId, intent.taskId, intent.mode);
          if (!result.can_relocate || !result.relocation_ticket || !result.manifest) {
            shouldReopen = true;
            return;
          }
          const requiresRepair = await relocate(
            intent.sessionId,
            intent.taskId,
            globalThis.crypto.randomUUID(),
            result.relocation_ticket,
            intent.mode,
            result.manifest.digest,
          );
          if (requiresRepair) repairProviderHistory(intent.sessionId);
        } catch {
          shouldReopen = true;
        } finally {
          claimedTaskIds.current.delete(intent.taskId);
          finish(intent.taskId);
          if (shouldReopen) reopen(intent);
        }
      })();
    }
  }, [finish, intents, preview, relocate, reopen, repairProviderHistory, tasks]);

  return null;
}
