import AsyncStorage from '@react-native-async-storage/async-storage';
import { getConnection } from './connections';

const STORAGE_KEY = 'terminal_resume_route';

export interface TerminalResumeRoute {
  instanceId: string;
  id: string;
  cwd?: string;
  resume: string;
  workspaceId?: string;
  savedAt: number;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeRoute(value: unknown): TerminalResumeRoute | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<TerminalResumeRoute>;
  const instanceId = normalizeString(candidate.instanceId);
  const id = normalizeString(candidate.id);
  const resume = normalizeString(candidate.resume);
  if (!instanceId || !id || !resume) return null;
  const cwd = normalizeString(candidate.cwd);
  const workspaceId = normalizeString(candidate.workspaceId);
  const savedAt =
    typeof candidate.savedAt === 'number' && Number.isFinite(candidate.savedAt)
      ? candidate.savedAt
      : Date.now();
  return { instanceId, id, resume, cwd, workspaceId, savedAt };
}

async function readStack(): Promise<TerminalResumeRoute[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      const single = sanitizeRoute(parsed);
      if (single) return [single];
      await AsyncStorage.removeItem(STORAGE_KEY);
      return [];
    }
    const routes = parsed.map(sanitizeRoute).filter((route): route is TerminalResumeRoute => route != null);
    if (routes.length === parsed.length) return routes;
  } catch {}
  await AsyncStorage.removeItem(STORAGE_KEY);
  return [];
}

async function writeStack(routes: TerminalResumeRoute[]): Promise<void> {
  if (routes.length === 0) {
    await AsyncStorage.removeItem(STORAGE_KEY);
    return;
  }
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(routes));
}

export async function upsertTerminalResumeRoute(
  route: Omit<TerminalResumeRoute, 'savedAt'>
): Promise<void> {
  const routes = await readStack();
  const payload: TerminalResumeRoute = {
    instanceId: route.instanceId,
    id: route.id,
    resume: route.resume,
    savedAt: Date.now(),
    ...(route.cwd ? { cwd: route.cwd } : {}),
    ...(route.workspaceId ? { workspaceId: route.workspaceId } : {}),
  };
  const next = routes.filter((item) => item.instanceId !== payload.instanceId);
  next.push(payload);
  await writeStack(next);
}

export async function removeTerminalResumeRoute(instanceId: string): Promise<void> {
  const routes = await readStack();
  const next = routes.filter((route) => route.instanceId !== instanceId);
  if (next.length === routes.length) return;
  await writeStack(next);
}

export async function clearTerminalResumeRoutes(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}

export async function getTerminalResumeRoutes(): Promise<TerminalResumeRoute[]> {
  return readStack();
}

export async function getRestorableTerminalResumeRoutes(): Promise<TerminalResumeRoute[]> {
  const routes = await readStack();
  if (routes.length === 0) return [];

  const restored: TerminalResumeRoute[] = [];
  for (const route of routes) {
    const conn = await getConnection(route.id);
    if (conn) restored.push(route);
  }
  if (restored.length !== routes.length) {
    await writeStack(restored);
  }
  return restored;
}
