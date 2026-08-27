use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, de::DeserializeOwned};

use crate::{CommandRequest, CommandTermination, ResolvedExecutable, run_command};

use super::{ManagerBackend, ManagerSkill, SkillAgent, SkillManagerError};

const CLI_OUTPUT_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Debug)]
pub(super) struct CliBackend {
    executable: ResolvedExecutable,
}

impl CliBackend {
    pub(super) fn new(executable: ResolvedExecutable) -> Self {
        Self { executable }
    }
}

impl ManagerBackend for CliBackend {
    fn list(&self) -> Result<Vec<ManagerSkill>, SkillManagerError> {
        self.run_json(list_arguments(), Duration::from_secs(20))
    }

    fn install_local(&self, path: &Path) -> Result<String, SkillManagerError> {
        let report: InstallReport =
            self.run_json(install_arguments(path), Duration::from_secs(60))?;
        if !report.ok || report.skill_id.is_empty() {
            return Err(SkillManagerError::InvalidOutput);
        }
        Ok(report.skill_id)
    }

    fn set_deployment(
        &self,
        skill_id: &str,
        agent: SkillAgent,
        deployed: bool,
    ) -> Result<(), SkillManagerError> {
        let report: DeploymentReport = self.run_json(
            deployment_arguments(skill_id, agent, deployed),
            Duration::from_secs(60),
        )?;
        if !report.ok {
            return Err(SkillManagerError::InvalidOutput);
        }
        if !report.preserved.is_empty() {
            return Err(SkillManagerError::CommandFailed(
                "a changed deployment was preserved; inspect it in Skills Manager".into(),
            ));
        }
        Ok(())
    }
}

pub(super) fn list_arguments() -> Vec<OsString> {
    ["--json", "skills", "list"]
        .into_iter()
        .map(OsString::from)
        .collect()
}

pub(super) fn install_arguments(path: &Path) -> Vec<OsString> {
    vec![
        OsString::from("--json"),
        OsString::from("skills"),
        OsString::from("install"),
        path.as_os_str().to_owned(),
        OsString::from("--local"),
    ]
}

pub(super) fn deployment_arguments(
    skill_id: &str,
    agent: SkillAgent,
    deployed: bool,
) -> Vec<OsString> {
    vec![
        OsString::from("--json"),
        OsString::from("skills"),
        OsString::from(if deployed { "deploy" } else { "undeploy" }),
        OsString::from(skill_id),
        OsString::from("--agent"),
        OsString::from(agent.manager_key()),
    ]
}

impl CliBackend {
    fn run_json<T>(
        &self,
        args: impl IntoIterator<Item = OsString>,
        timeout: Duration,
    ) -> Result<T, SkillManagerError>
    where
        T: DeserializeOwned,
    {
        self.executable.revalidate()?;
        let outcome = run_command(
            CommandRequest::new(self.executable.path().as_os_str().to_owned())
                .args(args)
                .timeout(timeout)
                .output_limit(CLI_OUTPUT_LIMIT),
        )?;
        if outcome.termination == CommandTermination::TimedOut {
            return Err(SkillManagerError::CommandFailed("command timed out".into()));
        }
        if outcome.stdout_truncated || outcome.stderr_truncated {
            return Err(SkillManagerError::CommandFailed(
                "command output exceeded its safety limit".into(),
            ));
        }
        if !outcome.success() {
            return Err(SkillManagerError::CommandFailed(cli_error_message(
                &outcome.stderr,
            )));
        }
        serde_json::from_slice(&outcome.stdout).map_err(|_| SkillManagerError::InvalidOutput)
    }
}

#[derive(Debug, Deserialize)]
struct InstallReport {
    ok: bool,
    skill_id: String,
}

#[derive(Debug, Deserialize)]
struct DeploymentReport {
    ok: bool,
    #[serde(default)]
    preserved: Vec<String>,
}

fn cli_error_message(stderr: &[u8]) -> String {
    let parsed = serde_json::from_slice::<serde_json::Value>(stderr).ok();
    let value = parsed
        .as_ref()
        .and_then(|value| value.get("message").or_else(|| value.get("error")))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("command was refused");
    let single_line = value
        .chars()
        .map(|value| if value.is_control() { ' ' } else { value })
        .collect::<String>();
    single_line.trim().chars().take(400).collect()
}
