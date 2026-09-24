import { TerminalPool as EngineTerminalPool, type AttachmentFactory } from "@termloop/terminal-surface/pool";
import type { TerminalSurfaceFactory } from "@termloop/terminal-surface/surface";
import { sessionKeepsTerminalSurface, type Session } from "../model.js";
import { connectionProfileIdOf } from "../../connection-scope.js";
export { sessionStoppedDuringAttach, type TerminalAttachmentLike } from "@termloop/terminal-surface/pool";

function sessionHasAttachableTerminal(session: Session): boolean {
  // Core projects the exact provisional runtime epoch while an Agent resumes,
  // allowing the user to see and answer provider startup prompts before
  // structured readiness. A failed resume publishes its failure only after
  // that PTY has been reaped, so the existing surface then preserves whatever
  // startup output it already rendered without attaching to a missing runtime.
  return session.lifecycle_state === "running"
    || (session.kind === "Agent"
      && session.lifecycle_state === "resuming")
    || (session.kind === "Agent"
      && session.lifecycle_state === "exited");
}

export class TerminalPool extends EngineTerminalPool<Session> {
  constructor(surfaceFactory: TerminalSurfaceFactory, attachmentFactory: AttachmentFactory<Session>, diagnosticsEnabled = false, onImagePaste: (sessionId: string) => void = () => {}) {
    super(surfaceFactory, attachmentFactory, diagnosticsEnabled, onImagePaste, {
      retain: sessionKeepsTerminalSurface,
      canAttach: sessionHasAttachableTerminal,
      connectionScope: connectionProfileIdOf,
    });
  }
}
