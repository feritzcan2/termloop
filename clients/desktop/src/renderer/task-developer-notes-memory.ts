/// Client-local notes for a developer's own Task follow-up. They deliberately
/// do not enter the shared Task projection: Core owns Task lifecycle, while
/// this small checklist belongs only to the desktop user and this profile.
const TASK_DEVELOPER_NOTES_KEY = "termloop.taskDeveloperNotes.v1";
export const MAX_TASK_DEVELOPER_NOTES = 50;
export const MAX_TASK_DEVELOPER_NOTE_LENGTH = 280;

export type TaskDeveloperNote = Readonly<{
  id: string;
  text: string;
  completed: boolean;
}>;

type DeveloperNoteStore = Partial<Record<string, Partial<Record<string, TaskDeveloperNote[]>>>>;

function validNote(value: unknown): value is TaskDeveloperNote {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const note = value as Record<string, unknown>;
  return typeof note.id === "string"
    && Boolean(note.id)
    && typeof note.text === "string"
    && Boolean(note.text.trim())
    && typeof note.completed === "boolean";
}

function normalizeNotes(value: unknown): TaskDeveloperNote[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((candidate) => {
    if (!validNote(candidate) || seen.has(candidate.id)) return [];
    seen.add(candidate.id);
    return [{
      id: candidate.id.slice(0, 120),
      text: candidate.text.trim().slice(0, MAX_TASK_DEVELOPER_NOTE_LENGTH),
      completed: candidate.completed,
    }];
  }).slice(0, MAX_TASK_DEVELOPER_NOTES);
}

function readStore(storage: Pick<Storage, "getItem"> | undefined): DeveloperNoteStore {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return {};
    const parsed = JSON.parse(source.getItem(TASK_DEVELOPER_NOTES_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: DeveloperNoteStore = {};
    for (const [projectId, projectValue] of Object.entries(parsed as Record<string, unknown>)) {
      if (!projectId || !projectValue || typeof projectValue !== "object" || Array.isArray(projectValue)) continue;
      const tasks: Record<string, TaskDeveloperNote[]> = {};
      for (const [taskId, taskValue] of Object.entries(projectValue as Record<string, unknown>)) {
        if (!taskId) continue;
        const notes = normalizeNotes(taskValue);
        if (notes.length > 0) tasks[taskId] = notes;
      }
      if (Object.keys(tasks).length > 0) store[projectId] = tasks;
    }
    return store;
  } catch {
    return {};
  }
}

export function readTaskDeveloperNotes(
  projectId: string | undefined,
  taskId: string,
  storage?: Pick<Storage, "getItem">,
): readonly TaskDeveloperNote[] {
  if (!projectId || !taskId) return [];
  return readStore(storage)[projectId]?.[taskId] ?? [];
}

export function writeTaskDeveloperNotes(
  projectId: string | undefined,
  taskId: string,
  notes: readonly TaskDeveloperNote[],
  storage?: Pick<Storage, "getItem" | "setItem">,
): void {
  if (!projectId || !taskId) return;
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!target) return;
    const store = readStore(target);
    const normalized = normalizeNotes(notes);
    const project = { ...store[projectId] };
    if (normalized.length > 0) project[taskId] = normalized;
    else delete project[taskId];
    if (Object.keys(project).length > 0) store[projectId] = project;
    else delete store[projectId];
    target.setItem(TASK_DEVELOPER_NOTES_KEY, JSON.stringify(store));
  } catch {
    // A blocked or full preference store must not make the Task rail unusable.
  }
}

