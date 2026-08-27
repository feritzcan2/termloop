import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const here = dirname(fileURLToPath(import.meta.url));
const evidencePath = join(here, "evidence.json");
const reportPath = join(here, "REPORT.md");
const captureScript = join(here, "capture-hook.mjs");
const interactiveScript = join(here, "interactive.expect");

function version(command) {
  try {
    return execFileSync(command, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function run(command, args, options) {
  return new Promise((resolve) => {
    const startedAtEpochMs = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAtEpochMs,
        error: error.message,
        stdout,
        stderr,
      });
    });
    child.on("exit", (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({
        exitCode,
        signal,
        durationMs: Date.now() - startedAtEpochMs,
        error: null,
        stdout,
        stderr,
      });
    });
  });
}

function runInteractive(command, args, options) {
  return run(
    "/usr/bin/expect",
    [interactiveScript, String(Math.ceil(options.timeoutMs / 1000)), command, ...args],
    { ...options, timeoutMs: options.timeoutMs + 10_000 },
  );
}

function runCodexAppServer(options) {
  return new Promise((resolve) => {
    const startedAtEpochMs = Date.now();
    const child = spawn(
      "codex",
      ["app-server", "--stdio", "-c", 'history.persistence="none"'],
      {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const methods = new Set();
    let threadId = null;
    let approval = null;
    let error = null;
    let stderr = "";
    let finished = false;
    const lines = createInterface({ input: child.stdout });

    const send = (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      lines.close();
      child.kill("SIGTERM");
      resolve({
        durationMs: Date.now() - startedAtEpochMs,
        error,
        approval,
        methods: [...methods].sort(),
        stderrCategory: stderr
          ? stderr.includes("error")
            ? "error-related"
            : "non-empty"
          : "empty",
      });
    };
    const timeout = setTimeout(() => {
      error = "timeout";
      finish();
    }, options.timeoutMs);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (spawnError) => {
      error = spawnError.message;
      finish();
    });
    child.on("exit", (code) => {
      if (!finished && code !== 0) {
        error = `app-server-exit-${code}`;
        finish();
      }
    });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof message.method === "string") methods.add(message.method);
      if (message.id === 1) {
        if (message.error) {
          error = "initialize-failed";
          finish();
          return;
        }
        send({ method: "initialized", params: {} });
        send({
          method: "thread/start",
          id: 2,
          params: {
            cwd: options.cwd,
            approvalPolicy: "untrusted",
            sandbox: "read-only",
            serviceName: "termloop_agent_signal_spike",
          },
        });
      } else if (message.id === 2) {
        threadId = message.result?.thread?.id ?? null;
        if (!threadId) {
          const detail = message.error?.message;
          error = detail ? `thread-start-failed: ${detail}` : "thread-start-failed";
          finish();
          return;
        }
        send({
          method: "turn/start",
          id: 3,
          params: {
            threadId,
            input: [{ type: "text", text: options.prompt }],
            cwd: options.cwd,
            approvalPolicy: "untrusted",
            sandboxPolicy: { type: "readOnly" },
          },
        });
      } else if (
        message.method === "item/commandExecution/requestApproval" ||
        message.method === "item/fileChange/requestApproval" ||
        message.method === "item/permissions/requestApproval"
      ) {
        approval = {
          method: message.method,
          observedAtEpochMs: Date.now(),
          latencyFromStartMs: Date.now() - startedAtEpochMs,
          hasThreadId: Boolean(message.params?.threadId),
          hasTurnId: Boolean(message.params?.turnId),
        };
        send({ id: message.id, result: "decline" });
      } else if (message.method === "turn/completed") {
        finish();
      }
    });

    send({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "termloop_agent_signal_spike",
          title: "TermLoop Agent Signal Spike",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

function readEvents(path) {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function eventSummary(events) {
  const names = [...new Set(events.map((event) => event.hookEventName))].sort();
  const counts = Object.fromEntries(
    names.map((name) => [
      name,
      events.filter((event) => event.hookEventName === name).length,
    ]),
  );
  const awaitingEvents = events.filter(
    (event) =>
      event.hookEventName === "PermissionRequest" ||
      event.hookEventName === "Notification",
  );
  return {
    counts,
    correlationObserved:
      events.length > 0 &&
      events.every(
        (event) =>
          event.correlationSessionMatches &&
          event.endpointIsLoopback &&
          event.tokenPresent,
      ),
    awaitingInputObservable: awaitingEvents.length > 0,
    awaitingSignals: awaitingEvents.map((event) => ({
      scenario: event.scenario,
      hookEventName: event.hookEventName,
      notificationType: event.notificationType,
      toolName: event.toolName,
      recordedAtEpochMs: event.recordedAtEpochMs,
    })),
  };
}

function sanitizeRun(result) {
  const jsonEventTypes = [];
  for (const line of result.stdout.split("\n")) {
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.type === "string") jsonEventTypes.push(parsed.type);
    } catch {
      // CLI text and model output are intentionally not persisted.
    }
  }
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    error: result.error,
    jsonEventTypes: [...new Set(jsonEventTypes)].sort(),
    stderrCategory: result.stderr
      ? result.stderr.includes("permission")
        ? "permission-related"
        : "non-empty"
      : "empty",
    tuiCategory: result.stdout
      ? /login|authenticate|oauth/i.test(result.stdout)
        ? "authentication"
        : /trust|untrusted/i.test(result.stdout)
          ? "trust"
          : /permission|approve|allow/i.test(result.stdout)
            ? "permission"
            : /error|failed/i.test(result.stdout)
              ? "error"
              : "non-empty"
      : "empty",
  };
}

function claudeSettings(command) {
  const events = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "Notification",
    "Stop",
    "SessionEnd",
  ];
  return {
    hooks: Object.fromEntries(
      events.map((name) => [
        name,
        [{ matcher: "", hooks: [{ type: "command", command }] }],
      ]),
    ),
  };
}

function codexHookArgs(command) {
  const events = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "Stop",
    "SessionEnd",
  ];
  const handler = JSON.stringify(command);
  return events.flatMap((name) => [
    "-c",
    `hooks.${name}=[{hooks=[{type="command",command=${handler}}]}]`,
  ]);
}

function statusFor(claude, codex) {
  const ran = claude.run.exitCode !== null && codex.run.exitCode !== null;
  const correlated =
    claude.summary.correlationObserved && codex.summary.correlationObserved;
  const awaiting =
    claude.awaitingInputObservable && codex.awaitingInputObservable;
  if (ran && correlated && awaiting) return "GO";
  if (ran && (correlated || awaiting)) return "MIXED";
  return "NO-GO";
}

function report(evidence) {
  const row = (agent) => {
    const item = evidence[agent];
    return `| ${agent} | ${item.run.exitCode ?? "not-run"} | ${item.summary.correlationObserved ? "yes" : "no"} | ${item.awaitingInputObservable ? "yes" : "no"} | ${Object.keys(item.summary.counts).join(", ") || "none"} |`;
  };
  return `# F1 agent-signal spike report

Status: **${evidence.status}**

Generated: ${evidence.generatedAt}

| Agent | Exit | Runtime correlation | Awaiting-input signal | Observed hooks |
|---|---:|---|---|---|
${row("claude")}
${row("codex")}

## Decision

${evidence.decision}

## Measurement boundary

- Real installed CLIs were invoked in an isolated temporary Git repository.
- Claude loaded an explicit temporary \`--settings\` file with setting sources restricted to the temporary project.
- Codex lifecycle hooks used invocation-local config overrides with one-invocation hook-trust bypass and user config ignored. Its approval path was observed independently as the structured server-initiated request from a temporary-profile App Server session.
- Hook payloads were sanitized at capture time. Tokens, prompts, raw model output, full tool input, transcript paths, and temporary paths are absent from this evidence.
- A captured \`PermissionRequest\` or \`Notification\` is treated as an authoritative awaiting-input-capable signal. Terminal text was not parsed.

## Limitations

- This spike proves the installed CLI behavior on one macOS host; it is not cross-platform evidence.
- A hook can self-report only presentation state; it is not an authorization boundary.
- Production hook delivery, per-Session credential validation, reducers, and UI notifications are intentionally not implemented here.
`;
}

const tempRoot = mkdtempSync(join(tmpdir(), "termloop-agent-signals-"));
try {
  const projectRoot = join(tempRoot, "project");
  const claudeCapture = join(tempRoot, "claude-hooks.jsonl");
  const codexCapture = join(tempRoot, "codex-hooks.jsonl");
  const codexHome = join(tempRoot, "codex-home");
  const claudeRoot = join(tempRoot, "claude-home");
  const claudeConfig = join(claudeRoot, ".claude");
  mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  mkdirSync(claudeConfig, { recursive: true, mode: 0o700 });
  execFileSync("git", ["init", "--quiet", projectRoot]);
  copyFileSync(join(homedir(), ".codex", "auth.json"), join(codexHome, "auth.json"));
  chmodSync(join(codexHome, "auth.json"), 0o600);
  copyFileSync(
    join(homedir(), ".claude", ".credentials.json"),
    join(claudeConfig, ".credentials.json"),
  );
  chmodSync(join(claudeConfig, ".credentials.json"), 0o600);
  copyFileSync(join(homedir(), ".claude.json"), join(claudeRoot, ".claude.json"));
  chmodSync(join(claudeRoot, ".claude.json"), 0o600);
  const claudeStatePath = join(claudeRoot, ".claude.json");
  const claudeState = JSON.parse(readFileSync(claudeStatePath, "utf8"));
  claudeState.projects ??= {};
  claudeState.projects[projectRoot] = {
    mcpServers: {},
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
    projectOnboardingSeenCount: 1,
  };
  writeFileSync(claudeStatePath, `${JSON.stringify(claudeState)}\n`, { mode: 0o600 });

  const command = `node ${JSON.stringify(captureScript)}`;
  const claudeSettingsPath = join(tempRoot, "claude-settings.json");
  writeFileSync(
    claudeSettingsPath,
    `${JSON.stringify(claudeSettings(command), null, 2)}\n`,
    { mode: 0o600 },
  );

  const baseEnv = {
    ...process.env,
    TERMLOOP_HOOK_ENDPOINT: "http://127.0.0.1:43119/observe",
    TERMLOOP_HOOK_TOKEN: "spike-present-but-never-recorded",
  };
  const claudeSession = "spike-claude-session";
  const codexSession = "spike-codex-session";
  const claudePrompt = readFileSync(join(here, "prompts/claude.txt"), "utf8").trim();
  const codexPrompt = readFileSync(join(here, "prompts/codex.txt"), "utf8").trim();
  const claudeApprovalPrompt = readFileSync(
    join(here, "prompts/claude-approval.txt"),
    "utf8",
  ).trim();
  const codexApprovalPrompt = readFileSync(
    join(here, "prompts/codex-approval.txt"),
    "utf8",
  ).trim();
  writeFileSync(
    join(projectRoot, "termloop-signal-spike-delete-me.txt"),
    "temporary\n",
  );

  const claudeRaw = await run(
    "claude",
    [
      "-p",
      claudePrompt,
      "--model",
      "haiku",
      "--output-format",
      "stream-json",
      "--include-hook-events",
      "--verbose",
      "--max-turns",
      "2",
      "--permission-mode",
      "default",
      "--tools",
      "Bash",
      "--setting-sources",
      "local",
      "--settings",
      claudeSettingsPath,
    ],
    {
      cwd: projectRoot,
      timeoutMs: 120_000,
      env: {
        ...baseEnv,
        TERMLOOP_SPIKE_AGENT: "claude",
        TERMLOOP_SPIKE_SCENARIO: "lifecycle",
        TERMLOOP_SPIKE_CAPTURE: claudeCapture,
        TERMLOOP_SESSION_ID: claudeSession,
        TERMLOOP_SPIKE_EXPECTED_SESSION: claudeSession,
      },
    },
  );

  const claudeApprovalRaw = await runInteractive(
    "claude",
    [
      "--model",
      "haiku",
      "--permission-mode",
      "default",
      "--tools",
      "Bash",
      "--setting-sources",
      "local",
      "--settings",
      claudeSettingsPath,
    ],
    {
      cwd: projectRoot,
      timeoutMs: 25_000,
      env: {
        ...baseEnv,
        HOME: claudeRoot,
        CLAUDE_CONFIG_DIR: claudeConfig,
        TERMLOOP_SPIKE_INTERACTIVE_INPUT: claudeApprovalPrompt,
        TERMLOOP_SPIKE_AGENT: "claude",
        TERMLOOP_SPIKE_SCENARIO: "approval",
        TERMLOOP_SPIKE_CAPTURE: claudeCapture,
        TERMLOOP_SESSION_ID: claudeSession,
        TERMLOOP_SPIKE_EXPECTED_SESSION: claudeSession,
      },
    },
  );

  const codexRaw = await run(
    "codex",
    [
      "-a",
      "untrusted",
      ...codexHookArgs(command),
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--dangerously-bypass-hook-trust",
      "--json",
      "-s",
      "workspace-write",
      "-C",
      projectRoot,
      codexPrompt,
    ],
    {
      cwd: projectRoot,
      timeoutMs: 120_000,
      env: {
        ...baseEnv,
        TERMLOOP_SPIKE_AGENT: "codex",
        TERMLOOP_SPIKE_SCENARIO: "lifecycle",
        TERMLOOP_SPIKE_CAPTURE: codexCapture,
        TERMLOOP_SESSION_ID: codexSession,
        TERMLOOP_SPIKE_EXPECTED_SESSION: codexSession,
      },
    },
  );

  const codexApproval = await runCodexAppServer({
    cwd: projectRoot,
    timeoutMs: 60_000,
    prompt: codexApprovalPrompt,
    env: {
      ...baseEnv,
      CODEX_HOME: codexHome,
    },
  });

  const claudeEvents = readEvents(claudeCapture);
  const codexEvents = readEvents(codexCapture);
  const claude = {
    version: version("claude"),
    run: sanitizeRun(claudeRaw),
    approvalRun: sanitizeRun(claudeApprovalRaw),
    summary: eventSummary(claudeEvents),
    awaitingInputObservable: eventSummary(claudeEvents).awaitingInputObservable,
    events: claudeEvents,
  };
  const codex = {
    version: version("codex"),
    run: sanitizeRun(codexRaw),
    approvalRun: codexApproval,
    summary: eventSummary(codexEvents),
    awaitingInputObservable: Boolean(codexApproval.approval),
    events: codexEvents,
  };
  const status = statusFor(claude, codex);
  const decision =
    status === "GO"
      ? "Both installed agents expose correlated lifecycle facts and a structured awaiting-input-capable signal. Claude provides it through hooks; Codex provides a first-class App Server approval request. F1-03B does not need PTY parsing or session-log inference."
      : status === "MIXED"
        ? "Only part of the required signal surface was observed. F1-03B must preserve explicit unknown states and limit product claims to the observed agent/event combinations."
        : "The installed CLIs did not prove the required correlation and awaiting-input signal surface. Do not design F1-03B around these hooks without another mechanism.";
  const evidence = {
    schema: "termloop.f1-agent-signals.v1",
    generatedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
    status,
    decision,
    claude,
    codex,
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  chmodSync(evidencePath, 0o600);
  writeFileSync(reportPath, report(evidence));
  process.stdout.write(`F1_AGENT_SIGNAL_SPIKE_${status}\n${reportPath}\n`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
