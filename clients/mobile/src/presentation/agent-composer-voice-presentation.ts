export type AgentComposerVoicePhase = "ready" | "permission" | "listening" | "transcribing" | "error";

export function appendVoiceTranscript(draft: string, transcript: string): string {
  const spoken = transcript.trim();
  if (spoken.length === 0) return draft;
  if (draft.length === 0) return spoken;
  return `${draft}${/\s$/.test(draft) ? "" : " "}${spoken}`;
}

export function agentComposerVoiceStatus(
  phase: AgentComposerVoicePhase,
  durationMillis: number,
): string | undefined {
  switch (phase) {
    case "ready": return undefined;
    case "permission": return "Mikrofon hazırlanıyor…";
    case "listening": return `Kaydediliyor · ${(Math.max(0, durationMillis) / 1_000).toFixed(1)} sn · Bitirmek için dokun`;
    case "transcribing": return "Konuşman yazıya çevriliyor…";
    case "error": return "Ses kaydı tamamlanamadı. Tekrar denemek için mikrofona dokun.";
  }
}
