//! The environments a PM project ships through, in delivery order, and which
//! of them are production. Without a list, an environment whose name contains
//! "prod" counts as production.

use crate::validation::valid_label;

pub const PROJECT_ENVIRONMENTS_MAX: usize = 12;
pub const ENVIRONMENT_NAME_MAX_CHARS: usize = 120;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProjectEnvironment {
    pub name: String,
    pub production: bool,
}

pub fn valid_environment_name(name: &str) -> bool {
    valid_label(name, ENVIRONMENT_NAME_MAX_CHARS)
}

/// At most [`PROJECT_ENVIRONMENTS_MAX`] environments with valid names, unique
/// ignoring ASCII case. An empty list is valid and means "no list".
pub fn valid_project_environments(environments: &[ProjectEnvironment]) -> bool {
    environments.len() <= PROJECT_ENVIRONMENTS_MAX
        && environments.iter().enumerate().all(|(index, environment)| {
            valid_environment_name(&environment.name)
                && !environments[index + 1..]
                    .iter()
                    .any(|other| other.name.eq_ignore_ascii_case(&environment.name))
        })
}

/// Whether an environment counts as production: the project's own list
/// decides when it names the environment, otherwise the name does.
pub fn environment_is_production(environments: &[ProjectEnvironment], name: &str) -> bool {
    environments
        .iter()
        .find(|environment| environment.name.eq_ignore_ascii_case(name))
        .map_or_else(
            || name.to_ascii_lowercase().contains("prod"),
            |environment| environment.production,
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(name: &str, production: bool) -> ProjectEnvironment {
        ProjectEnvironment {
            name: name.into(),
            production,
        }
    }

    #[test]
    fn environment_lists_are_bounded_and_unique() {
        assert!(valid_project_environments(&[
            env("dev", false),
            env("live", true)
        ]));
        assert!(valid_project_environments(&[]));
        assert!(!valid_project_environments(&[
            env("dev", false),
            env("DEV", false)
        ]));
        assert!(!valid_project_environments(&[env(" dev", false)]));
        let many = (0..=PROJECT_ENVIRONMENTS_MAX)
            .map(|index| env(&format!("env-{index}"), false))
            .collect::<Vec<_>>();
        assert!(!valid_project_environments(&many));
    }

    #[test]
    fn the_list_decides_production_and_the_name_is_the_fallback() {
        let list = [env("live", true), env("preprod", false)];
        assert!(environment_is_production(&list, "Live"));
        assert!(!environment_is_production(&list, "preprod"));
        assert!(environment_is_production(&list, "production"));
        assert!(!environment_is_production(&[], "staging"));
        assert!(environment_is_production(&[], "prod-eu"));
    }
}
