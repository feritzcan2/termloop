use std::fs;

use crate::skill_manager::tests::{temporary_directory, write_skill};
use crate::skill_manager::{SkillAgent, SkillCatalogScope, SkillManager, SkillManagerError};

fn remove(
    manager: &SkillManager,
    home: &std::path::Path,
    agent: SkillAgent,
) -> Result<Vec<SkillAgent>, SkillManagerError> {
    let catalog = manager.catalog_at(home, SkillCatalogScope::global())?;
    let catalog = manager.set_deployment_at(
        home,
        SkillCatalogScope::global(),
        &catalog.skills[0].id,
        agent,
        false,
    )?;
    Ok(catalog
        .skills
        .first()
        .map(|skill| skill.agents.clone())
        .unwrap_or_default())
}

#[cfg(unix)]
#[test]
fn removing_a_linked_agent_unlinks_without_touching_the_shared_folder() {
    let root = temporary_directory("skill-remove-link");
    let shared = root.join(".agents/skills/example");
    write_skill(&shared, "example", "Test.");
    fs::create_dir_all(root.join(".claude/skills")).unwrap();
    std::os::unix::fs::symlink(
        "../../.agents/skills/example",
        root.join(".claude/skills/example"),
    )
    .unwrap();
    let manager = SkillManager { backend: None };

    assert!(matches!(
        remove(&manager, &root, SkillAgent::Codex),
        Err(SkillManagerError::SkillStillLinked)
    ));
    assert!(shared.join("SKILL.md").is_file());

    assert_eq!(
        remove(&manager, &root, SkillAgent::Claude).unwrap(),
        [SkillAgent::Codex]
    );
    assert!(fs::symlink_metadata(root.join(".claude/skills/example")).is_err());
    assert!(shared.join("SKILL.md").is_file());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn removing_a_real_folder_moves_it_to_a_hidden_trash() {
    let root = temporary_directory("skill-remove-folder");
    let folder = root.join(".claude/skills/example");
    write_skill(&folder, "example", "Test.");
    let manager = SkillManager { backend: None };

    assert!(
        remove(&manager, &root, SkillAgent::Claude)
            .unwrap()
            .is_empty()
    );
    assert!(!folder.exists());
    let trashed: Vec<_> = fs::read_dir(root.join(".claude/skills/.trash"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(trashed.len(), 1);
    assert!(trashed[0].to_string_lossy().ends_with("-example"));
    assert!(trashed[0].join("SKILL.md").is_file());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn provider_built_in_copies_are_never_removed() {
    let root = temporary_directory("skill-remove-built-in");
    let folder = root.join(".codex/skills/.system/internal");
    write_skill(&folder, "internal", "Provider-owned.");
    let manager = SkillManager { backend: None };

    assert!(matches!(
        remove(&manager, &root, SkillAgent::Codex),
        Err(SkillManagerError::SkillNotManageable)
    ));
    assert!(folder.join("SKILL.md").is_file());
    fs::remove_dir_all(root).unwrap();
}
