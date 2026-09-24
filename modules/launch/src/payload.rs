#[derive(Clone)]
pub struct LaunchPayload {
    program: String,
    args: Vec<String>,
    environment: termloop_platform::LaunchEnvironment,
    provenance: Provenance,
    codex_app_server_developer_instructions: Option<String>,
    codex_runtime_policy: CodexRuntimePolicy,
    initial_input: Option<InitialInputDelivery>,
    inspectable: InspectableLaunchManifest,
    bindings: Vec<(String, String)>,
    delivered_prompt: Option<String>,
}

pub struct ResolvedLaunchManifest {
    target: termloop_platform::ResolvedLaunchTarget,
    arguments: Vec<ResolvedArgument>,
    environment: termloop_platform::LaunchEnvironment,
    provenance: Provenance,
    codex_app_server_developer_instructions: Option<String>,
    codex_runtime_policy: CodexRuntimePolicy,
    initial_input: Option<InitialInputDelivery>,
    inspectable: InspectableLaunchManifest,
    bindings: Vec<(String, String)>,
    delivered_prompt: Option<String>,
}

#[derive(Clone)]
struct InitialInputDelivery {
    delivered: String,
    sequence: Vec<Vec<u8>>,
}

impl InitialInputDelivery {
    fn submitted(content: &str) -> Result<Self, InvocationError> {
        Ok(Self {
            delivered: format!("{content}\r"),
            // Mark generated content as one terminal paste where the host PTY
            // preserves that framing. Raw rapid characters can otherwise be
            // reclassified by agent TUIs after they have already queued Enter.
            // Every host keeps Enter as a separate, delayed sequence chunk.
            // ConPTY cannot reliably pass injected bracket markers through a
            // cooked input consumer, so platform selects unframed content on
            // Windows while retaining the delayed Enter boundary.
            sequence: termloop_platform::generated_terminal_paste_submission_sequence(
                content.as_bytes(),
            )
            .map_err(|_| InvocationError::InvalidPromptBinding)?,
        })
    }
}

impl ResolvedLaunchManifest {
    pub fn into_payload(self) -> LaunchPayload {
        // `ResolvedLaunchTarget::command_line` is the single spawn-composition
        // point; the manifest never assembles a `.cmd` wrapper itself. UTF-8
        // safety of the resolved pieces was proven during manifest resolution
        // and every appended argument value originates from a `String`.
        let (program, args) = self
            .target
            .command_line(self.arguments.into_iter().map(|argument| argument.value));
        LaunchPayload {
            program: program.to_string_lossy().into_owned(),
            args: args
                .into_iter()
                .map(|argument| argument.to_string_lossy().into_owned())
                .collect(),
            environment: self.environment,
            provenance: self.provenance,
            codex_app_server_developer_instructions: self.codex_app_server_developer_instructions,
            codex_runtime_policy: self.codex_runtime_policy,
            initial_input: self.initial_input,
            inspectable: self.inspectable,
            bindings: self.bindings,
            delivered_prompt: self.delivered_prompt,
        }
    }
}

impl std::fmt::Debug for LaunchPayload {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LaunchPayload")
            .field("program", &self.program)
            .field("private_arg_count", &self.args.len())
            .field(
                "environment_keys",
                &self.environment.keys().collect::<Vec<_>>(),
            )
            .field("provenance", &self.provenance)
            .finish()
    }
}

#[derive(Clone, Copy)]
pub struct AgentObservationLaunch<'a> {
    pub session_id: &'a str,
    pub endpoint: &'a str,
    pub token: &'a str,
    pub transport: AgentObservationLaunchTransport<'a>,
}

#[derive(Clone, Copy)]
pub enum AgentObservationLaunchTransport<'a> {
    InlineSettings {
        content: &'a str,
        inspectable_content: &'a str,
    },
    EnvironmentSettingsPath {
        variable: &'a str,
        path: &'a str,
        content: &'a str,
        inspectable_content: &'a str,
    },
    DaemonOwnedBridge {
        endpoint: &'a str,
    },
}
