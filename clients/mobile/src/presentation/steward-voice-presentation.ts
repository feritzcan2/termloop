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

export interface VoicePcmBuffer {
  data: ArrayBuffer;
  sampleRate: number;
  channels: number;
}

export interface VoicePcmCapture {
  chunks: readonly Uint8Array[];
  byteLength: number;
  sampleRate: number;
  channels: number;
  durationMillis: number;
  metering: number | undefined;
}

const VOICE_THRESHOLD_DB = -43;
const MIN_TURN_MS = 800;
const SILENCE_AFTER_VOICE_MS = 1_250;
const MAX_TURN_MS = 30_000;

export function createVoicePcmCapture(): VoicePcmCapture {
  return {
    chunks: [],
    byteLength: 0,
    sampleRate: 0,
    channels: 0,
    durationMillis: 0,
    metering: undefined,
  };
}

/// Captures the iPhone's native float PCM stream, converts it to signed 16-bit
/// PCM in JavaScript, and derives the dB meter used by the silence detector.
/// Keeping the stream at the hardware's 48 kHz float format avoids Expo's
/// silent AVAudioConverter failure for 16 kHz/int16 output.
export function appendVoiceFloatPcmBuffer(
  current: VoicePcmCapture,
  buffer: VoicePcmBuffer,
): VoicePcmCapture {
  const floatBytes = new DataView(buffer.data);
  const sampleCount = Math.floor(buffer.data.byteLength / 4);
  const chunk = new Uint8Array(sampleCount * 2);
  const pcm = new DataView(chunk.buffer);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.max(-1, Math.min(1, floatBytes.getFloat32(index * 4, true)));
    pcm.setInt16(index * 2, Math.round(sample < 0 ? sample * 32_768 : sample * 32_767), true);
  }
  const byteLength = current.byteLength + chunk.byteLength;
  const bytesPerSecond = buffer.sampleRate * buffer.channels * 2;
  return {
    chunks: [...current.chunks, chunk],
    byteLength,
    sampleRate: buffer.sampleRate,
    channels: buffer.channels,
    durationMillis: bytesPerSecond > 0 ? byteLength / bytesPerSecond * 1_000 : 0,
    metering: pcm16Decibels(chunk),
  };
}

/// Wraps captured little-endian signed 16-bit PCM in a canonical WAV container
/// accepted by the Steward transcription endpoint.
export function createVoicePcmWav(capture: VoicePcmCapture): ArrayBuffer {
  if (capture.byteLength === 0 || capture.sampleRate <= 0 || capture.channels <= 0) {
    throw new Error("Kaydedilen ses hazırlanamadı.");
  }
  const output = new ArrayBuffer(44 + capture.byteLength);
  const view = new DataView(output);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + capture.byteLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, capture.channels, true);
  view.setUint32(24, capture.sampleRate, true);
  view.setUint32(28, capture.sampleRate * capture.channels * 2, true);
  view.setUint16(32, capture.channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, capture.byteLength, true);
  const bytes = new Uint8Array(output);
  let offset = 44;
  for (const chunk of capture.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
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

function pcm16Decibels(bytes: Uint8Array): number | undefined {
  const sampleCount = Math.floor(bytes.byteLength / 2);
  if (sampleCount === 0) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let squares = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const normalized = view.getInt16(index * 2, true) / 32_768;
    squares += normalized * normalized;
  }
  const rootMeanSquare = Math.sqrt(squares / sampleCount);
  return rootMeanSquare > 0 ? 20 * Math.log10(rootMeanSquare) : -160;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
