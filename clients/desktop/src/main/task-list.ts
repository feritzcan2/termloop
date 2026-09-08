import {
  TermLoopControlError,
  type TaskDto,
  type TaskListParams,
  type TaskPageDto,
} from "@termloop/contract/current";

type TaskListRead = (params: TaskListParams) => Promise<TaskPageDto>;
type TaskListSelection = Pick<TaskListParams, "projectId" | "archiveScope" | "taskIds">;

export async function readProjectTasks(read: TaskListRead, selection: TaskListSelection): Promise<TaskDto[]> {
  // Exact-ID reads cannot be combined with a cursor or an explicit page limit.
  if (selection.taskIds !== undefined) return (await read(selection)).items;

  for (let attempt = 0; ; attempt += 1) {
    const tasks: TaskDto[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    try {
      for (let pageIndex = 0; pageIndex < 128; pageIndex += 1) {
        const page = await read({
          ...selection,
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        tasks.push(...page.items);
        if (page.next_cursor === null) return tasks;
        if (seenCursors.has(page.next_cursor)) throw new Error("Task pagination cursor repeated.");
        seenCursors.add(page.next_cursor);
        cursor = page.next_cursor;
      }
      throw new Error("Task pagination exceeded the desktop list bound.");
    } catch (error) {
      // Cursors belong to one daemon state revision. Retry a rejected cursor
      // once from the beginning, discarding every item from the stale snapshot.
      if (attempt === 0 && cursor !== undefined
        && error instanceof TermLoopControlError && error.code === "invalidMessage") continue;
      throw error;
    }
  }
}
