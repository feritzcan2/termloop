//! Removal of folder copies that an agent reads but Skills Manager did not
//! deploy, so the catalog can take back what it shows as installed.

use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use super::{SkillAgent, SkillCatalogItem, SkillManagerError, SkillOrigin};

/// Removes every folder copy through which `agent` reads `skill`. A link is
/// unlinked; a real folder moves into its parent's `.trash`, which discovery
/// skips, so its files stay recoverable. A real folder that another agent
/// still reads through a link is kept, since removing it would leave that
/// link dangling, and provider-owned copies are never touched.
pub(super) fn remove_folder_copies(
    skill: &SkillCatalogItem,
    agent: SkillAgent,
) -> Result<(), SkillManagerError> {
    let (own, others): (Vec<_>, Vec<_>) = skill
        .locations
        .iter()
        .filter(|location| location.origin != SkillOrigin::Managed)
        .partition(|location| location.agents.contains(&agent));
    if own.is_empty()
        || own
            .iter()
            .any(|location| matches!(location.origin, SkillOrigin::BuiltIn | SkillOrigin::Plugin))
    {
        return Err(SkillManagerError::SkillNotManageable);
    }
    let mut links = Vec::new();
    let mut folders = Vec::new();
    for location in own {
        let path = Path::new(&location.path);
        if fs::symlink_metadata(path)?.file_type().is_symlink() {
            links.push(path);
        } else {
            folders.push(path);
        }
    }
    if !folders.is_empty() && !others.is_empty() {
        return Err(SkillManagerError::SkillStillLinked);
    }
    for link in links {
        remove_link(link)?;
    }
    for folder in folders {
        move_to_trash(folder)?;
    }
    Ok(())
}

fn remove_link(link: &Path) -> Result<(), SkillManagerError> {
    #[cfg(unix)]
    fs::remove_file(link)?;
    // A Windows directory link is removed as a directory, never followed.
    #[cfg(windows)]
    fs::remove_dir(link)?;
    Ok(())
}

fn move_to_trash(folder: &Path) -> Result<(), SkillManagerError> {
    let (Some(parent), Some(name)) = (folder.parent(), folder.file_name()) else {
        return Err(SkillManagerError::SkillNotManageable);
    };
    let trash = parent.join(".trash");
    crate::ensure_private_directory(&trash)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis());
    let mut target = trash.join(format!("{stamp}-"));
    target.as_mut_os_string().push(name);
    // Same-directory rename stays on one volume and never overwrites.
    if target.exists() {
        return Err(SkillManagerError::SkillAlreadyExists);
    }
    fs::rename(folder, target)?;
    Ok(())
}

#[cfg(test)]
mod tests;
