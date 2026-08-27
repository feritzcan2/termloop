import { describe, expect, it } from "vitest";

import {
  retainPendingSessionInput,
  takePendingSessionInput,
} from "../src/features/terminal/pending-session-input";

describe("pending launch input", () => {
  it("is scoped to one Mac and runtime epoch, then consumed exactly once", () => {
    retainPendingSessionInput("mac-a", "session-a", 2, "continue here");

    expect(takePendingSessionInput("mac-b", "session-a", 2)).toBeUndefined();
    expect(takePendingSessionInput("mac-a", "session-a", 1)).toBeUndefined();
    expect(takePendingSessionInput("mac-a", "session-a", 2)).toBe("continue here");
    expect(takePendingSessionInput("mac-a", "session-a", 2)).toBeUndefined();
  });
});
