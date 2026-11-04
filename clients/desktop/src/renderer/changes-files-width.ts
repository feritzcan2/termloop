export const CHANGES_FILES_MIN_WIDTH = 220;
export const CHANGES_FILES_DEFAULT_WIDTH = 300;
export const CHANGES_FILES_MAX_WIDTH = 900;
const DIFF_MIN_WIDTH = 360;
const CHANGES_FILES_WIDTH_KEY = "termloop.changesFilesWidth.v1";

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem">;
type RemoveStorage = Pick<Storage, "removeItem">;

function defaultStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

export function changesFilesMaximumWidth(bodyWidth: number): number {
  return Math.max(CHANGES_FILES_MIN_WIDTH, Math.min(CHANGES_FILES_MAX_WIDTH, bodyWidth - DIFF_MIN_WIDTH));
}

export function clampChangesFilesWidth(width: number, bodyWidth: number): number {
  return Math.max(CHANGES_FILES_MIN_WIDTH, Math.min(changesFilesMaximumWidth(bodyWidth), Math.round(width)));
}

export function readChangesFilesWidth(storage?: ReadStorage): number {
  try {
    const stored = (storage ?? defaultStorage())?.getItem(CHANGES_FILES_WIDTH_KEY);
    if (stored === undefined || stored === null || stored.trim().length === 0) return CHANGES_FILES_DEFAULT_WIDTH;
    const width = Number(stored);
    return Number.isFinite(width) ? Math.max(CHANGES_FILES_MIN_WIDTH, Math.min(CHANGES_FILES_MAX_WIDTH, Math.round(width))) : CHANGES_FILES_DEFAULT_WIDTH;
  } catch {
    return CHANGES_FILES_DEFAULT_WIDTH;
  }
}

export function writeChangesFilesWidth(width: number, storage?: WriteStorage): void {
  try {
    (storage ?? defaultStorage())?.setItem(CHANGES_FILES_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // An unavailable preference store must not prevent in-session resizing.
  }
}

export function clearChangesFilesWidth(storage?: RemoveStorage): void {
  try {
    (storage ?? defaultStorage())?.removeItem(CHANGES_FILES_WIDTH_KEY);
  } catch {
    // Reset still applies for this session when preference storage is unavailable.
  }
}
