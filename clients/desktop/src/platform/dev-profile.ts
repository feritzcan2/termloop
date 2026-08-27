import path from "node:path";

export type DevelopmentProfileEnvironment = {
  TERMLOOP_RUNTIME_FILE?: string;
  TERMLOOP_DESKTOP_USER_DATA_DIR?: string;
  TERMLOOP_DEV_PROFILE_TAG?: string;
};

export type DevelopmentWindowStartMode = "visible" | "minimized" | "hidden";

type DockApplication = {
  dock?: {
    setIcon(iconPath: string): void;
  } | undefined;
};

const DEVELOPMENT_PROFILE_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;

export function developmentApplicationName(tag: string | undefined): string {
  return tag && DEVELOPMENT_PROFILE_TAG.test(tag) ? `TermLoop Next — ${tag}` : "TermLoop Next";
}

export function developmentWindowStartMode(
  tag: string | undefined,
  smoke: boolean,
  platform: NodeJS.Platform = process.platform,
): DevelopmentWindowStartMode {
  if (smoke) return "hidden";
  return platform === "darwin" && tag && DEVELOPMENT_PROFILE_TAG.test(tag) ? "minimized" : "visible";
}

export function applyUntaggedApplicationIcon(
  application: DockApplication,
  tag: string | undefined,
  iconPath: string,
): boolean {
  if (tag || !application.dock) return false;
  application.dock.setIcon(iconPath);
  return true;
}

export function prioritizeDevelopmentProject<T extends { folder_path: string }>(
  projects: readonly T[],
  preferredFolderPath: string | undefined,
): T[] {
  if (!preferredFolderPath) return [...projects];
  const preferredIndex = projects.findIndex((project) => project.folder_path === preferredFolderPath);
  if (preferredIndex <= 0) return [...projects];
  return [projects[preferredIndex]!, ...projects.slice(0, preferredIndex), ...projects.slice(preferredIndex + 1)];
}

export function linkedWorktreeProfileStartupError(
  compiledProfile: string | null,
  packaged: boolean,
  smoke: boolean,
  environment: DevelopmentProfileEnvironment,
): string | undefined {
  if (packaged || smoke || compiledProfile === null) return undefined;
  if (environment.TERMLOOP_RUNTIME_FILE && environment.TERMLOOP_DESKTOP_USER_DATA_DIR) {
    return undefined;
  }
  return `Linked-worktree desktop profile ${compiledProfile} must be started with tools/dev/termloop-dev`;
}

export function desktopUserDataOverride(
  configured: string | undefined,
  smoke: boolean,
  processId: number,
  temporaryDirectory: string,
): string | undefined {
  if (configured) return configured;
  return smoke ? `${temporaryDirectory}/termloop-next-smoke-${processId}` : undefined;
}

export function desktopUserDataPath(
  configured: string | undefined,
  packaged: boolean,
  smoke: boolean,
  processId: number,
  temporaryDirectory: string,
  applicationDataDirectory: string,
): string | undefined {
  return desktopUserDataOverride(configured, smoke, processId, temporaryDirectory)
    ?? (packaged ? path.join(applicationDataDirectory, "TermLoop Next") : undefined);
}
