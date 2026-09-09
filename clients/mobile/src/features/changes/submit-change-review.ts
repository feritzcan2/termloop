import type { SessionDto } from "@termloop/contract/current";
import type { MobileRuntime, TerminalAttachment } from "../../application/ports";
import { MAX_REVIEW_MESSAGE_BYTES, reviewMessageBytes, reviewPasteBytes, taskReviewAgents } from "../../presentation/change-review-notes";
import { submitTerminalTurn } from "../terminal/submit-terminal-turn";

export async function submitChangeReview(
  runtime: Pick<MobileRuntime, "control" | "terminal">,
  connectionId: string,
  taskId: string,
  target: SessionDto,
  message: string,
  signal: AbortSignal,
): Promise<void> {
  if (reviewMessageBytes(message) > MAX_REVIEW_MESSAGE_BYTES) throw new Error("Feedback exceeds the 64 KiB limit.");
  const validateTarget = async () => {
    const overview = await runtime.control.loadOverview(connectionId);
    const task = overview.tasks.find((value) => value.id === taskId);
    const current = task && taskReviewAgents(task, overview.sessions).find((value) => value.id === target.id);
    if (signal.aborted || !current || current.runtime_epoch !== target.runtime_epoch) {
      throw new Error("The selected agent changed before feedback could be sent.");
    }
  };
  await validateTarget();
  let attachment: TerminalAttachment | undefined;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Attach may fail before the readiness promise is awaited.
  void ready.catch(() => {});
  let connected = true;
  let wasReady = false;
  const cancel = () => readyReject(new Error("Feedback delivery was cancelled."));
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => readyReject(new Error("The agent terminal is not ready. Try again.")), 20_000);
  try {
    attachment = await runtime.terminal.attach(connectionId, target, (event) => {
      if (event.type === "ready") { wasReady = true; readyResolve(); }
      if (event.type === "eof" || (event.type === "state" && event.state !== "connected")) {
        if (event.type === "state" && event.state === "connecting" && !wasReady) return;
        connected = false;
        readyReject(new Error("The agent terminal disconnected."));
      }
    }, { signal });
    await ready;
    clearTimeout(timer);
    await validateTarget();
    const sent = await submitTerminalTurn(attachment, reviewPasteBytes(message),
      () => !signal.aborted && connected,
      async (open, bytes) => { await open.input(bytes); return true; });
    if (!sent) throw new Error("Feedback delivery was interrupted. Check the agent before sending again.");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    // A failed detach must not turn a completed send into a retryable draft.
    await attachment?.detach().catch(() => {});
  }
}
