import type { LocalBranchDto, RemoteBranchDto } from "@termloop/contract/current";

function preferredSeparator(path: string): "/" | "\\" {
  return path.lastIndexOf("\\") > path.lastIndexOf("/") ? "\\" : "/";
}

function trimTrailingSeparators(path: string): string {
  if (path === "/" || /^[A-Za-z]:[\\/]$/.test(path)) return path;
  return path.replace(/[\\/]+$/, "");
}

/// The folder leaf derived from a branch name. Branch separators flatten to
/// dashes so a suggested destination is always exactly one directory under an
/// existing parent: a nested `task/…_worktree` suggestion fails provisioning
/// whenever the intermediate folder does not exist on disk.
function branchLeaf(branchName: string): string {
  return branchName.trim().replace(/[\\/]+/g, "-");
}

export function worktreePathParent(path: string): string {
  const value = trimTrailingSeparators(path.trim());
  if (!value) return "";
  if (value === "/" || /^[A-Za-z]:[\\/]$/.test(value)) return value;

  const separatorIndex = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  if (separatorIndex < 0) return "";
  if (separatorIndex === 0) return value.slice(0, 1);
  if (separatorIndex === 2 && /^[A-Za-z]:/.test(value)) return value.slice(0, 3);
  return value.slice(0, separatorIndex);
}

export function worktreeDestination(parentPath: string, branchName: string): string {
  const parent = trimTrailingSeparators(parentPath.trim());
  const separator = preferredSeparator(parent);
  const directoryName = `${branchLeaf(branchName)}_worktree`;
  if (!parent) return directoryName;
  return `${parent}${parent.endsWith(separator) ? "" : separator}${directoryName}`;
}

export function initialWorktreeDestination(
  repositoryPath: string,
  branchName: string,
  rememberedParentPath?: string,
): string {
  return worktreeDestination(rememberedParentPath?.trim() || worktreePathParent(repositoryPath), branchName);
}

export function selectedWorktreeParent(destinationPath: string, branchName: string): string {
  const destination = trimTrailingSeparators(destinationPath.trim());
  if (!destination) return "";

  const branchDirectory = `${branchLeaf(branchName)}_worktree`;
  if (destination.endsWith(branchDirectory)) {
    const parent = trimTrailingSeparators(destination.slice(0, -branchDirectory.length));
    if (parent) return parent;
  }
  return worktreePathParent(destination);
}

/// A safe managed branch name derived from a Task title, so the create flow can
/// propose one instead of asking. Diacritics fold to ASCII (Turkish dotless ı
/// included), everything else collapses to single dashes, and an untitled or
/// fully non-ASCII title yields "" so callers fall back to asking.
export function suggestedBranchName(title: string, prefix = "termloop"): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug ? `${prefix}/${slug}` : "";
}

const preferredLocalBranchNames = [
  "main",
  "master",
  "develop",
  "development",
  "dev",
  "staging",
  "stage",
  "integration",
  "int",
  "production",
  "prod",
] as const;

/// Long-lived integration branches float to the top so the default base ref is
/// the branch a user almost always wants to start from.
export function sortLocalBranches(branches: readonly LocalBranchDto[]): LocalBranchDto[] {
  const priority = new Map<string, number>(preferredLocalBranchNames.map((name, index) => [name, index]));
  return [...branches].sort((left, right) => {
    const leftPriority = priority.get(left.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = priority.get(right.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    return leftPriority - rightPriority || left.name.localeCompare(right.name);
  });
}

/// Remote-tracking refs are the only safe base for a newly-created Task
/// branch. Prefer origin and the long-lived integration branches while keeping
/// the exact remote name visible when more than one remote exposes a branch.
export function sortRemoteBranches(branches: readonly RemoteBranchDto[]): RemoteBranchDto[] {
  const priority = new Map<string, number>([
    "development",
    "develop",
    "dev",
    "main",
    "master",
    "staging",
    "stage",
    "integration",
    "int",
    "production",
    "prod",
  ].map((name, index) => [name, index]));
  return [...branches].sort((left, right) => {
    const [leftRemote, ...leftBranchParts] = left.name.split("/");
    const [rightRemote, ...rightBranchParts] = right.name.split("/");
    const leftBranch = leftBranchParts.join("/");
    const rightBranch = rightBranchParts.join("/");
    const leftPriority = priority.get(leftBranch.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = priority.get(rightBranch.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    const remotePriority = Number(rightRemote === "origin") - Number(leftRemote === "origin");
    return leftPriority - rightPriority || remotePriority || left.name.localeCompare(right.name);
  });
}

export function localBranchesForTaskBinding(
  branches: readonly LocalBranchDto[],
  requiredBranchName: string | undefined,
  truncated: boolean,
): { branches: LocalBranchDto[]; requiredBranchMissing: boolean } {
  const sorted = sortLocalBranches(branches);
  if (!requiredBranchName || sorted.some((branch) => branch.name === requiredBranchName)) {
    return { branches: sorted, requiredBranchMissing: false };
  }
  if (!truncated) return { branches: sorted, requiredBranchMissing: true };

  // A bounded branch list cannot prove that a durable exact Task binding is
  // absent. Keep that exact name selectable and let core resolve it against
  // the repository before provisioning.
  return {
    branches: sortLocalBranches([
      ...sorted,
      { name: requiredBranchName, exact_ref: `refs/heads/${requiredBranchName}` },
    ]),
    requiredBranchMissing: false,
  };
}

export function updateWorktreeDestinationBranch(
  destinationPath: string,
  parentPath: string,
  previousBranchName: string,
  nextBranchName: string,
): string {
  return destinationPath.trim() === worktreeDestination(parentPath, previousBranchName)
    ? worktreeDestination(parentPath, nextBranchName)
    : destinationPath;
}
