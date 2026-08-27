export const rules = [
  {
    id: "UNSAFE_OWNER",
    applies: (file) => file.endsWith(".rs") && !file.startsWith("modules/platform/") && !file.startsWith("spikes/"),
    pattern: /\bunsafe\s*(?:\{|fn\b|impl\b|trait\b)/,
    message: "unsafe Rust outside platform adapter"
  },
  {
    id: "OS_CONDITIONAL_OWNER",
    applies: (file) => /\.(rs|tsx?)$/.test(file) && !file.startsWith("modules/platform/") && !file.startsWith("spikes/") && !/^clients\/[^/]+\/src\/platform\//.test(file),
    pattern: /#\s*\[\s*cfg[^\]]*\b(?:unix|windows|target_os)\b|cfg!\s*\([^)]*\b(?:unix|windows|target_os)\b|process\.platform|os\.platform\s*\(/,
    message: "OS conditional outside platform"
  },
  {
    id: "GIT_SUBPROCESS_OWNER",
    applies: (file) => /\.(rs|tsx?|js|mjs)$/.test(file) && !file.startsWith("modules/gitio/") && !file.startsWith("spikes/") && !file.startsWith("tests/"),
    pattern: /(?:Command|CommandRequest)::new\s*\(\s*"git(?:\.exe)?"\s*\)|(?:execFile|execFileSync|spawn|spawnSync)\s*\(\s*["']git(?:\.exe)?["']/,
    message: "Git subprocess invocation outside gitio"
  },
  {
    id: "PROVIDER_NETWORK_OWNER",
    applies: (file) => /\.(rs|tsx?|js|mjs)$/.test(file) && !file.startsWith("modules/providers/") && !file.startsWith("spikes/") && !file.startsWith("tests/"),
    pattern: /(?:Command|CommandRequest)::new\s*\(\s*"(?:gh|az)(?:\.exe)?"\s*\)|(?:execFile|execFileSync|spawn|spawnSync)\s*\(\s*["'](?:gh|az)(?:\.exe)?["']|\b(?:reqwest|octocrab|graphql_client)\b/,
    message: "provider CLI/network invocation outside providers"
  },
  {
    id: "CLIENT_PRIVILEGE",
    applies: (file) => file.startsWith("clients/") && /\.(tsx?|js)$/.test(file) && !/^clients\/[^/]+\/src\/platform\//.test(file),
    pattern: /from ["'](?:node:fs|node:child_process|node:net)["']|require\(["'](?:fs|child_process|net)["']\)/,
    message: "client imports privileged filesystem/process/network primitive"
  },
  {
    id: "COMPANION_PRIVILEGE",
    applies: (file) => file.startsWith("apps/companion/") && /\.(rs|ts)$/.test(file),
    pattern: /termloop_(?:core|store|gitio|platform|terminal|agents|invocation|domain|providers|llm|observability)|std::(?:fs|process)|reqwest|anthropic|openai/,
    message: "Companion imports privileged implementation/provider surface"
  },
  {
    id: "LAUNCH_PROVENANCE",
    applies: (file) => /\.(rs|ts)$/.test(file) && !file.startsWith("modules/invocation/") && !file.startsWith("spikes/"),
    pattern: /LaunchPayload\s*(?:\{|::\s*from_template\s*\()/,
    message: "LaunchPayload constructed outside invocation"
  },
  {
    id: "DIRECT_AGENT_PROCESS_SPAWN",
    applies: (file) => file.endsWith(".rs")
      && !file.startsWith("modules/platform/")
      && file !== "modules/core/src/session_launch/mod.rs"
      && !file.startsWith("spikes/")
      && !file.includes("/tests/"),
    pattern: /spawn_(?:tracked_)?managed_process\s*\(\s*["'](?:claude|codex)["']/,
    message: "Claude/Codex process spawned outside the approved launch seam"
  },
  {
    id: "RAW_AGENT_PTY_SPEC",
    applies: (file) => file.endsWith(".rs")
      && !file.startsWith("modules/terminal/")
      && !file.startsWith("spikes/")
      && !file.includes("/tests/"),
    pattern: /PtySpawnSpec\s*\{[\s\S]{0,600}?program\s*:\s*["'](?:claude|codex)["']\.into\s*\(\s*\)/,
    message: "raw agent PtySpawnSpec bypasses invocation-owned launch data"
  },
  {
    id: "GENERATED_AGENT_SETTINGS_OWNER",
    applies: (file) => file.endsWith(".rs")
      && !file.startsWith("modules/invocation/")
      && !file.startsWith("spikes/")
      && !file.includes("/tests/"),
    pattern: /write_private_file\s*\([^)]*(?:agent-hooks\.json|claude[^)]*settings|settings[^)]*claude)/i,
    message: "generated agent settings materialized outside invocation-owned launch data"
  },
  {
    id: "LITERAL_AGENT_STARTUP_INPUT",
    applies: (file) => file.endsWith(".rs")
      && !file.startsWith("modules/invocation/")
      && !file.startsWith("modules/terminal/")
      && !file.startsWith("spikes/")
      && !file.includes("/tests/"),
    pattern: /\.input\s*\([^,]+,\s*(?:b|br|br#)["']/,
    message: "literal agent startup input bypasses invocation-owned initial input"
  },
  {
    id: "DIRECT_CORE_INPUT_SEQUENCE",
    applies: (file) => file.startsWith("modules/core/")
      && file.endsWith(".rs")
      && file !== "modules/core/src/runtime/generated_input_delivery.rs",
    pattern: /\.(?:input_sequence(?:_receipted)?|input_atomic_receipted(?:_if_user_sequence)?)\s*\(/,
    message: "core feature bypasses the generated input delivery coordinator"
  },
  {
    id: "STORE_WRITE_OWNER",
    applies: (file) => /\.rs$/.test(file) && !file.startsWith("modules/core/") && !file.startsWith("modules/store/") && !file.startsWith("spikes/"),
    pattern: /\.commit\s*\(|CoreWriteAuthority|issue_core_write_authority|\.(?:insert_project|insert_session|mark_session_exited|reconcile_restart|establish_session_resume_ref|mark_session_resuming|complete_session_resume|mark_session_resume_failed|mark_sessions_resume_failed|mark_startup_resume_overflow|delete_session_descriptor)\s*\(/,
    message: "durable store write outside core"
  },
  {
    id: "RESUME_REF_PRIVACY",
    applies: (file) => /\.(rs|tsx?|js|mjs)$/.test(file)
      && !file.startsWith("modules/domain/")
      && !file.startsWith("modules/store/")
      && !file.startsWith("modules/agents/")
      && !file.startsWith("modules/invocation/")
      && !file.startsWith("modules/core/")
      && !file.startsWith("contract/generated/")
      && file !== "apps/server/src/hook.rs"
      && file !== "apps/server/src/app/control/dispatch.rs"
      && !file.startsWith("tools/ci/")
      && !file.startsWith("tests/"),
    pattern: /\b(?:ResumeRef|native_session_id)\b/,
    message: "private provider resume identity escaped its internal owners"
  },
  {
    id: "TERMINAL_JSON_BYTES",
    applies: (file) => /\.(rs|ts)$/.test(file) && !file.startsWith("spikes/"),
    pattern: /(?:base64|JSON\.stringify|serde_json::to_(?:string|vec|value))[\s\S]{0,240}(?:(?<!em)pty|terminalBytes|terminal_bytes)|(?:(?<!em)pty|terminalBytes|terminal_bytes)[\s\S]{0,240}(?:base64|JSON\.stringify|serde_json::to_(?:string|vec|value))/i,
    message: "terminal bytes encoded into control JSON/base64"
  },
  {
    id: "RETIRED_DOMAIN_VOCABULARY",
    applies: (file) => (file.startsWith("modules/domain/") || file.startsWith("modules/core/")) && /\.rs$/.test(file),
    pattern: /\b(?:Workspace|TaskRun|TaskAttempt|ActiveAgentRecord)\b/,
    message: "retired domain aggregate reintroduced"
  },
  {
    id: "RENDERER_TOKEN",
    applies: (file) => /^clients\/[^/]+\/src\/renderer\/.*\.tsx?$/.test(file),
    pattern: /\b(?:terminalToken|controlToken|terminalConfig|RuntimeDiscovery)\b/,
    message: "daemon credential/config reachable from renderer"
  },
  {
    id: "XTERM_OWNER",
    applies: (file) => /^clients\/[^/]+\/src\/.*\.tsx?$/.test(file) && !/\/renderer\/terminal\/xterm\//.test(file),
    pattern: /from ["']@xterm\//,
    message: "xterm imported outside renderer/terminal/xterm adapter"
  },
  {
    id: "REACT_FREE_CLIENT_CORE",
    applies: (file) => /^clients\/[^/]+\/src\/renderer\/(?:transport|terminal|state\/projection).*\.tsx?$/.test(file),
    pattern: /from ["'](?:react|react-dom(?:\/client)?)["']/,
    message: "React imported into renderer-independent client layer"
  },
  {
    id: "STORE_LIB_OWNER",
    applies: (file) => /^clients\/[^/]+\/src\/renderer\/.*\.tsx?$/.test(file) && !/\/renderer\/state\/presentation-store\.ts$/.test(file),
    pattern: /from ["']zustand(?:\/vanilla)?["']|zustand\/middleware/,
    message: "Zustand imported outside presentation store"
  },
  {
    id: "UI_TRANSPORT_SKIP",
    applies: (file) => /^clients\/[^/]+\/src\/renderer\/ui\/.*\.tsx?$/.test(file),
    pattern: /\bnew WebSocket\b|from ["'][^"']*\/(?:transport|terminal)\//,
    message: "UI talks to transport or terminal implementation directly"
  },
  {
    id: "AGENT_TERMINAL_INPUT",
    applies: (file) => file.startsWith("modules/agents/") && /\.rs$/.test(file),
    pattern: /TerminalEvent|TerminalService|terminal_(?:bytes|output)|pty_(?:bytes|output)/,
    message: "agent status reducer consumes terminal output"
  },
  {
    id: "AMBIENT_ENV_OWNER",
    applies: (file) => /\.rs$/.test(file) && !file.startsWith("modules/platform/") && !file.startsWith("spikes/"),
    pattern: /std::env::(?:vars|vars_os)\s*\(/,
    message: "ambient environment enumeration outside platform"
  },
  {
    id: "RAW_LAUNCH_ENVIRONMENT",
    applies: (file) => /\.rs$/.test(file) && !file.startsWith("spikes/"),
    pattern: /runtime_env\s*:/,
    message: "retired raw runtime environment field bypasses LaunchEnvironment"
  },
  {
    id: "LAUNCH_ENV_PERSISTENCE",
    applies: (file) => /\.rs$/.test(file) && (file.startsWith("modules/domain/") || file.startsWith("modules/store/")),
    pattern: /\bLaunchEnvironment\b|\blaunch_environment\s*:/,
    message: "runtime LaunchEnvironment reached a durable-state owner"
  },
  {
    id: "AGENT_TRUST_BYPASS",
    applies: (file) => file.startsWith("modules/invocation/src/") && /\.rs$/.test(file),
    pattern: /--dangerously-bypass-hook-trust/,
    message: "agent hook trust bypass must never enter a production launch"
  }
];

export function scan(file, content) {
  return rules.filter((rule) => rule.applies(file) && rule.pattern.test(content)).map((rule) => ({ id: rule.id, file, message: rule.message }));
}
