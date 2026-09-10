import { useEffect, useMemo, useRef, useState } from "react";
import { createVoiceTranscription, type VoiceTranscriptionState } from "./voice-transcription";

export function useVoiceTranscription(options: Parameters<typeof createVoiceTranscription>[0] & { scope: string }) {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(true);
  const [state, setState] = useState<VoiceTranscriptionState>({ phase: "idle", error: undefined, retryable: false });
  const { scope, method } = options;
  const controller = useMemo(() => createVoiceTranscription({
    method,
    transcribe: (...args) => latest.current.transcribe(...args),
    onState: (next) => {
      if (!mounted.current || latest.current.scope !== scope) return;
      setState(next); latest.current.onState(next);
    },
    onTranscript: (transcript) => {
      if (mounted.current && latest.current.scope === scope) latest.current.onTranscript(transcript);
    },
  }), [scope, method]);
  useEffect(() => {
    mounted.current = true;
    setState({ phase: "idle", error: undefined, retryable: false });
    return () => { mounted.current = false; controller.cancel(); };
  }, [controller]);
  return { controller, state };
}
