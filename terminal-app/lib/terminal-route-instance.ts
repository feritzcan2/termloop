function normalizeParam(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = normalizeParam(item);
      if (normalized) return normalized;
    }
  }
  return undefined;
}

export function makeTerminalInstanceId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getTerminalRouteIdentity(
  params: Record<string, unknown> | undefined
): string | undefined {
  const instanceId = normalizeParam(params?.instanceId);
  if (instanceId) return instanceId;

  const id = normalizeParam(params?.id);
  const resume = normalizeParam(params?.resume);
  if (!id || !resume) return undefined;

  const cwd = normalizeParam(params?.cwd) ?? '';
  const workspaceId = normalizeParam(params?.workspaceId) ?? '';
  return `${id}::${resume}::${cwd}::${workspaceId}`;
}

