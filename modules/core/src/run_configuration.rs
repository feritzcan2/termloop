//! Project-scoped command configurations and their runtime-only Session view.

use crate::{CoreError, CoreRuntime, required_string, store_error, terminal_error};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::Path;
use termloop_domain::{
    ProcessDescriptor, RunConfiguration, RunConfigurationEnvVar, RunConfigurationKind,
    RunSetupMark, RunSetupPolicy, SessionKind, SessionRecord,
};
use termloop_terminal::PtySpawnSpec;

const RUN_URL_LIMIT: usize = 8;
const RUN_SCAN_TAIL_BYTES: usize = 2 * 1024;

#[derive(Debug, Clone)]
pub(crate) struct RunRuntimeObservation {
    project_id: String,
    /// `None` for a run started in the Project's own checkout. This is a
    /// projection slot, not containment: a run Session is never a Task child.
    task_id: Option<String>,
    configuration_id: String,
    url_auto_detect: bool,
    urls: Vec<String>,
    exit_code: Option<u32>,
    scan_tail: String,
    pending_setup: Option<PendingRunSetup>,
}

#[derive(Debug, Clone)]
struct PendingRunSetup {
    marker: String,
    mark: RunSetupMark,
}

/// Everything an Improve-with-agent launch needs about its target, resolved
/// from durable state rather than from caller input. The two variants carry
/// different facts because they resolve different visible prompts.
#[derive(Debug, Clone)]
pub enum RunConfigurationImproverBindings {
    Existing {
        configuration_id: String,
        configuration_name: String,
        checkout_path: String,
    },
    New {
        kind: &'static str,
        kind_label: &'static str,
        name: &'static str,
        checkout_path: String,
    },
}

impl RunConfigurationImproverBindings {
    pub fn checkout_path(&self) -> &str {
        match self {
            Self::Existing { checkout_path, .. } | Self::New { checkout_path, .. } => checkout_path,
        }
    }

    /// The exact target a redeemed launch ticket must still name. `None` is the
    /// not-yet-created case, which is bound by kind instead.
    pub fn configuration_id(&self) -> Option<&str> {
        match self {
            Self::Existing {
                configuration_id, ..
            } => Some(configuration_id),
            Self::New { .. } => None,
        }
    }

    pub fn new_kind(&self) -> Option<&str> {
        match self {
            Self::Existing { .. } => None,
            Self::New { kind, .. } => Some(kind),
        }
    }

    /// What the Session rail calls this improver. The name states the job and
    /// its target, so an improver never sits in the rail as another
    /// indistinguishable "Claude".
    pub fn session_name(&self) -> String {
        match self {
            Self::Existing {
                configuration_name, ..
            } => format!("improve: {configuration_name}"),
            Self::New { kind_label, .. } => format!("set up: {kind_label}"),
        }
    }

    pub fn improver_target(&self) -> termloop_invocation::ImproverTarget<'_> {
        match self {
            Self::Existing {
                configuration_id,
                configuration_name,
                ..
            } => termloop_invocation::ImproverTarget::RunConfiguration {
                configuration_id,
                configuration_name,
            },
            Self::New {
                kind,
                kind_label,
                name,
                ..
            } => termloop_invocation::ImproverTarget::NewRunConfiguration {
                kind,
                kind_label,
                name,
            },
        }
    }
}

/// What an Improve-with-agent flow is aimed at. `New` is not a lesser case: the
/// first setup is exactly when a user most wants an agent to work the command
/// out, so it is a first-class target with its own visible prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunImproverTarget {
    Existing { configuration_id: String },
    New { kind: RunConfigurationKind },
}

impl RunImproverTarget {
    /// Parses the closed selector: exactly one of the two slots is filled. A
    /// request naming both, or neither, is refused rather than guessed.
    fn parse(params: &Value) -> Result<Self, CoreError> {
        let configuration_id = params
            .get("configurationId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty());
        let new_kind = params.get("newKind").and_then(Value::as_str);
        match (configuration_id, new_kind) {
            (Some(configuration_id), None) => Ok(Self::Existing {
                configuration_id: configuration_id.to_owned(),
            }),
            (None, Some(kind)) => serde_json::from_value(json!(kind))
                .map(|kind| Self::New { kind })
                .map_err(|_| CoreError::InvalidParams("newKind".into())),
            _ => Err(CoreError::InvalidParams("improverTarget".into())),
        }
    }
}

/// The generated-contract wire value of a run kind.
fn run_kind_wire(kind: RunConfigurationKind) -> &'static str {
    match kind {
        RunConfigurationKind::DevServer => "devServer",
        RunConfigurationKind::Build => "build",
        RunConfigurationKind::TestRunner => "testRunner",
        RunConfigurationKind::Typecheck => "typecheck",
        RunConfigurationKind::Storybook => "storybook",
        RunConfigurationKind::Custom => "custom",
    }
}

/// How the prompt refers to the kind in the user's own words.
fn run_kind_label(kind: RunConfigurationKind) -> &'static str {
    match kind {
        RunConfigurationKind::DevServer => "dev server",
        RunConfigurationKind::Build => "build",
        RunConfigurationKind::TestRunner => "test runner",
        RunConfigurationKind::Typecheck => "type check",
        RunConfigurationKind::Storybook => "Storybook",
        RunConfigurationKind::Custom => "run",
    }
}

/// The name an improver starts from when nothing is stored yet.
fn run_kind_default_name(kind: RunConfigurationKind) -> &'static str {
    match kind {
        RunConfigurationKind::DevServer => "Dev server",
        RunConfigurationKind::Build => "Build",
        RunConfigurationKind::TestRunner => "Tests",
        RunConfigurationKind::Typecheck => "Type check",
        RunConfigurationKind::Storybook => "Storybook",
        RunConfigurationKind::Custom => "Run",
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunConfigurationInput {
    name: String,
    kind: RunConfigurationKind,
    command: String,
    working_directory: String,
    env: Vec<RunConfigurationEnvVar>,
    setup_command: Option<String>,
    setup_policy: RunSetupPolicy,
    url_auto_detect: bool,
    fallback_urls: Vec<String>,
    auto_open_first_url: bool,
    expected_revision: u64,
}

impl CoreRuntime {
    pub(crate) fn retain_run_runtimes_outside_project(&mut self, project_id: &str) {
        self.run_runtimes
            .retain(|_, runtime| runtime.project_id != project_id);
    }

    pub(crate) fn list_run_configurations(&self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        let configurations = self
            .store
            .run_configurations()
            .iter()
            .filter(|configuration| configuration.project_id == project_id)
            .collect::<Vec<_>>();
        Ok(json!({
            "configurations": configurations,
            "stateRevision": self.store.revision(),
        }))
    }

    pub(crate) fn create_run_configuration(&mut self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        let input = parse_configuration_input(params)?;
        let configuration = RunConfiguration {
            id: termloop_platform::generate_opaque_id(),
            project_id,
            name: input.name,
            kind: input.kind,
            command: input.command,
            working_directory: input.working_directory,
            env: input.env,
            setup_command: input.setup_command,
            setup_policy: input.setup_policy,
            url_auto_detect: input.url_auto_detect,
            fallback_urls: input.fallback_urls,
            auto_open_first_url: input.auto_open_first_url,
            generation: 1,
            updated_at_epoch_ms: termloop_platform::current_epoch_ms(),
        };
        let configuration = self
            .store
            .set_run_configuration(
                &self.write_authority,
                configuration,
                input.expected_revision,
            )
            .map_err(store_error)?;
        Ok(json!({
            "configuration": configuration,
            "stateRevision": self.store.revision(),
        }))
    }

    pub(crate) fn update_run_configuration(&mut self, params: Value) -> Result<Value, CoreError> {
        let configuration_id = required_string(&params, "configurationId")?;
        let input = parse_configuration_input(params)?;
        let current = self
            .store
            .run_configurations()
            .iter()
            .find(|configuration| configuration.id == configuration_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        let mut configuration = RunConfiguration {
            id: current.id.clone(),
            project_id: current.project_id.clone(),
            name: input.name,
            kind: input.kind,
            command: input.command,
            working_directory: input.working_directory,
            env: input.env,
            setup_command: input.setup_command,
            setup_policy: input.setup_policy,
            url_auto_detect: input.url_auto_detect,
            fallback_urls: input.fallback_urls,
            auto_open_first_url: input.auto_open_first_url,
            generation: current.generation,
            updated_at_epoch_ms: current.updated_at_epoch_ms,
        };
        if configuration == current {
            if input.expected_revision != self.store.revision() {
                return Err(CoreError::RevisionConflict);
            }
            return Ok(json!({
                "configuration": current,
                "stateRevision": self.store.revision(),
            }));
        }
        configuration.generation = current
            .generation
            .checked_add(1)
            .ok_or_else(|| CoreError::InvalidParams("configurationId".into()))?;
        configuration.updated_at_epoch_ms = termloop_platform::current_epoch_ms();
        let configuration = self
            .store
            .set_run_configuration(
                &self.write_authority,
                configuration,
                input.expected_revision,
            )
            .map_err(store_error)?;
        Ok(json!({
            "configuration": configuration,
            "stateRevision": self.store.revision(),
        }))
    }

    pub(crate) fn delete_run_configuration(&mut self, params: Value) -> Result<Value, CoreError> {
        let configuration_id = required_string(&params, "configurationId")?;
        if self.run_runtimes.iter().any(|(session_id, runtime)| {
            runtime.configuration_id == configuration_id
                && runtime.exit_code.is_none()
                && self
                    .terminal
                    .session_is_running(session_id, self.runtime_epoch)
                    .is_ok_and(|running| running)
        }) {
            return Err(CoreError::InvalidParams("configurationId".into()));
        }
        let expected_revision = params
            .get("expectedRevision")
            .and_then(Value::as_u64)
            .ok_or_else(|| CoreError::InvalidParams("expectedRevision".into()))?;
        let deleted = self
            .store
            .delete_run_configuration(&self.write_authority, &configuration_id, expected_revision)
            .map_err(store_error)?;
        self.run_runtimes
            .retain(|_, runtime| runtime.configuration_id != configuration_id);
        Ok(json!({
            "configurationId": deleted.id,
            "deleted": true,
            "stateRevision": self.store.revision(),
        }))
    }

    pub(crate) fn project_checkout_path(&self, project_id: &str) -> Result<String, CoreError> {
        self.store
            .projects()
            .iter()
            .find(|project| project.id == project_id)
            .map(|project| project.folder_path.clone())
            .ok_or(CoreError::NotFound)
    }

    /// The improver's launch facts: where it works and the closed target it may
    /// edit. The active snapshot is read through the target-bound version tool,
    /// so launch input does not duplicate the complete configuration.
    pub fn run_configuration_improver_bindings(
        &self,
        project_id: &str,
        params: &Value,
    ) -> Result<RunConfigurationImproverBindings, CoreError> {
        let target = RunImproverTarget::parse(params)?;
        let checkout_path = self.project_checkout_path(project_id)?;
        match &target {
            RunImproverTarget::Existing { configuration_id } => {
                let configuration = self.owned_run_configuration(project_id, configuration_id)?;
                Ok(RunConfigurationImproverBindings::Existing {
                    configuration_id: configuration.id,
                    configuration_name: configuration.name,
                    checkout_path,
                })
            }
            RunImproverTarget::New { kind } => {
                self.refuse_duplicate_kind(project_id, *kind)?;
                Ok(RunConfigurationImproverBindings::New {
                    kind: run_kind_wire(*kind),
                    kind_label: run_kind_label(*kind),
                    name: run_kind_default_name(*kind),
                    checkout_path,
                })
            }
        }
    }

    /// One configuration per kind at Project level: the launcher bar finds a
    /// dev server by kind, so a second one would be unreachable.
    fn refuse_duplicate_kind(
        &self,
        project_id: &str,
        kind: RunConfigurationKind,
    ) -> Result<(), CoreError> {
        if !self.project_exists(project_id) {
            return Err(CoreError::NotFound);
        }
        if self.store.run_configurations().iter().any(|configuration| {
            configuration.project_id == project_id && configuration.kind == kind
        }) {
            return Err(CoreError::InvalidParams("newKind".into()));
        }
        Ok(())
    }

    fn owned_run_configuration(
        &self,
        project_id: &str,
        configuration_id: &str,
    ) -> Result<RunConfiguration, CoreError> {
        self.store
            .run_configurations()
            .iter()
            .find(|configuration| {
                configuration.id == configuration_id && configuration.project_id == project_id
            })
            .cloned()
            .ok_or(CoreError::NotFound)
    }

    pub(crate) fn list_run_runtime(&self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        let runs = self
            .run_runtimes
            .iter()
            .filter(|(_, runtime)| runtime.project_id == project_id)
            .map(|(session_id, runtime)| {
                json!({
                    "sessionId": session_id,
                    "taskId": runtime.task_id,
                    "configurationId": runtime.configuration_id,
                    "urls": runtime.urls,
                    "exitCode": runtime.exit_code,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "runs": runs, "stateRevision": self.store.revision() }))
    }

    pub fn forwardable_run_ports(&self) -> HashSet<u16> {
        self.run_runtimes
            .values()
            .filter(|runtime| runtime.exit_code.is_none())
            .flat_map(|runtime| runtime.urls.iter().filter_map(|url| local_url_port(url)))
            .collect()
    }

    /// `task_id` is `None` for the Project's own checkout, which is a distinct
    /// slot from every Task worktree running the same configuration.
    pub fn active_run_session(
        &self,
        task_id: Option<&str>,
        configuration_id: &str,
    ) -> Option<String> {
        self.run_runtimes
            .iter()
            .find(|(session_id, runtime)| {
                runtime.task_id.as_deref() == task_id
                    && runtime.configuration_id == configuration_id
                    && runtime.exit_code.is_none()
                    && self
                        .terminal
                        .session_is_running(session_id, self.runtime_epoch)
                        .is_ok_and(|running| running)
            })
            .map(|(session_id, _)| session_id.clone())
    }

    pub fn run_session_projection(&self, session_id: &str) -> Result<Value, CoreError> {
        self.store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .map(|session| self.project_session(session))
            .ok_or(CoreError::NotFound)
    }

    pub fn complete_task_run_launch(
        &mut self,
        observed: crate::ObservedTaskWorktreeLaunch,
        configuration_id: &str,
        force_setup: bool,
    ) -> Result<Value, CoreError> {
        self.revalidate_task_launch(&observed.plan)?;
        self.launch_run(
            observed.plan.project_id(),
            Some(observed.plan.task_id()),
            observed.plan.worktree_path(),
            configuration_id,
            force_setup,
        )
    }

    /// The same configuration started in the Project's own checkout — the one
    /// the Project points at, not a Task worktree. It needs no worktree
    /// observation because no managed checkout is involved.
    pub fn complete_project_run_launch(
        &mut self,
        project_id: &str,
        configuration_id: &str,
        force_setup: bool,
    ) -> Result<Value, CoreError> {
        if !self.project_exists(project_id) {
            return Err(CoreError::NotFound);
        }
        let checkout_path = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == project_id)
            .map(|project| project.folder_path.clone())
            .ok_or(CoreError::NotFound)?;
        self.launch_run(
            project_id,
            None,
            &checkout_path,
            configuration_id,
            force_setup,
        )
    }

    /// One launch path for both checkout kinds. `task_id` names the runtime
    /// slot and the Task environment variable; `checkout_path` is the root the
    /// configuration's working directory resolves inside, and the identity a
    /// once-per-checkout setup mark is recorded against.
    fn launch_run(
        &mut self,
        project_id: &str,
        task_id: Option<&str>,
        checkout_path: &str,
        configuration_id: &str,
        force_setup: bool,
    ) -> Result<Value, CoreError> {
        if let Some(session_id) = self.active_run_session(task_id, configuration_id) {
            return self.run_session_projection(&session_id);
        }
        let configuration = self
            .store
            .run_configurations()
            .iter()
            .find(|configuration| {
                configuration.id == configuration_id && configuration.project_id == project_id
            })
            .cloned()
            .ok_or(CoreError::NotFound)?;
        let cwd = termloop_platform::resolve_existing_directory_within(
            Path::new(checkout_path),
            Path::new(&configuration.working_directory),
        )
        .map_err(|_| CoreError::InvalidParams("workingDirectory".into()))?
        .to_string_lossy()
        .into_owned();
        self.ensure_launch_not_reserved(Path::new(&cwd))?;
        let setup_needed = configuration.setup_command.is_some()
            && match configuration.setup_policy {
                RunSetupPolicy::Never => false,
                RunSetupPolicy::Always => true,
                RunSetupPolicy::OncePerWorktree => {
                    force_setup
                        || !self.store.run_setup_marks().iter().any(|mark| {
                            mark.configuration_id == configuration.id
                                && mark.worktree_path == checkout_path
                                && mark.configuration_generation == configuration.generation
                        })
                }
            };
        let pending_setup = setup_needed.then(|| PendingRunSetup {
            marker: termloop_platform::generate_opaque_runtime_token(),
            mark: RunSetupMark {
                project_id: configuration.project_id.clone(),
                configuration_id: configuration.id.clone(),
                worktree_path: checkout_path.to_owned(),
                configuration_generation: configuration.generation,
                completed_at_epoch_ms: 0,
            },
        });
        let (program, args) = match (&configuration.setup_command, &pending_setup) {
            (Some(setup), Some(pending)) => termloop_platform::shell_command_with_setup_marker(
                setup,
                &configuration.command,
                &pending.marker,
            ),
            _ => termloop_platform::shell_command(&configuration.command),
        };
        let session_id = termloop_platform::generate_uuid_v4();
        let session = SessionRecord {
            launch_selection: Default::default(),
            id: session_id.clone(),
            project_id: configuration.project_id.clone(),
            name: Some(configuration.name.clone()),
            kind: SessionKind::Terminal,
            process: ProcessDescriptor {
                program: program.clone(),
                args: args.clone(),
                cwd: cwd.clone(),
                agent_id: None,
                template_ref: None,
                template_version: None,
            },
            lifecycle_state: "running".into(),
            runtime_epoch: self.runtime_epoch,
            archived_at_epoch_ms: None,
            ask_to_source_session_id: None,
            run_configuration_id: Some(configuration.id.clone()),
            improver_target: None,
            ask_to_continuation: None,
            resume_ref: None,
            resume_launch_guard: None,
            resume_failure: None,
        };
        let environment = configuration.env.iter().fold(
            termloop_platform::LaunchEnvironment::os_baseline()
                .with_explicit("TERMLOOP_PROJECT_ID", &configuration.project_id)
                .with_explicit("TERMLOOP_TASK_ID", task_id.unwrap_or_default())
                .with_explicit("TERMLOOP_WORKTREE_PATH", checkout_path)
                .with_explicit("TERMLOOP_RUN_CONFIGURATION_ID", &configuration.id),
            |environment, entry| environment.with_explicit(&entry.name, &entry.value),
        );
        self.terminal
            .spawn(PtySpawnSpec {
                session_id: session_id.clone(),
                runtime_epoch: self.runtime_epoch,
                program,
                args,
                cwd,
                environment,
                recent_output_replay: true,
            })
            .map_err(terminal_error)?;
        if let Err(error) =
            self.store
                .insert_run_session(&self.write_authority, session.clone(), None)
        {
            let _ = self.terminal.terminate(&session_id);
            return Err(store_error(error));
        }
        self.run_runtimes.retain(|_, runtime| {
            runtime.task_id.as_deref() != task_id || runtime.configuration_id != configuration.id
        });
        self.run_runtimes.insert(
            session_id,
            RunRuntimeObservation {
                project_id: configuration.project_id,
                task_id: task_id.map(str::to_owned),
                configuration_id: configuration.id,
                url_auto_detect: configuration.url_auto_detect,
                urls: configuration.fallback_urls,
                exit_code: None,
                scan_tail: String::new(),
                pending_setup,
            },
        );
        Ok(self.project_session(&session))
    }

    pub fn record_run_terminal_output(&mut self, session_id: &str, bytes: &[u8]) -> bool {
        let (mut changed, completed_setup) = {
            let Some(runtime) = self.run_runtimes.get_mut(session_id) else {
                return false;
            };
            if runtime.pending_setup.is_none()
                && (!runtime.url_auto_detect || runtime.urls.len() >= RUN_URL_LIMIT)
            {
                return false;
            }
            runtime.scan_tail.push_str(&String::from_utf8_lossy(bytes));
            if runtime.scan_tail.len() > RUN_SCAN_TAIL_BYTES {
                let keep_from = runtime.scan_tail.len() - RUN_SCAN_TAIL_BYTES;
                let keep_from = runtime
                    .scan_tail
                    .char_indices()
                    .find_map(|(index, _)| (index >= keep_from).then_some(index))
                    .unwrap_or(0);
                runtime.scan_tail.drain(..keep_from);
            }
            let completed_setup = runtime
                .pending_setup
                .as_ref()
                .is_some_and(|pending| runtime.scan_tail.contains(&pending.marker))
                .then(|| runtime.pending_setup.take())
                .flatten();
            let mut changed = false;
            if runtime.url_auto_detect {
                for url in detected_local_urls(&runtime.scan_tail) {
                    if runtime.urls.len() >= RUN_URL_LIMIT {
                        break;
                    }
                    if !runtime.urls.contains(&url) {
                        runtime.urls.push(url);
                        changed = true;
                    }
                }
            }
            (changed, completed_setup)
        };
        if let Some(mut pending) = completed_setup {
            pending.mark.completed_at_epoch_ms = termloop_platform::current_epoch_ms();
            if self
                .store
                .record_run_setup_mark(&self.write_authority, pending.mark.clone())
                .is_ok()
            {
                changed = true;
            } else if let Some(runtime) = self.run_runtimes.get_mut(session_id) {
                runtime.pending_setup = Some(pending);
            }
        }
        changed
    }

    pub(crate) fn record_run_exit(&mut self, session_id: &str, exit_code: u32) {
        if let Some(runtime) = self.run_runtimes.get_mut(session_id) {
            runtime.exit_code = Some(exit_code);
        }
    }
}

fn parse_configuration_input(mut params: Value) -> Result<RunConfigurationInput, CoreError> {
    if let Some(object) = params.as_object_mut() {
        object.remove("projectId");
        object.remove("configurationId");
    }
    serde_json::from_value(params).map_err(|_| CoreError::InvalidParams("runConfiguration".into()))
}

fn detected_local_urls(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    for scheme in ["http://", "https://"] {
        let mut cursor = 0;
        while let Some(offset) = text[cursor..].find(scheme) {
            let start = cursor + offset;
            let tail = &text[start..];
            let end = tail
                .char_indices()
                .skip(1)
                .find_map(|(index, character)| {
                    (character.is_whitespace()
                        || character.is_control()
                        || matches!(character, '"' | '\'' | '<' | '>' | ')' | '}'))
                    .then_some(index)
                })
                .unwrap_or(tail.len());
            let raw = tail[..end].trim_end_matches([',', '.', ';', ':']);
            if let Some(url) = normalize_local_url(raw)
                && !urls.contains(&url)
            {
                urls.push(url);
            }
            cursor = start + scheme.len();
        }
    }
    urls
}

fn normalize_local_url(url: &str) -> Option<String> {
    let scheme_end = url.find("://")? + 3;
    let authority_end = url[scheme_end..]
        .find(['/', '?', '#'])
        .map(|offset| scheme_end + offset)
        .unwrap_or(url.len());
    let authority = &url[scheme_end..authority_end];
    let replacement = if authority == "0.0.0.0" {
        Some("localhost")
    } else if let Some(port) = authority.strip_prefix("0.0.0.0:") {
        return Some(format!(
            "{}localhost:{port}{}",
            &url[..scheme_end],
            &url[authority_end..]
        ));
    } else if authority == "[::]" || authority == "[::1]" {
        Some("localhost")
    } else if let Some(port) = authority
        .strip_prefix("[::]:")
        .or_else(|| authority.strip_prefix("[::1]:"))
    {
        return Some(format!(
            "{}localhost:{port}{}",
            &url[..scheme_end],
            &url[authority_end..]
        ));
    } else if authority == "localhost"
        || authority.starts_with("localhost:")
        || authority == "127.0.0.1"
        || authority.starts_with("127.0.0.1:")
    {
        None
    } else {
        return None;
    };
    Some(format!(
        "{}{}{}",
        &url[..scheme_end],
        replacement.unwrap_or(authority),
        &url[authority_end..]
    ))
}

fn local_url_port(url: &str) -> Option<u16> {
    let (default_port, remainder) = if let Some(remainder) = url.strip_prefix("http://") {
        (80, remainder)
    } else if let Some(remainder) = url.strip_prefix("https://") {
        (443, remainder)
    } else {
        return None;
    };
    let authority = remainder.split(['/', '?', '#']).next()?;
    if authority == "localhost" || authority == "127.0.0.1" {
        return Some(default_port);
    }
    let port = authority
        .strip_prefix("localhost:")
        .or_else(|| authority.strip_prefix("127.0.0.1:"))?;
    port.parse::<u16>().ok().filter(|port| *port != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forward_ports_accept_only_normalized_loopback_http_urls() {
        assert_eq!(local_url_port("http://localhost:5173/app"), Some(5173));
        assert_eq!(local_url_port("https://127.0.0.1"), Some(443));
        assert_eq!(local_url_port("http://localhost"), Some(80));
        assert_eq!(local_url_port("https://example.com:443"), None);
        assert_eq!(local_url_port("ftp://localhost:21"), None);
        assert_eq!(local_url_port("http://localhost:0"), None);
    }

    fn configuration_input() -> Value {
        json!({
            "name": "Dev server",
            "kind": "devServer",
            "command": "pnpm dev",
            "workingDirectory": ".",
            "env": [],
            "setupCommand": null,
            "setupPolicy": "oncePerWorktree",
            "urlAutoDetect": true,
            "fallbackUrls": [],
            "autoOpenFirstUrl": false,
            "expectedRevision": 0
        })
    }

    #[test]
    fn configuration_input_accepts_exact_create_or_update_identity() {
        let mut create = configuration_input();
        create["projectId"] = json!("project-1");
        assert!(parse_configuration_input(create).is_ok());

        let mut update = configuration_input();
        update["configurationId"] = json!("run-1");
        assert!(parse_configuration_input(update).is_ok());

        let mut unknown = configuration_input();
        unknown["surprise"] = json!(true);
        assert!(parse_configuration_input(unknown).is_err());
    }

    #[test]
    fn the_improver_target_selector_accepts_exactly_one_slot() {
        assert_eq!(
            RunImproverTarget::parse(&json!({ "configurationId": "run-1" })).unwrap(),
            RunImproverTarget::Existing {
                configuration_id: "run-1".into()
            }
        );
        assert_eq!(
            RunImproverTarget::parse(&json!({ "newKind": "devServer" })).unwrap(),
            RunImproverTarget::New {
                kind: RunConfigurationKind::DevServer
            }
        );
        assert!(RunImproverTarget::parse(&json!({})).is_err());
        assert!(
            RunImproverTarget::parse(
                &json!({ "configurationId": "run-1", "newKind": "devServer" })
            )
            .is_err()
        );
        assert!(RunImproverTarget::parse(&json!({ "newKind": "surprise" })).is_err());
    }

    #[test]
    fn local_url_detection_normalizes_bind_all_hosts_and_rejects_remote_hosts() {
        assert_eq!(
            detected_local_urls(
                "ready at http://0.0.0.0:5173/app and https://[::1]:444/; https://example.com"
            ),
            ["http://localhost:5173/app", "https://localhost:444/"]
        );
    }
}
