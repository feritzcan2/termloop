import type { VoicePcmCapture } from "../presentation/steward-voice-presentation";
import { mobileDiagnostics, type MobileDiagnosticReporter } from "./mobile-diagnostics";

/** Only bounded failure categories and recording measurements leave the phone;
 * never exception text, recordings, transcripts, credentials or target IDs. */
export function reportVoiceFailure(
  cause: unknown,
  method: "agent" | "steward",
  stage: "recording" | "encoding" | "transcription",
  capture: VoicePcmCapture,
  uploadBytes?: number,
  diagnostics: MobileDiagnosticReporter = mobileDiagnostics,
): void {
  const message = cause instanceof Error ? cause.message : "";
  let reason = "unknown";
  if (/561017449|!pri/.test(message)) reason = "audio_session_busy";
  else if (/Mikrofon izni/.test(message)) reason = "permission_denied";
  else if (/Mikrofondan ses verisi/.test(message)) reason = "no_audio_buffer";
  else if (/Yeterli ses/.test(message)) reason = "recording_too_short";
  else if (/2 MB|cannot be transcribed/.test(message)) reason = "invalid_clip";
  else if (/could not hear speech/.test(message)) reason = "no_speech";
  else if (/credential/.test(message)) reason = "credential_rejected";
  else if (/network|timeout|timed out|abort/i.test(message)) reason = "network";
  diagnostics.report("control", `voice_${stage}_failed`, {
    method, reason, durationMs: Math.round(capture.durationMillis),
    captureBytes: capture.byteLength, sampleRate: capture.sampleRate,
    channels: capture.channels, uploadBytes,
  });
}
