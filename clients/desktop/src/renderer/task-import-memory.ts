import type { TaskImportChoice } from "./project-task-automation.js";
import { QUICK_ACTION_AGENT_PERMISSIONS, QUICK_ACTION_AGENT_REASONING } from "./quick-action-memory.js";

// Client-local form preferences, scoped to the connection-qualified Project ID.
// Restoring a choice never changes Project automation or starts an import.
const TASK_IMPORT_MEMORY_KEY = "termloop.taskImport.v1";
const MAX_PROJECTS = 32;
type ImportStore = Partial<Record<string, TaskImportChoice>>;

function nullableString(value: unknown, maxLength: number): boolean {
  return value === null || (typeof value === "string" && value.length <= maxLength);
}

function isChoice(value: unknown): value is TaskImportChoice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const choice = value as Partial<TaskImportChoice>;
  return typeof choice.createWorktree === "boolean"
    && typeof choice.worktreePrefix === "string" && choice.worktreePrefix.length <= 32
    && nullableString(choice.baseRef, 1024)
    && nullableString(choice.agentId, 64)
    && nullableString(choice.workflowId, 128)
    && nullableString(choice.model, 80)
    && (choice.permission === null || (choice.permission !== undefined && QUICK_ACTION_AGENT_PERMISSIONS.includes(choice.permission)))
    && (choice.reasoning === null || (choice.reasoning !== undefined && QUICK_ACTION_AGENT_REASONING.includes(choice.reasoning)))
    && nullableString(choice.kickoffMessage, 8192);
}

function readStore(storage?: Pick<Storage, "getItem">): ImportStore {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    const parsed: unknown = JSON.parse(source?.getItem(TASK_IMPORT_MEMORY_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed)
      .filter((entry): entry is [string, TaskImportChoice] => isChoice(entry[1]))
      .slice(-MAX_PROJECTS));
  } catch {
    return {};
  }
}

export function readTaskImportChoice(projectId: string, storage?: Pick<Storage, "getItem">): TaskImportChoice | undefined {
  const store = readStore(storage);
  return Object.hasOwn(store, projectId) ? store[projectId] : undefined;
}

export function rememberTaskImportChoice(
  projectId: string,
  choice: TaskImportChoice,
  storage?: Pick<Storage, "getItem" | "setItem">,
): void {
  if (!projectId || !isChoice(choice)) return;
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return;
    const store = readStore(source);
    delete store[projectId];
    const entries = [...Object.entries(store), [projectId, choice]];
    source.setItem(TASK_IMPORT_MEMORY_KEY, JSON.stringify(Object.fromEntries(entries.slice(-MAX_PROJECTS))));
  } catch {
    // Unavailable storage must not interrupt editing or Task creation.
  }
}
