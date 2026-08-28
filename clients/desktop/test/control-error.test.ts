import { describe, expect, it } from "vitest";
import { agentForkErrorMessage, agentForkRequiresProviderHistoryRepair, controlErrorMessage, projectDeleteErrorMessage, providerHistoryRepairErrorMessage, sessionDismissErrorMessage, sessionRequiresProviderHistoryRepair, voiceCredentialErrorMessage } from "../src/renderer/control-error.js";

describe("control error presentation", () => {
  it("renders a serialized control error message instead of the object itself", () => {
    expect(controlErrorMessage({ code: "methodNotFound", message: "method not found" })).toBe("method not found");
  });

  it("strips the Electron IPC wrapper so the rail shows the daemon's own message", () => {
    expect(controlErrorMessage(new Error("Error invoking remote method 'termloop:session-terminate': TermLoopControlError: record not found")))
      .toBe("record not found");
  });

  it("turns voice credential failures into actionable messages without reflecting secrets", () => {
    expect(voiceCredentialErrorMessage(new Error("connectionProfileRequired")))
      .toContain("select this computer");
    expect(voiceCredentialErrorMessage(new Error("OpenAI voice credentials are unavailable")))
      .toContain("secure credential storage is unavailable");
    expect(voiceCredentialErrorMessage(new Error("invalid params: apiKey")))
      .toContain("beginning with sk-");
    expect(voiceCredentialErrorMessage(new Error("rejected sk-proj-secret-value")))
      .toBe("OpenAI API key could not be saved.");
  });

  it("reads a terminate on an unknown Session as already stopped", () => {
    expect(sessionDismissErrorMessage(new Error("Error invoking remote method 'termloop:session-terminate': TermLoopControlError: record not found")))
      .toBe("That Session is no longer running.");
    expect(sessionDismissErrorMessage(new Error("daemon unreachable"))).toBe("daemon unreachable");
  });

  it("renders stable Project delete blocker guidance", () => {
    expect(projectDeleteErrorMessage({ details: { blocker: "worktrees" }, message: "conflict" }))
      .toBe("Clean up this Project's Task worktrees first.");
  });

  it("renders actionable native fork failure reasons", () => {
    expect(agentForkErrorMessage({
      details: { kind: "agentForkUnavailable", reason: "sourceNotRunning" },
    })).toBe("This source Agent is no longer available. Refresh the Session list and retry the fork.");
    expect(agentForkErrorMessage({
      details: { kind: "agentForkUnavailable", reason: "providerRejected" },
      message: "agent conversation fork is unavailable",
    })).toBe("The provider rejected this conversation fork. Check its local conversation history and authentication, then retry.");
    expect(agentForkErrorMessage({
      details: { kind: "agentForkUnavailable", reason: "providerHistoryDamaged" },
      message: "agent conversation fork is unavailable",
    })).toContain("conversation history is damaged");
    expect(agentForkErrorMessage({
      details: { kind: "agentForkUnavailable", reason: "startupExited" },
      message: "agent conversation fork is unavailable",
    })).toContain("exited before it became ready");
    expect(agentForkErrorMessage({
      details: { kind: "agentForkUnavailable", reason: "conversationUnconfirmed" },
      message: "agent conversation fork is unavailable",
    })).toContain("exact provider conversation could not be confirmed");
    expect(agentForkErrorMessage({
      details: { kind: "agentForkUnavailable", reason: "runtimeConflict" },
      message: "agent conversation fork is unavailable",
    })).toContain("Another runtime conflicted");
    expect(agentForkErrorMessage({ message: "daemon unavailable" })).toBe("daemon unavailable");
  });

  it("routes only typed provider history damage into Repair", () => {
    expect(agentForkRequiresProviderHistoryRepair({
      details: { kind: "agentForkUnavailable", reason: "providerHistoryDamaged" },
    })).toBe(true);
    expect(agentForkRequiresProviderHistoryRepair({
      details: { kind: "agentForkUnavailable", reason: "startupExited" },
    })).toBe(false);
    expect(sessionRequiresProviderHistoryRepair({
      resume_failure_reason: "providerHistoryDamaged",
    })).toBe(true);
    expect(sessionRequiresProviderHistoryRepair({
      resume_failure_reason: "resumeRejected",
    })).toBe(false);
  });

  it("explains fail-closed provider history repair errors", () => {
    expect(providerHistoryRepairErrorMessage({
      details: { kind: "providerHistoryRepairUnavailable", reason: "damageUnrecognized" },
      message: "conflict",
    })).toContain("left it unchanged");
    expect(providerHistoryRepairErrorMessage({
      details: { kind: "providerHistoryRepairUnavailable", reason: "verificationFailed" },
      message: "conflict",
    })).toContain("backup was retained");
  });
});
