import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_INTERACTIVE_TOOLS,
  MCP_IMPROVER_TOOLS,
  MCP_STEWARD_TOOLS,
  MCP_WORKER_TOOLS,
  MCP_HELPER_TOOLS,
  MCP_TOOL_DEFINITIONS,
  MCP_TOOLS,
  METHODS,
  validateMcpToolResult,
} from "../dist/current.js";

test("MCP role definitions are generated and excluded from control methods", () => {
  assert.deepEqual(MCP_INTERACTIVE_TOOLS, ["ask_to", "send_to_agent"]);
  assert.deepEqual(MCP_HELPER_TOOLS, ["ask_to", "send_to_agent", "reply_to_request"]);
  assert.deepEqual(MCP_IMPROVER_TOOLS, [
    "ask_to",
    "send_to_agent",
    "configuration_version_read",
    "configuration_version_write",
  ]);
  assert.ok(MCP_STEWARD_TOOLS.includes("task_create"));
  assert.ok(MCP_STEWARD_TOOLS.includes("send_to_agent"));
  assert.ok(MCP_STEWARD_TOOLS.includes("task_agent_start"));
  assert.ok(MCP_STEWARD_TOOLS.includes("task_set_jira_url"));
  assert.ok(!MCP_STEWARD_TOOLS.includes("project_branch_read"));
  assert.ok(!MCP_STEWARD_TOOLS.includes("task_worktree_provision"));
  assert.ok(!MCP_STEWARD_TOOLS.includes("task_agent_launch"));
  assert.ok(!MCP_STEWARD_TOOLS.includes("ask_to"));
  assert.ok(MCP_WORKER_TOOLS.includes("worker_get_next_routine"));
  assert.ok(!MCP_WORKER_TOOLS.includes("send_to_agent"));
  assert.ok(MCP_WORKER_TOOLS.includes("worker_complete_routine"));
  assert.ok(MCP_WORKER_TOOLS.includes("worker_report_routine_problem"));
  assert.ok(!MCP_WORKER_TOOLS.includes("task_create"));
  assert.ok(MCP_TOOLS.every((tool) => !METHODS.includes(tool)));
  assert.equal(MCP_TOOL_DEFINITIONS[0].inputSchema.properties.message.maxLength, 32768);
  assert.equal(MCP_TOOL_DEFINITIONS[0].inputSchema.properties.conversationId.maxLength, 128);
});

test("MCP result validation is generated and strict", () => {
  assert.equal(validateMcpToolResult("ask_to", {
    requestId: "request-1",
    conversationId: "conversation-1",
    status: "completed",
  }), true);
  assert.equal(validateMcpToolResult("ask_to", {
    requestId: "request-1",
    conversationId: "conversation-1",
    status: "unknown",
  }), false);
  assert.equal(validateMcpToolResult("ask_to", {
    requestId: "request-1",
    conversationId: "conversation-1",
    status: "completed",
    message: "answers are pushed, not returned by ask_to",
  }), false);
});

test("send_to_agent accepts exact Session IDs and typed delivery outcomes", () => {
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  const definition = MCP_TOOL_DEFINITIONS.find((tool) => tool.name === "send_to_agent");
  assert.ok(definition);
  assert.match(definition.description, /any Project, Task, checkout, or worktree/);
  assert.equal(validateMcpToolResult("send_to_agent", { sessionId, status: "delivered" }), true);
  assert.equal(validateMcpToolResult("send_to_agent", {
    sessionId,
    status: "failed",
    reason: "targetAgentTurnFailed",
    suggestedAction: "waitForUser",
    message: "The target Agent's previous turn failed.",
  }), true);
  assert.equal(validateMcpToolResult("send_to_agent", { sessionId, status: "failed" }), false);
  assert.equal(validateMcpToolResult("send_to_agent", {
    sessionId,
    status: "delivered",
    reason: "targetAgentTurnFailed",
  }), false);
  assert.equal(validateMcpToolResult("send_to_agent", { sessionId, status: "pending" }), false);
});

test("Steward Task Agent results validate provider/model pairs", () => {
  const result = {
    taskId: "task-1",
    sessionId: "session-1",
    branchName: "termloop/task-1",
    worktreePath: "/tmp/task-1",
    agentId: "claude",
    model: "opus",
    permission: "default",
    reasoning: "default",
    assignmentDelivered: true,
    reusedSession: false,
    status: "ready",
  };
  assert.equal(validateMcpToolResult("task_agent_start", result), true);
  assert.equal(validateMcpToolResult("task_agent_start", {
    ...result,
    agentId: "codex",
  }), false);
});
