use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::{
    ManagerBackend, ManagerSkill, SkillAgent, SkillAgentState, SkillAvailability, SkillCatalog,
    SkillCatalogItem, SkillCatalogLocation, SkillCatalogScope, SkillManagerError, SkillOrigin,
    SkillScope,
};

const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SKILLS: usize = 500;
const MAX_PLUGIN_INSTALLATIONS: usize = 250;
const MAX_WARNINGS: usize = 8;
const MAX_UNREADABLE_NAMED: usize = 3;

#[derive(Debug, Clone)]
struct SkillSource {
    scope: SkillScope,
    origin: SkillOrigin,
    agents: Vec<SkillAgent>,
    source: String,
    availability: SkillAvailability,
    manageable: bool,
}

#[derive(Debug)]
struct DiscoveredSkill {
    canonical_path: PathBuf,
    name: String,
    description: String,
    locations: Vec<SkillCatalogLocation>,
    manageable: bool,
    manager_skill_id: Option<String>,
    managed_agents: HashSet<SkillAgent>,
}

/// A bundle the scan walked past, kept so the catalog can say which one and
/// why instead of only how many.
#[derive(Debug)]
struct UnreadableBundle {
    label: String,
    reason: String,
}

#[derive(Default)]
struct DiscoveryState {
    skills: HashMap<String, DiscoveredSkill>,
    warnings: Vec<String>,
    unreadable: Vec<UnreadableBundle>,
    unreadable_count: usize,
    limit_reached: bool,
    provider_snapshot_included: bool,
}

pub(super) fn discover_catalog(
    home: &Path,
    scope: &SkillCatalogScope,
    backend: Option<&dyn ManagerBackend>,
    require_manager: bool,
) -> Result<SkillCatalog, SkillManagerError> {
    let mut state = DiscoveryState::default();
    scan_standard_roots(&mut state, home, SkillScope::User, "User");
    if let Some(project) = &scope.project_directory {
        scan_standard_roots(&mut state, project, SkillScope::Project, "Project");
    }
    scan_claude_plugin_registry(&mut state, home, scope);
    scan_codex_plugin_cache(&mut state, home);

    let (manager_available, manager_skills) = match backend {
        Some(backend) => match backend.list() {
            Ok(skills) => (true, skills),
            Err(error) if require_manager => return Err(error),
            Err(_) => {
                warn(
                    &mut state,
                    "Skills Manager could not be read; managed deployment actions are unavailable.",
                );
                (false, Vec::new())
            }
        },
        None => {
            warn(
                &mut state,
                "Skills Manager is not bundled with this build; the catalog is read-only.",
            );
            (false, Vec::new())
        }
    };
    merge_manager_skills(&mut state, manager_skills);

    if state.unreadable_count > 0 {
        let message = unreadable_warning(&state);
        warn(&mut state, &message);
    }
    if state.limit_reached {
        warn(
            &mut state,
            &format!("Skill discovery stopped at the {MAX_SKILLS}-bundle safety limit."),
        );
    }

    let mut skills = state
        .skills
        .into_values()
        .filter_map(public_skill)
        .collect::<Vec<_>>();
    skills.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(SkillCatalog {
        skills,
        warnings: state.warnings,
        project_included: scope.project_directory.is_some(),
        project_name: scope.project_name.clone(),
        provider_snapshot_included: state.provider_snapshot_included,
        manager_available,
    })
}

/// Names the bundles the scan could not read, with the reason the OS gave, so
/// an evicted or unpermitted file is distinguishable from a malformed one.
fn unreadable_warning(state: &DiscoveryState) -> String {
    let count = state.unreadable_count;
    let suffix = if count == 1 { "bundle" } else { "bundles" };
    let listed = state
        .unreadable
        .iter()
        .map(|bundle| format!("{} ({})", bundle.label, bundle.reason))
        .collect::<Vec<_>>()
        .join(", ");
    let remainder = count - state.unreadable.len();
    let tail = if remainder > 0 {
        format!(", and {remainder} more")
    } else {
        String::new()
    };
    format!("{count} skill {suffix} could not be read: {listed}{tail}.")
}

fn record_unreadable(state: &mut DiscoveryState, path: &Path, reason: impl ToString) {
    state.unreadable_count += 1;
    if state.unreadable.len() < MAX_UNREADABLE_NAMED {
        let label = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());
        state.unreadable.push(UnreadableBundle {
            label,
            reason: reason.to_string(),
        });
    }
}

fn scan_standard_roots(state: &mut DiscoveryState, owner: &Path, scope: SkillScope, prefix: &str) {
    scan_skill_parent(
        state,
        &owner.join(".agents/skills"),
        SkillSource {
            scope,
            origin: SkillOrigin::Shared,
            agents: vec![SkillAgent::Claude, SkillAgent::Codex],
            source: format!("{prefix} shared skills"),
            availability: SkillAvailability::Folder,
            manageable: true,
        },
    );
    scan_skill_parent(
        state,
        &owner.join(".claude/skills"),
        SkillSource {
            scope,
            origin: SkillOrigin::Personal,
            agents: vec![SkillAgent::Claude],
            source: format!("{prefix} Claude skills"),
            availability: SkillAvailability::Folder,
            manageable: true,
        },
    );
    let codex = owner.join(".codex/skills");
    scan_skill_parent(
        state,
        &codex,
        SkillSource {
            scope,
            origin: SkillOrigin::Personal,
            agents: vec![SkillAgent::Codex],
            source: format!("{prefix} Codex skills"),
            availability: SkillAvailability::Folder,
            manageable: true,
        },
    );
    scan_skill_parent(
        state,
        &codex.join(".system"),
        SkillSource {
            scope,
            origin: SkillOrigin::BuiltIn,
            agents: vec![SkillAgent::Codex],
            source: format!("{prefix} Codex built-in skills"),
            availability: SkillAvailability::Folder,
            manageable: false,
        },
    );
}

fn scan_claude_plugin_registry(state: &mut DiscoveryState, home: &Path, scope: &SkillCatalogScope) {
    let plugins = home.join(".claude/plugins");
    let manifest = match bounded_text(&plugins.join("installed_plugins.json"), MAX_MANIFEST_BYTES) {
        Ok(Some(value)) => value,
        Ok(None) => return,
        Err(_) => {
            warn(
                state,
                "Claude's installed plugin registry could not be read.",
            );
            return;
        }
    };
    let Ok(document) = serde_json::from_str::<serde_json::Value>(&manifest) else {
        warn(
            state,
            "Claude's installed plugin registry is not valid JSON.",
        );
        return;
    };
    let Some(registry) = document
        .get("plugins")
        .and_then(serde_json::Value::as_object)
    else {
        warn(
            state,
            "Claude's installed plugin registry has an unsupported shape.",
        );
        return;
    };
    let mut installations = 0;
    for (plugin_id, entries) in registry {
        let Some(entries) = entries.as_array() else {
            continue;
        };
        for entry in entries {
            if installations >= MAX_PLUGIN_INSTALLATIONS {
                warn(
                    state,
                    &format!(
                        "Claude plugin discovery stopped at the {MAX_PLUGIN_INSTALLATIONS}-installation safety limit."
                    ),
                );
                return;
            }
            installations += 1;
            let Some(installation_path) =
                entry.get("installPath").and_then(serde_json::Value::as_str)
            else {
                continue;
            };
            let installation_path = PathBuf::from(installation_path);
            if !path_is_within(&plugins, &installation_path) {
                warn(
                    state,
                    "A Claude plugin outside the provider plugin directory was ignored.",
                );
                continue;
            }
            let Some(skill_scope) = claude_plugin_scope(entry, scope) else {
                continue;
            };
            state.provider_snapshot_included = true;
            scan_plugin_installation(
                state,
                &installation_path,
                SkillSource {
                    scope: skill_scope,
                    origin: SkillOrigin::Plugin,
                    agents: vec![SkillAgent::Claude],
                    source: clean_source(&format!("Claude plugin · {plugin_id}")),
                    availability: SkillAvailability::Configured,
                    manageable: true,
                },
            );
        }
    }
}

fn scan_codex_plugin_cache(state: &mut DiscoveryState, home: &Path) {
    let cache = home.join(".codex/plugins/cache");
    let mut plugin_count = 0;
    for marketplace in directory_entries(&cache, state) {
        let marketplace_name = marketplace.file_name();
        let Some(marketplace_name) = marketplace_name.to_str() else {
            continue;
        };
        if marketplace_name.starts_with('.') || !directory_entry_is_directory(&marketplace) {
            continue;
        }
        for plugin in directory_entries(&marketplace.path(), state) {
            let plugin_name = plugin.file_name();
            let Some(plugin_name) = plugin_name.to_str() else {
                continue;
            };
            if plugin_name.starts_with('.') || !directory_entry_is_directory(&plugin) {
                continue;
            }
            if plugin_count >= MAX_PLUGIN_INSTALLATIONS {
                warn(
                    state,
                    &format!(
                        "Codex plugin discovery stopped at the {MAX_PLUGIN_INSTALLATIONS}-plugin safety limit."
                    ),
                );
                return;
            }
            plugin_count += 1;
            let Some(installation) = newest_child_directory(&plugin.path()) else {
                continue;
            };
            state.provider_snapshot_included = true;
            scan_plugin_installation(
                state,
                &installation,
                SkillSource {
                    scope: SkillScope::User,
                    origin: SkillOrigin::Plugin,
                    agents: vec![SkillAgent::Codex],
                    source: clean_source(&format!(
                        "Codex plugin cache · {plugin_name}@{marketplace_name}"
                    )),
                    availability: SkillAvailability::CacheSnapshot,
                    manageable: true,
                },
            );
        }
    }
}

fn scan_plugin_installation(state: &mut DiscoveryState, directory: &Path, source: SkillSource) {
    scan_skill_directory(state, directory, &source);
    for relative in ["skills", ".claude/skills", ".agents/skills"] {
        scan_skill_parent(state, &directory.join(relative), source.clone());
    }
}

fn scan_skill_parent(state: &mut DiscoveryState, directory: &Path, source: SkillSource) {
    if state.limit_reached {
        return;
    }
    for entry in directory_entries(directory, state) {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.starts_with('.') || !directory_entry_is_directory(&entry) {
            continue;
        }
        scan_skill_directory(state, &entry.path(), &source);
        if state.limit_reached {
            return;
        }
    }
}

fn scan_skill_directory(state: &mut DiscoveryState, directory: &Path, source: &SkillSource) {
    if state.limit_reached {
        return;
    }
    let body = match read_text(&directory.join("SKILL.md")) {
        Ok(Some(body)) => body,
        Ok(None) => return,
        Err(error) => {
            record_unreadable(state, directory, error);
            return;
        }
    };
    let canonical_path = match directory.canonicalize() {
        Ok(path) => path,
        Err(error) => {
            record_unreadable(state, directory, error);
            return;
        }
    };
    if canonical_path.to_str().is_none() {
        record_unreadable(state, directory, "path is not UTF-8");
        return;
    }
    let identity = comparable_path(&canonical_path);
    if !state.skills.contains_key(&identity) {
        if state.skills.len() >= MAX_SKILLS {
            state.limit_reached = true;
            return;
        }
        let fallback = directory
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Unnamed skill");
        let (name, description) = skill_metadata(&body, fallback);
        state.skills.insert(
            identity.clone(),
            DiscoveredSkill {
                canonical_path: canonical_path.clone(),
                name,
                description,
                locations: Vec::new(),
                manageable: false,
                manager_skill_id: None,
                managed_agents: HashSet::new(),
            },
        );
    }
    let leaf_is_symlink = fs::symlink_metadata(directory)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(true);
    let location = SkillCatalogLocation {
        path: directory.to_string_lossy().into_owned(),
        scope: source.scope,
        origin: source.origin,
        agents: source.agents.clone(),
        source: source.source.clone(),
        availability: source.availability,
    };
    let skill = state.skills.get_mut(&identity).expect("skill was inserted");
    if !skill.locations.contains(&location) && skill.locations.len() < 24 {
        skill.locations.push(location);
    }
    skill.manageable |= source.manageable && !leaf_is_symlink;
}

fn merge_manager_skills(state: &mut DiscoveryState, manager_skills: Vec<ManagerSkill>) {
    for manager in manager_skills {
        let central = PathBuf::from(&manager.path);
        let Ok(central_canonical) = central.canonicalize() else {
            continue;
        };
        if central_canonical.to_str().is_none() {
            continue;
        }
        let central_key = comparable_path(&central_canonical);
        let source_key = manager
            .source_ref
            .as_deref()
            .map(PathBuf::from)
            .and_then(|path| path.canonicalize().ok())
            .map(|path| comparable_path(&path));
        let primary_key = source_key
            .as_ref()
            .filter(|key| state.skills.contains_key(*key))
            .cloned()
            .or_else(|| {
                state
                    .skills
                    .contains_key(&central_key)
                    .then(|| central_key.clone())
            })
            .unwrap_or_else(|| central_key.clone());

        if primary_key != central_key
            && let Some(secondary) = state.skills.remove(&central_key)
        {
            if let Some(primary) = state.skills.get_mut(&primary_key) {
                merge_discovered(primary, secondary);
            } else {
                state.skills.insert(primary_key.clone(), secondary);
            }
        }
        let skill = state
            .skills
            .entry(primary_key)
            .or_insert_with(|| DiscoveredSkill {
                canonical_path: central_canonical.clone(),
                name: clean_name(&manager.name),
                description: clean_description(manager.description.as_deref()),
                locations: Vec::new(),
                manageable: true,
                manager_skill_id: None,
                managed_agents: HashSet::new(),
            });
        skill.manager_skill_id = Some(manager.id);
        skill.manageable = true;
        skill.managed_agents.extend(
            manager
                .deployed_to
                .iter()
                .filter_map(|key| SkillAgent::from_manager_key(key)),
        );
        let managed_location = SkillCatalogLocation {
            path: central.to_string_lossy().into_owned(),
            scope: SkillScope::User,
            origin: SkillOrigin::Managed,
            agents: manager
                .deployed_to
                .iter()
                .filter_map(|key| SkillAgent::from_manager_key(key))
                .collect(),
            source: "Skills Manager library".into(),
            availability: SkillAvailability::ManagedLibrary,
        };
        if !skill.locations.contains(&managed_location) && skill.locations.len() < 24 {
            skill.locations.push(managed_location);
        }
    }
}

fn merge_discovered(primary: &mut DiscoveredSkill, secondary: DiscoveredSkill) {
    for location in secondary.locations {
        if !primary.locations.contains(&location) && primary.locations.len() < 24 {
            primary.locations.push(location);
        }
    }
    primary.manageable |= secondary.manageable;
    if primary.manager_skill_id.is_none() {
        primary.manager_skill_id = secondary.manager_skill_id;
    }
    primary.managed_agents.extend(secondary.managed_agents);
}

fn public_skill(mut skill: DiscoveredSkill) -> Option<SkillCatalogItem> {
    let canonical = skill.canonical_path.to_str()?;
    skill
        .locations
        .sort_by(|left, right| left.path.cmp(&right.path));
    let present_agents = ordered_agents(
        skill
            .locations
            .iter()
            .flat_map(|location| location.agents.iter().copied())
            .chain(skill.managed_agents.iter().copied()),
    );
    let scopes = ordered_scopes(skill.locations.iter().map(|location| location.scope));
    let origins = ordered_origins(skill.locations.iter().map(|location| location.origin));
    let agent_states = [SkillAgent::Claude, SkillAgent::Codex]
        .into_iter()
        .map(|agent| SkillAgentState {
            agent,
            present: present_agents.contains(&agent),
            managed: skill.managed_agents.contains(&agent),
            target_path: None,
        })
        .collect();
    Some(SkillCatalogItem {
        id: opaque_skill_id(canonical),
        name: skill.name,
        description: skill.description,
        agents: present_agents,
        scopes,
        origins,
        locations: skill.locations,
        agent_states,
        manageable: skill.manageable,
        canonical_path: skill.canonical_path,
        manager_skill_id: skill.manager_skill_id,
    })
}

/// A skill definition is the user's own file, so its size is not a reason to
/// drop it from the catalog; only its kind is checked.
pub(super) fn read_text(path: &Path) -> Result<Option<String>, std::io::Error> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "skill definition is not a regular file",
        ));
    }
    fs::read_to_string(path).map(Some)
}

pub(super) fn bounded_text(
    path: &Path,
    maximum_bytes: u64,
) -> Result<Option<String>, std::io::Error> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() || metadata.len() > maximum_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "bounded metadata file was refused",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)?
        .take(maximum_bytes + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "bounded metadata file was refused",
        ));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "metadata is not UTF-8"))
}

fn directory_entries(directory: &Path, state: &mut DiscoveryState) -> Vec<fs::DirEntry> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            record_unreadable(state, directory, error);
            return Vec::new();
        }
    };
    let mut entries = entries.filter_map(Result::ok).collect::<Vec<_>>();
    entries.sort_by_key(fs::DirEntry::file_name);
    entries
}

fn directory_entry_is_directory(entry: &fs::DirEntry) -> bool {
    entry
        .file_type()
        .map(|kind| kind.is_dir() || kind.is_symlink())
        .unwrap_or(false)
}

fn newest_child_directory(directory: &Path) -> Option<PathBuf> {
    let mut candidates = fs::read_dir(directory)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| !name.starts_with('.'))
                && directory_entry_is_directory(entry)
        })
        .filter_map(|entry| {
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, entry.path()))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
    candidates.into_iter().next().map(|(_, path)| path)
}

fn claude_plugin_scope(
    installation: &serde_json::Value,
    scope: &SkillCatalogScope,
) -> Option<SkillScope> {
    match installation
        .get("scope")
        .and_then(serde_json::Value::as_str)
    {
        Some("user") => Some(SkillScope::User),
        Some("project" | "local") => {
            let configured = installation
                .get("projectPath")
                .and_then(serde_json::Value::as_str)?;
            let project = scope.project_directory.as_ref()?;
            paths_equal(Path::new(configured), project).then_some(SkillScope::Project)
        }
        _ => None,
    }
}

fn skill_metadata(body: &str, fallback_name: &str) -> (String, String) {
    let body = body.strip_prefix('\u{feff}').unwrap_or(body);
    let lines = body.lines().collect::<Vec<_>>();
    if lines.first().is_none_or(|line| line.trim() != "---") {
        return (
            clean_name(fallback_name),
            "No description in SKILL.md.".into(),
        );
    }
    let Some(end) = lines
        .iter()
        .enumerate()
        .skip(1)
        .find_map(|(index, line)| (line.trim() == "---").then_some(index))
    else {
        return (
            clean_name(fallback_name),
            "No description in SKILL.md.".into(),
        );
    };
    let mut name = None;
    let mut description = None;
    let mut index = 1;
    while index < end {
        let line = lines[index];
        let Some((key, raw)) = line.split_once(':') else {
            index += 1;
            continue;
        };
        if !key
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'_' | b'-'))
            || !matches!(key, "name" | "description")
        {
            index += 1;
            continue;
        }
        let raw = raw.trim();
        let value = if matches!(raw, ">" | ">-" | ">+" | "|" | "|-" | "|+") {
            let folded = raw.starts_with('>');
            let mut values = Vec::new();
            while index + 1 < end {
                let next = lines[index + 1];
                if next.split_once(':').is_some_and(|(candidate, _)| {
                    candidate
                        .bytes()
                        .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'_' | b'-'))
                }) {
                    break;
                }
                index += 1;
                values.push(lines[index].trim());
            }
            values
                .join(if folded { " " } else { "\n" })
                .trim()
                .to_owned()
        } else {
            yaml_scalar(raw)
        };
        match key {
            "name" => name = Some(value),
            "description" => description = Some(value),
            _ => {}
        }
        index += 1;
    }
    (
        clean_name(name.as_deref().unwrap_or(fallback_name)),
        clean_description(description.as_deref()),
    )
}

fn yaml_scalar(value: &str) -> String {
    let value = value.trim();
    if value.starts_with('"') && value.ends_with('"') {
        return serde_json::from_str::<String>(value)
            .unwrap_or_else(|_| value[1..value.len().saturating_sub(1)].to_owned());
    }
    if value.starts_with('\'') && value.ends_with('\'') {
        return value[1..value.len().saturating_sub(1)].replace("''", "'");
    }
    value.to_owned()
}

fn clean_name(value: &str) -> String {
    let cleaned = value
        .chars()
        .map(|value| if value.is_control() { ' ' } else { value })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    truncate_chars(
        if cleaned.is_empty() {
            "Unnamed skill"
        } else {
            &cleaned
        },
        120,
    )
}

fn clean_description(value: Option<&str>) -> String {
    let cleaned = value
        .unwrap_or_default()
        .chars()
        .map(|value| {
            if value.is_control() && !matches!(value, '\n' | '\t') {
                ' '
            } else {
                value
            }
        })
        .collect::<String>()
        .trim()
        .to_owned();
    truncate_chars(
        if cleaned.is_empty() {
            "No description in SKILL.md."
        } else {
            &cleaned
        },
        1_200,
    )
}

fn clean_source(value: &str) -> String {
    truncate_chars(
        &value
            .chars()
            .filter(|value| !value.is_control())
            .collect::<String>(),
        240,
    )
}

fn truncate_chars(value: &str, maximum: usize) -> String {
    value.chars().take(maximum).collect()
}

fn path_is_within(parent: &Path, candidate: &Path) -> bool {
    let Ok(parent) = parent.canonicalize() else {
        return false;
    };
    let Ok(candidate) = candidate.canonicalize() else {
        return false;
    };
    candidate.starts_with(parent)
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => comparable_path(&left) == comparable_path(&right),
        _ => false,
    }
}

fn comparable_path(path: &Path) -> String {
    let value = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        value.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        value
    }
}

fn opaque_skill_id(canonical_path: &str) -> String {
    let digest = Sha256::digest(canonical_path.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn ordered_agents(values: impl IntoIterator<Item = SkillAgent>) -> Vec<SkillAgent> {
    let values = values.into_iter().collect::<HashSet<_>>();
    [SkillAgent::Claude, SkillAgent::Codex]
        .into_iter()
        .filter(|value| values.contains(value))
        .collect()
}

fn ordered_scopes(values: impl IntoIterator<Item = SkillScope>) -> Vec<SkillScope> {
    let values = values.into_iter().collect::<HashSet<_>>();
    [SkillScope::User, SkillScope::Project]
        .into_iter()
        .filter(|value| values.contains(value))
        .collect()
}

fn ordered_origins(values: impl IntoIterator<Item = SkillOrigin>) -> Vec<SkillOrigin> {
    let values = values.into_iter().collect::<HashSet<_>>();
    [
        SkillOrigin::Shared,
        SkillOrigin::Personal,
        SkillOrigin::BuiltIn,
        SkillOrigin::Plugin,
        SkillOrigin::Managed,
    ]
    .into_iter()
    .filter(|value| values.contains(value))
    .collect()
}

fn warn(state: &mut DiscoveryState, warning: &str) {
    if state.warnings.len() < MAX_WARNINGS
        && !state.warnings.iter().any(|current| current == warning)
    {
        state.warnings.push(truncate_chars(warning, 400));
    }
}

pub(super) fn host_home_directory() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE")
            .or_else(|| {
                let drive = std::env::var_os("HOMEDRIVE")?;
                let path = std::env::var_os("HOMEPATH")?;
                let mut value = drive;
                value.push(path);
                Some(value)
            })
            .map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}
