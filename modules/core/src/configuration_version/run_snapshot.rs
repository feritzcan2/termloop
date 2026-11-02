//! Run configuration snapshot decoding with a field-level rejection reason.
//!
//! The snapshot itself stays strict; this only names the first rejected field
//! as `content.<field>` so a target-bound Improve Agent can correct it.

use serde::de::DeserializeOwned;
use serde_json::Value;
use termloop_domain::{RunConfigurationEnvVar, RunConfigurationKind, RunSetupPolicy};

use super::{RunConfigurationSnapshot, run_candidate};
use crate::CoreError;

const FIELDS: [&str; 10] = [
    "name",
    "kind",
    "command",
    "workingDirectory",
    "env",
    "setupCommand",
    "setupPolicy",
    "urlAutoDetect",
    "fallbackUrls",
    "autoOpenFirstUrl",
];

pub(super) fn parse_valid(
    project_id: &str,
    id: String,
    generation: u64,
    content: &str,
) -> Result<RunConfigurationSnapshot, CoreError> {
    let snapshot: RunConfigurationSnapshot =
        serde_json::from_str(content).map_err(|_| invalid(shape_error_field(content)))?;
    if !run_candidate(project_id, id, generation, &snapshot).is_valid() {
        return Err(invalid(bounds_error_field(project_id, &snapshot)));
    }
    Ok(snapshot)
}

fn invalid(field: Option<String>) -> CoreError {
    CoreError::InvalidParams(field.map_or_else(|| "content".into(), |f| format!("content.{f}")))
}

fn shape_error_field(content: &str) -> Option<String> {
    let value: Value = serde_json::from_str(content).ok()?;
    let object = value.as_object()?;
    if let Some(unknown) = object.keys().find(|key| !FIELDS.contains(&key.as_str())) {
        return Some(unknown.chars().take(64).collect());
    }
    FIELDS
        .into_iter()
        .find(|field| match object.get(*field) {
            None => *field != "setupCommand",
            Some(value) => !field_shape_fits(field, value),
        })
        .map(str::to_owned)
}

fn field_shape_fits(field: &str, value: &Value) -> bool {
    fn fits<T: DeserializeOwned>(value: &Value) -> bool {
        T::deserialize(value).is_ok()
    }
    match field {
        "name" | "command" | "workingDirectory" => fits::<String>(value),
        "kind" => fits::<RunConfigurationKind>(value),
        "env" => fits::<Vec<RunConfigurationEnvVar>>(value),
        "setupCommand" => fits::<Option<String>>(value),
        "setupPolicy" => fits::<RunSetupPolicy>(value),
        "fallbackUrls" => fits::<Vec<String>>(value),
        _ => fits::<bool>(value),
    }
}

/// Substitutes one bounded field at a time into a known-valid baseline so the
/// domain validity rules stay the single source of truth.
fn bounds_error_field(project_id: &str, snapshot: &RunConfigurationSnapshot) -> Option<String> {
    let valid = |candidate: &RunConfigurationSnapshot| {
        run_candidate(project_id, "candidate".into(), 1, candidate).is_valid()
    };
    let candidates = [
        (
            "name",
            RunConfigurationSnapshot {
                name: snapshot.name.clone(),
                ..baseline()
            },
        ),
        (
            "command",
            RunConfigurationSnapshot {
                command: snapshot.command.clone(),
                ..baseline()
            },
        ),
        (
            "workingDirectory",
            RunConfigurationSnapshot {
                working_directory: snapshot.working_directory.clone(),
                ..baseline()
            },
        ),
        (
            "env",
            RunConfigurationSnapshot {
                env: snapshot.env.clone(),
                ..baseline()
            },
        ),
        (
            "setupCommand",
            RunConfigurationSnapshot {
                setup_command: snapshot.setup_command.clone(),
                ..baseline()
            },
        ),
        (
            "fallbackUrls",
            RunConfigurationSnapshot {
                fallback_urls: snapshot.fallback_urls.clone(),
                ..baseline()
            },
        ),
    ];
    candidates
        .into_iter()
        .find(|(_, candidate)| !valid(candidate))
        .map(|(field, _)| field.to_owned())
}

fn baseline() -> RunConfigurationSnapshot {
    RunConfigurationSnapshot {
        name: "candidate".into(),
        kind: RunConfigurationKind::Custom,
        command: "true".into(),
        working_directory: ".".into(),
        env: vec![],
        setup_command: None,
        setup_policy: RunSetupPolicy::Never,
        url_auto_detect: false,
        fallback_urls: vec![],
        auto_open_first_url: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rejected_field(content: &str) -> String {
        match parse_valid("project-1", "candidate".into(), 1, content) {
            Err(CoreError::InvalidParams(field)) => field,
            other => panic!("expected invalid params, got {other:?}"),
        }
    }

    fn snapshot(overrides: Value) -> String {
        let mut value = serde_json::json!({
            "name": "Dev server",
            "kind": "devServer",
            "command": "pnpm dev",
            "workingDirectory": ".",
            "env": [{"name": "PORT", "value": "0"}],
            "setupCommand": null,
            "setupPolicy": "oncePerWorktree",
            "urlAutoDetect": true,
            "fallbackUrls": [],
            "autoOpenFirstUrl": false
        });
        for (key, field) in overrides.as_object().unwrap() {
            if field.is_null() && key.starts_with('-') {
                value.as_object_mut().unwrap().remove(&key[1..]);
            } else {
                value[key] = field.clone();
            }
        }
        value.to_string()
    }

    #[test]
    fn accepts_a_complete_snapshot_with_env_entries() {
        let parsed = parse_valid(
            "project-1",
            "candidate".into(),
            1,
            &snapshot(serde_json::json!({})),
        )
        .unwrap();
        assert_eq!(parsed.env[0].name, "PORT");
    }

    #[test]
    fn names_the_first_rejected_field() {
        for (overrides, expected) in [
            (serde_json::json!({"env": {"PORT": "0"}}), "content.env"),
            (serde_json::json!({"env": {}}), "content.env"),
            (
                serde_json::json!({"workingDirectory": null}),
                "content.workingDirectory",
            ),
            (
                serde_json::json!({"workingDirectory": ""}),
                "content.workingDirectory",
            ),
            (serde_json::json!({"kind": "server"}), "content.kind"),
            (
                serde_json::json!({"setupPolicy": "once"}),
                "content.setupPolicy",
            ),
            (serde_json::json!({"port": 3000}), "content.port"),
            (serde_json::json!({"-command": null}), "content.command"),
            (
                serde_json::json!({"fallbackUrls": ["localhost:3000"]}),
                "content.fallbackUrls",
            ),
            (
                serde_json::json!({"env": [{"name": "A", "value": "1"}, {"name": "A", "value": "2"}]}),
                "content.env",
            ),
        ] {
            assert_eq!(
                rejected_field(&snapshot(overrides.clone())),
                expected,
                "{overrides}"
            );
        }
        assert_eq!(rejected_field("not json"), "content");
        assert_eq!(rejected_field("[]"), "content");
    }

    #[test]
    fn missing_setup_command_defaults_to_none() {
        let parsed = parse_valid(
            "project-1",
            "candidate".into(),
            1,
            &snapshot(serde_json::json!({"-setupCommand": null})),
        )
        .unwrap();
        assert!(parsed.setup_command.is_none());
    }
}
