/// Breadcrumb and quick-jump helpers for the inline Project folder picker.
/// Paths arrive from the daemon exactly as the target computer spells them, so
/// every split has to keep the original separator and root form instead of
/// normalising to POSIX: a Windows breadcrumb that hands `C:/Users` back to
/// `system.browseDirectory` stops matching the paths Git later reports.

export type FolderTrailSegment = { name: string; path: string };

type PathShape = { root: string; separator: "/" | "\\"; rest: string };

function pathShape(path: string): PathShape | undefined {
  if (path.startsWith("\\\\")) {
    const parts = path.slice(2).split(/[\\/]+/u).filter(Boolean);
    if (parts.length < 2) return undefined;
    return { root: `\\\\${parts[0]}\\${parts[1]}`, separator: "\\", rest: parts.slice(2).join("\\") };
  }
  const drive = /^([A-Za-z]:)[\\/]?/u.exec(path);
  if (drive) return { root: `${drive[1]}\\`, separator: "\\", rest: path.slice(drive[0].length) };
  if (path.startsWith("/")) return { root: "/", separator: "/", rest: path.slice(1) };
  return undefined;
}

function join(parent: string, segment: string, separator: "/" | "\\"): string {
  return parent.endsWith(separator) ? `${parent}${segment}` : `${parent}${separator}${segment}`;
}

/// The clickable trail for a folder, root first. An unrecognised path shape
/// still yields one segment so the bar never renders empty.
export function folderTrail(path: string): readonly FolderTrailSegment[] {
  const value = path.trim();
  if (!value) return [];
  const shape = pathShape(value);
  if (!shape) return [{ name: value, path: value }];
  const trail: FolderTrailSegment[] = [{ name: shape.root, path: shape.root }];
  let current = shape.root;
  for (const segment of shape.rest.split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, segment, shape.separator);
    trail.push({ name: segment, path: current });
  }
  return trail;
}

export function folderLeafName(path: string): string {
  return folderTrail(path).at(-1)?.name ?? path;
}

/// Keeps the trail readable in a dialog-width bar by collapsing the middle.
/// The root and the last two segments stay, because those are what identifies
/// the folder a user is about to pick.
export function collapseFolderTrail(
  trail: readonly FolderTrailSegment[],
  visible = 4,
): readonly (FolderTrailSegment | "ellipsis")[] {
  if (trail.length <= visible) return trail;
  const [root] = trail;
  const tail = trail.slice(trail.length - (visible - 1));
  return root ? [root, "ellipsis", ...tail] : ["ellipsis", ...tail];
}

/// Folders worth one click: the computer's default Projects root plus the
/// parents that already hold Projects on this connection. Deduplicated, with
/// the folder currently on screen dropped because jumping to it is a no-op.
export function folderQuickJumps(
  defaultRoot: string | undefined,
  projectParents: readonly string[],
  currentPath: string | undefined,
  limit = 4,
): readonly FolderTrailSegment[] {
  const seen = new Set<string>();
  const jumps: FolderTrailSegment[] = [];
  for (const candidate of [defaultRoot ?? "", ...projectParents]) {
    const path = candidate.trim();
    if (!path || path === currentPath?.trim() || seen.has(path)) continue;
    seen.add(path);
    jumps.push({ name: folderLeafName(path), path });
    if (jumps.length === limit) break;
  }
  return jumps;
}
