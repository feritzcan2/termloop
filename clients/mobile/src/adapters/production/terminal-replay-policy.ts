import { continueTerminalReplay } from "../../application/terminal-replay";
import { MOBILE_REPLAY_BUDGET_BYTES } from "./terminal-frame";

const RESUME_REPLAY_BYTES = 64 * 1024;

// A bounded suffix is sufficient only when it overlaps the retained terminal.
// Failed or incomplete proofs retry once with the established full replay budget.
export class TerminalReplayPolicy {
  byteLimit: number;

  constructor(private readonly previousOutputTail?: Uint8Array) {
    this.byteLimit = previousOutputTail?.byteLength
      ? RESUME_REPLAY_BYTES : MOBILE_REPLAY_BUDGET_BYTES;
  }

  accept(bytes: Uint8Array, complete: boolean): boolean {
    if (this.byteLimit === MOBILE_REPLAY_BUDGET_BYTES) return true;
    if (complete && this.previousOutputTail !== undefined
      && continueTerminalReplay(this.previousOutputTail, bytes).continuous) return true;
    this.byteLimit = MOBILE_REPLAY_BUDGET_BYTES;
    return false;
  }
}
