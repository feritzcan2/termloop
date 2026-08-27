import type { QuickActionPreviewResult } from "@termloop/contract/current";
import type { Session } from "./model.js";

export function requireQuickActionPreview(value: unknown): QuickActionPreviewResult {
  if (!value || typeof value !== "object") throw new Error("invalidQuickActionPreviewResult");
  const candidate = value as Partial<QuickActionPreviewResult>;
  if (typeof candidate.launch_ticket !== "string" || !candidate.manifest) {
    throw new Error("invalidQuickActionPreviewResult");
  }
  return candidate as QuickActionPreviewResult;
}

export function requireQuickActionSession(value: unknown, projectId: string): Session {
  if (!value || typeof value !== "object") throw new Error("invalidQuickActionLaunchResult");
  const candidate = value as Partial<Session>;
  if (typeof candidate.id !== "string" || candidate.project_id !== projectId || candidate.kind !== "Agent") {
    throw new Error("invalidQuickActionLaunchResult");
  }
  return candidate as Session;
}
