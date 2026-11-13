import { useEffect, useRef } from "react";

import { shareInbox, type SharedImage } from "@/platform/share-inbox";
import { sharedImageReadyToSend } from "@/presentation/share-target";

/// A screenshot shared from another app arrives at a freshly launched Agent's
/// Session as a staged composer image plus the user's prompt. It is sent once,
/// as soon as the Agent first waits for input; until then (or if that never
/// comes) the composer simply shows it ready for the user to send by hand.
export function useSharedImageDelivery({ shareBatch, shareDraft, sessionReady, staged: stagedInComposer, canSend, agentStatus, stage, send }: {
  shareBatch: string | undefined;
  shareDraft: string | undefined;
  /// The Session's composer exists (route connection selected, Agent present).
  sessionReady: boolean;
  /// The composer currently holds this batch's image, so a send carries it.
  staged: boolean;
  canSend: boolean;
  agentStatus: string | undefined;
  /// A missing image (already sent, or pruned) still restores the prompt.
  stage(image: (SharedImage & { shareBatch: string }) | undefined, draft: string): void;
  send(): Promise<boolean>;
}) {
  const staged = useRef<string | undefined>(undefined);
  const sent = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!sessionReady || shareBatch === undefined || staged.current === shareBatch) return;
    staged.current = shareBatch;
    const image = shareInbox.read(shareBatch);
    stage(image === undefined ? undefined : { ...image, shareBatch }, shareDraft ?? "");
  }, [sessionReady, shareBatch, shareDraft, stage]);

  useEffect(() => {
    if (shareBatch === undefined || !stagedInComposer || sent.current === shareBatch) return;
    if (!sharedImageReadyToSend(canSend, agentStatus)) return;
    sent.current = shareBatch;
    void send();
  }, [agentStatus, canSend, send, shareBatch, stagedInComposer]);
}
