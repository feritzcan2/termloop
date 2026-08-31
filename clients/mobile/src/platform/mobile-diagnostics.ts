export type MobileDiagnosticValue = string | number | boolean | null;

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
    area: "connection" | "control" | "lifecycle" | "terminal",
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
      const definedDetails = Object.fromEntries(
        Object.entries(details).filter((entry): entry is [string, MobileDiagnosticValue] =>
          entry[1] !== undefined),
      );
      try {
        write(`[termloop-mobile] ${JSON.stringify({
          atEpochMs,
          elapsedMs: Math.max(0, atEpochMs - startedAtEpochMs),
          sequence: ++sequence,
          runId,
          area,
          event,
          ...definedDetails,
        })}`);
      } catch {
        // Diagnostics are disposable and must never change connection behavior.
      }
    },
  };
}

export const mobileDiagnostics = createMobileDiagnosticReporter((line) => {
  if (process.env.NODE_ENV !== "test") console.info(line);
});

export function websocketEndpointLabel(value: string): string {
  try {
    const endpoint = new URL(value);
    return `${endpoint.protocol}//${endpoint.host}${endpoint.pathname}`;
  } catch {
    return "invalid-websocket-endpoint";
  }
}
