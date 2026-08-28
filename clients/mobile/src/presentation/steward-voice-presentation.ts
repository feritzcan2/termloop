import type { MobileOverview, StewardMessage } from "@/application/ports";

export interface VoiceRouteParams {
  projectId?: string | readonly string[] | undefined;
  taskId?: string | readonly string[] | undefined;
  sessionId?: string | readonly string[] | undefined;
}

export interface VoiceSilenceState {
  heardVoice: boolean;
  lastVoiceAtMs: number;
}

export interface VoiceSilenceUpdate {
  state: VoiceSilenceState;
  shouldStop: boolean;
}

export interface VoiceRecordingFinishStatus {
  isFinished: boolean;
  hasError: boolean;
  error: string | null;
  url: string | null;
}

export interface VoiceRecordingCompletion {
  finished: Promise<string>;
  receive(status: VoiceRecordingFinishStatus): void;
}

const VOICE_THRESHOLD_DB = -43;
const MIN_TURN_MS = 800;
const SILENCE_AFTER_VOICE_MS = 1_250;
const MAX_TURN_MS = 30_000;

/// Native recorder stop calls return before every platform has closed and
/// finalized its output file. Resolve only from the recorder's completion
/// event so the caller never uploads a header-only recording.
export function createVoiceRecordingCompletion(): VoiceRecordingCompletion {
  let resolve!: (url: string) => void;
  let reject!: (cause: Error) => void;
  let settled = false;
  const finished = new Promise<string>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return {
    finished,
    receive(status) {
      if (!status.isFinished || settled) return;
      settled = true;
      const error = status.error?.trim();
      if (status.hasError || status.url === null) {
        reject(new Error(error && error.length > 0 ? error : "Kaydedilen ses tamamlanamadı."));
        return;
      }
      resolve(status.url);
    },
  };
}

/// Keeps the global microphone pointed at the Project represented by the route.
/// Routes without a Project fall back to the first Project on the selected Mac;
/// the expanded dock still exposes every Project as an explicit chip.
export function voiceProjectId(
  params: VoiceRouteParams,
  overview: MobileOverview | undefined,
): string | undefined {
  if (overview === undefined) return undefined;
  const projectId = scalar(params.projectId);
  if (projectId !== undefined && overview.projects.some((project) => project.id === projectId)) {
    return projectId;
  }
  const taskId = scalar(params.taskId);
  const taskProjectId = overview.tasks.find((task) => task.id === taskId)?.project_id;
  if (taskProjectId !== undefined) return taskProjectId;
  const sessionId = scalar(params.sessionId);
  const sessionProjectId = overview.sessions.find((session) => session.id === sessionId)?.project_id;
  return sessionProjectId ?? overview.projects[0]?.id;
}

export function stewardReplyAfter(
  messages: readonly StewardMessage[],
  userSequence: number,
): StewardMessage | undefined {
  return messages.findLast(
    (message) => message.author === "steward" && message.sequence > userSequence,
  );
}

/// Ends a spoken turn after real speech followed by a short quiet window. A hard
/// ceiling bounds uploads even when background noise never crosses the threshold.
export function updateVoiceSilence(
  current: VoiceSilenceState,
  durationMs: number,
  metering: number | undefined,
): VoiceSilenceUpdate {
  const heardNow = metering !== undefined && metering >= VOICE_THRESHOLD_DB;
  const state = heardNow
    ? { heardVoice: true, lastVoiceAtMs: durationMs }
    : current;
  const quietAfterVoice = state.heardVoice
    && durationMs >= MIN_TURN_MS
    && durationMs - state.lastVoiceAtMs >= SILENCE_AFTER_VOICE_MS;
  return {
    state,
    shouldStop: quietAfterVoice || durationMs >= MAX_TURN_MS,
  };
}

function scalar(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}
