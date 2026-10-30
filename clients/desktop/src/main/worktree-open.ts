import path from "node:path";

/// A remembered file is stored relative to the worktree that first opened it,
/// so the same shortcut can be offered on every other Task worktree of the
/// Project. Only paths strictly inside the worktree are representable.
export function worktreeRelativeFile(worktreePath: string, filePath: string): string | undefined {
  const relative = path.relative(path.resolve(worktreePath), path.resolve(filePath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/");
}

/// Resolves a renderer-supplied relative path against the daemon-read worktree.
/// The renderer cannot name an absolute path or escape the worktree.
export function worktreeFilePath(worktreePath: string, relativePath: unknown): string {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.length > 1024) {
    throw new Error("worktreeFileDenied");
  }
  const segments = relativePath.split(/[\\/]/);
  if (path.isAbsolute(relativePath) || segments.some((segment) => segment === "..")) {
    throw new Error("worktreeFileDenied");
  }
  const resolved = path.resolve(worktreePath, ...segments);
  if (worktreeRelativeFile(worktreePath, resolved) === undefined) throw new Error("worktreeFileDenied");
  return resolved;
}
