import { describe, expect, it, vi } from "vitest";
import type { AgentAuthOperationDto } from "@termloop/contract/current";
vi.mock("electron", () => ({ shell: { openExternal: vi.fn() } }));
vi.mock("../src/main/control.js", () => ({ controlCall: vi.fn() }));
import { signInUrl } from "../src/main/agent-connections.js";
const operation: AgentAuthOperationDto = { agentId: "codex", operationId: "attempt", action: "signIn", phase: "awaitingBrowser", verificationUrl: "https://auth.openai.com/codex/device", userCode: "CODE", acceptsCode: false, message: "", expiresAtEpochMs: Date.now() + 900_000 };
describe("provider sign-in browser boundary", () => {
  it("allows only supported provider challenge URLs", () => {
    expect(signInUrl(operation)).toBe(operation.verificationUrl);
    expect(signInUrl({ ...operation, agentId: "claude", verificationUrl: "https://claude.com/cai/oauth/authorize?code_challenge=abc" })).toContain("claude.com");
    expect(signInUrl({ ...operation, agentId: "claude", verificationUrl: "https://claude.ai/oauth/authorize?code_challenge=abc" })).toContain("claude.ai");
    for (const verificationUrl of ["javascript:alert(1)", "https://auth.openai.com.evil.test/codex/device", "http://localhost:1455", "https://claude.ai@evil.test/oauth/authorize", "https://claude.ai:444/oauth/authorize", "https://claude.ai/oauth/authorize#fragment", "https://claude.ai\\@evil.test/oauth/authorize"]) {
      expect(() => signInUrl({ ...operation, verificationUrl })).toThrow();
      expect(() => signInUrl({ ...operation, agentId: "claude", verificationUrl })).toThrow();
    }
  });
  it("does not reopen completed or expired operations", () => {
    expect(() => signInUrl({ ...operation, phase: "succeeded" })).toThrow();
    expect(() => signInUrl({ ...operation, expiresAtEpochMs: 1 })).toThrow();
  });
});
