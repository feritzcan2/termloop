import type { TerminalAttachment } from "../../application/ports";

// Do not retry either write: a missing receipt is an unknown outcome. Keep the
// caller's draft until both writes settle on the same attachment.
export async function submitTerminalTurn(
  attachment: TerminalAttachment,
  bytes: Uint8Array,
  current: () => boolean,
  deliver: (attachment: TerminalAttachment, bytes: Uint8Array) => Promise<boolean>,
): Promise<boolean> {
  if (!current() || !await deliver(attachment, bytes) || !current()) return false;
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  if (!current()) return false;
  return await deliver(attachment, new Uint8Array([13])) && current();
}
