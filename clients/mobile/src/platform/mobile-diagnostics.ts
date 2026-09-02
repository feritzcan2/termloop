export type MobileDiagnosticValue = string | number | boolean | null;

export type MobileDiagnosticArea = "connection" | "control" | "lifecycle" | "notification" | "terminal";

export interface MobileDiagnosticEvent {
  readonly atEpochMs: number;
  readonly elapsedMs: number;
  readonly sequence: number;
  readonly runId: string;
  readonly area: MobileDiagnosticArea;
  readonly event: string;
  readonly details: Readonly<Record<string, MobileDiagnosticValue>>;
}

export interface MobileDiagnosticCorrelation {
  readonly mobileRunId: string;
  readonly mobileAppState: string | undefined;
  readonly foregroundRevision: number | undefined;
  readonly backgroundDurationMs: number | undefined;
}

export interface MobileDiagnosticReporter {
  readonly runId: string;
  correlation(): MobileDiagnosticCorrelation;
  updateLifecycle(context: {
    readonly nativeState: string;
    readonly foregroundRevision: number;
    readonly backgroundDurationMs?: number;
  }): void;
  report(
    area: MobileDiagnosticArea,
    event: string,
    details?: Readonly<Record<string, MobileDiagnosticValue | undefined>>,
  ): void;
}

interface MobileDiagnosticClock {
  now(): number;
}

const systemClock: MobileDiagnosticClock = { now: Date.now };

export function createMobileDiagnosticReporter(
  write: (line: string) => void,
  clock: MobileDiagnosticClock = systemClock,
  emit: (event: MobileDiagnosticEvent) => void = () => {},
): MobileDiagnosticReporter {
  const startedAtEpochMs = clock.now();
  const runId = `mobile-${startedAtEpochMs.toString(36)}`;
  let sequence = 0;
  let lifecycle: Omit<MobileDiagnosticCorrelation, "mobileRunId"> = {
    mobileAppState: undefined,
    foregroundRevision: undefined,
    backgroundDurationMs: undefined,
  };

  return {
    runId,
    correlation: () => ({ mobileRunId: runId, ...lifecycle }),
    updateLifecycle(context) {
      lifecycle = {
        mobileAppState: context.nativeState,
        foregroundRevision: context.foregroundRevision,
        backgroundDurationMs: context.backgroundDurationMs,
      };
    },
    report(area, event, details = {}) {
      const atEpochMs = clock.now();
      const definedDetails = definedDiagnosticValues(details);
      const lifecycleDetails = definedDiagnosticValues(lifecycle);
      const diagnosticEvent: MobileDiagnosticEvent = {
        atEpochMs,
        elapsedMs: Math.max(0, atEpochMs - startedAtEpochMs),
        sequence: ++sequence,
        runId,
        area,
        event,
        details: { ...lifecycleDetails, ...definedDetails },
      };
      try {
        write(`[termloop-mobile] ${JSON.stringify({
          ...diagnosticEvent,
          details: undefined,
          ...diagnosticEvent.details,
        })}`);
      } catch {
        // Diagnostics are disposable and must never change connection behavior.
      }
      try {
        emit(diagnosticEvent);
      } catch {
        // External diagnostic sinks must never change connection behavior.
      }
    },
  };
}

function definedDiagnosticValues(
  values: Readonly<Record<string, MobileDiagnosticValue | undefined>>,
): Record<string, MobileDiagnosticValue> {
  const defined: Record<string, MobileDiagnosticValue> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) defined[key] = value;
  }
  return defined;
}

const mobileDiagnosticListeners = new Set<(event: MobileDiagnosticEvent) => void>();

export const mobileDiagnostics = createMobileDiagnosticReporter(
  (line) => {
    if (process.env.NODE_ENV !== "test") console.info(line);
  },
  systemClock,
  (event) => {
    for (const listener of mobileDiagnosticListeners) {
      try { listener(event); } catch {
        // A broken listener must not prevent the remaining sinks from receiving diagnostics.
      }
    }
  },
);

export function subscribeMobileDiagnostics(
  listener: (event: MobileDiagnosticEvent) => void,
): () => void {
  mobileDiagnosticListeners.add(listener);
  return () => mobileDiagnosticListeners.delete(listener);
}

export function websocketEndpointLabel(value: string): string {
  try {
    const endpoint = new URL(value);
    return `${endpoint.protocol}//${endpoint.host}${endpoint.pathname}`;
  } catch {
    return "invalid-websocket-endpoint";
  }
}
