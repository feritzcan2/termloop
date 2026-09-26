import { connectionProfileIdOf, type ConnectionScope } from "../../connection-scope.js";
import type { TerminalPresentationPort } from "../terminal-presentation.js";

export function withTerminalReconnect(
  presentation: TerminalPresentationPort,
  session: (id: string) => ConnectionScope | undefined,
  reconnect: (profileId: string) => Promise<unknown>,
  reattach: (profileId: string) => void,
): TerminalPresentationPort {
  const pending = new Map<string, Promise<void>>();
  return {
    ...presentation,
    async reconnect(id) {
      const target = session(id);
      if (!target) throw new Error("This session is no longer available.");
      const profileId = connectionProfileIdOf(target);
      let request = pending.get(profileId);
      if (!request) {
        request = Promise.resolve().then(() => reconnect(profileId)).then(() => {
          reattach(profileId);
        }).finally(() => pending.delete(profileId));
        pending.set(profileId, request);
      }
      await request;
    },
  };
}
