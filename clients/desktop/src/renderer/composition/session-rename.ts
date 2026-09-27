import { controlErrorMessage } from "../control-error.js";
import type { Session } from "../model.js";

type SessionRenamePorts = {
  renameSession(sessionId: string, name: string | null): Promise<Session>;
  upsertSession(session: Session): void;
  refreshProjection(): Promise<void>;
  setMessage(message: string): void;
};

export function createSessionRename(ports: SessionRenamePorts) {
  const refreshAfterRename = async () => {
    try {
      await ports.refreshProjection();
    } catch (error) {
      ports.setMessage(`Session renamed, but its latest state could not be refreshed: ${controlErrorMessage(error)}`);
    }
  };

  return async (sessionId: string, name: string | null): Promise<string | undefined> => {
    try {
      const session = await ports.renameSession(sessionId, name);
      ports.upsertSession(session);
    } catch (error) {
      const message = controlErrorMessage(error);
      ports.setMessage(message);
      return message;
    }
    // The daemon response proves the rename was saved. Closing its dialog must
    // not wait for unrelated Project reads or other computers to refresh.
    void refreshAfterRename();
    return undefined;
  };
}
