//! Bounded, portable transfer of a catalog skill and all its regular files.

use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::Path,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use cap_std::fs::{Dir, OpenOptions};
use serde::{Deserialize, Serialize};

use super::{
    SkillCatalog, SkillCatalogScope, SkillManager, SkillManagerError, host_home_directory,
    locate_skill, valid_skill_directory_name,
};

const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_FILES: usize = 1024;
const MAX_ENTRIES: usize = 2048;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillPackageFile {
    pub path: String,
    pub content_base64: String,
    pub executable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackage {
    pub name: String,
    pub files: Vec<SkillPackageFile>,
}

impl SkillManager {
    pub fn read_package(
        &self,
        scope: SkillCatalogScope,
        skill_id: &str,
    ) -> Result<SkillPackage, SkillManagerError> {
        let home = host_home_directory().ok_or(SkillManagerError::Unavailable)?;
        self.read_package_at(&home, scope, skill_id)
    }

    fn read_package_at(
        &self,
        home: &Path,
        scope: SkillCatalogScope,
        skill_id: &str,
    ) -> Result<SkillPackage, SkillManagerError> {
        let catalog = self.catalog_at(home, scope)?;
        let skill = locate_skill(&catalog, skill_id)?;
        if !skill.manageable {
            return Err(SkillManagerError::SkillNotManageable);
        }
        let root = Dir::open_ambient_dir(&skill.canonical_path, cap_std::ambient_authority())?;
        let mut files = Vec::new();
        let mut bytes = 0;
        let mut entries = 0;
        collect_files(&root, "", &mut files, &mut bytes, &mut entries)?;
        files.sort_by(|left, right| left.path.cmp(&right.path));
        validate_files(&files)?;
        Ok(SkillPackage {
            name: skill.name.clone(),
            files,
        })
    }

    pub fn create_user_package(
        &self,
        directory_name: &str,
        files: &[SkillPackageFile],
    ) -> Result<SkillCatalog, SkillManagerError> {
        let home = host_home_directory().ok_or(SkillManagerError::Unavailable)?;
        self.create_user_package_at(&home, directory_name, files)
    }

    fn create_user_package_at(
        &self,
        home: &Path,
        directory_name: &str,
        files: &[SkillPackageFile],
    ) -> Result<SkillCatalog, SkillManagerError> {
        if !valid_skill_directory_name(directory_name) {
            return Err(SkillManagerError::InvalidDirectoryName);
        }
        // Validate the entire package before creating anything on disk.
        let decoded = validate_files(files)?;
        let parent = home.join(".agents/skills");
        std::fs::create_dir_all(&parent)?;
        let directory = parent.join(directory_name);
        match std::fs::create_dir(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(SkillManagerError::SkillAlreadyExists);
            }
            Err(error) => return Err(error.into()),
        }
        let write = || -> Result<(), SkillManagerError> {
            crate::ensure_private_directory(&directory)?;
            // Publish SKILL.md last: discovery never advertises a partial copy.
            for (file, bytes) in files
                .iter()
                .zip(&decoded)
                .filter(|(f, _)| f.path != "SKILL.md")
            {
                let mut folder = directory.clone();
                for part in file.path.split('/').take(file.path.split('/').count() - 1) {
                    folder.push(part);
                    crate::ensure_private_directory(&folder)?;
                }
                let path = directory.join(&file.path);
                crate::create_private_file(&path, bytes)?;
                set_executable(&path, file.executable)?;
            }
            let index = files
                .iter()
                .position(|file| file.path == "SKILL.md")
                .unwrap();
            let definition = directory.join("SKILL.md");
            crate::atomic_replace_private_file(&definition, &decoded[index])?;
            set_executable(&definition, files[index].executable)?;
            Ok(())
        };
        if let Err(error) = write() {
            let _ = std::fs::remove_dir_all(&directory);
            return Err(error);
        }
        self.catalog_at(home, SkillCatalogScope::global())
    }
}

fn validate_path(path: &str) -> Result<(), SkillManagerError> {
    if path.is_empty() || path.len() > 512 || path.split('/').count() > 32 {
        return Err(SkillManagerError::InvalidPackage);
    }
    for part in path.split('/') {
        // Windows device names, separators, alternate streams, and trailing
        // dots/spaces must never alias a different destination on another OS.
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.len() == 4
                && matches!(stem.as_bytes()[3], b'1'..=b'9'));
        if part.is_empty()
            || matches!(part, "." | "..")
            || part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c.is_control() || "\\:<>\"|?*".contains(c))
            || device
        {
            return Err(SkillManagerError::InvalidPackage);
        }
    }
    Ok(())
}

fn validate_files(files: &[SkillPackageFile]) -> Result<Vec<Vec<u8>>, SkillManagerError> {
    if files.is_empty() || files.len() > MAX_FILES {
        return Err(SkillManagerError::PackageTooLarge);
    }
    let mut names = BTreeSet::new();
    let mut folders = BTreeMap::new();
    let mut decoded = Vec::with_capacity(files.len());
    let mut total = 0;
    let mut definition = false;
    for file in files {
        validate_path(&file.path)?;
        let key = file.path.to_lowercase();
        if !names.insert(key.clone()) || folders.contains_key(&key) {
            return Err(SkillManagerError::InvalidPackage);
        }
        let mut prefix = String::new();
        for part in file.path.split('/').take(file.path.split('/').count() - 1) {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            let folder_key = prefix.to_lowercase();
            if names.contains(&folder_key) {
                return Err(SkillManagerError::InvalidPackage);
            }
            if folders
                .insert(folder_key, prefix.clone())
                .is_some_and(|previous| previous != prefix)
            {
                return Err(SkillManagerError::InvalidPackage);
            }
        }
        if folders.len() + names.len() > MAX_ENTRIES {
            return Err(SkillManagerError::PackageTooLarge);
        }
        if file.content_base64.len() > (MAX_BYTES - total).div_ceil(3) * 4 {
            return Err(SkillManagerError::PackageTooLarge);
        }
        let bytes = STANDARD
            .decode(&file.content_base64)
            .map_err(|_| SkillManagerError::InvalidPackage)?;
        total += bytes.len();
        if total > MAX_BYTES {
            return Err(SkillManagerError::PackageTooLarge);
        }
        if file.path == "SKILL.md" {
            if bytes.is_empty() || bytes.len() > 262144 || std::str::from_utf8(&bytes).is_err() {
                return Err(SkillManagerError::InvalidPackage);
            }
            definition = true;
        }
        decoded.push(bytes);
    }
    if !definition {
        return Err(SkillManagerError::InvalidPackage);
    }
    Ok(decoded)
}

fn collect_files(
    root: &Dir,
    prefix: &str,
    files: &mut Vec<SkillPackageFile>,
    total: &mut usize,
    entries: &mut usize,
) -> Result<(), SkillManagerError> {
    for entry in root.read_dir(if prefix.is_empty() { "." } else { prefix })? {
        let entry = entry?;
        *entries += 1;
        if *entries > MAX_ENTRIES {
            return Err(SkillManagerError::PackageTooLarge);
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| SkillManagerError::InvalidPackage)?;
        let path = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        validate_path(&path)?;
        let kind = root.symlink_metadata(&path)?.file_type();
        if kind.is_dir() {
            collect_files(root, &path, files, total, entries)?;
        } else if kind.is_file() {
            if files.len() == MAX_FILES {
                return Err(SkillManagerError::PackageTooLarge);
            }
            let mut options = OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use cap_std::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
            }
            let file = root.open_with(&path, &options)?;
            let metadata = file.metadata()?;
            if !metadata.is_file() {
                return Err(SkillManagerError::InvalidPackage);
            }
            if metadata.len() > (MAX_BYTES - *total) as u64 {
                return Err(SkillManagerError::PackageTooLarge);
            }
            let mut bytes = Vec::new();
            file.take((MAX_BYTES - *total + 1) as u64)
                .read_to_end(&mut bytes)?;
            *total += bytes.len();
            if *total > MAX_BYTES {
                return Err(SkillManagerError::PackageTooLarge);
            }
            #[cfg(unix)]
            let executable = {
                use cap_std::fs::PermissionsExt;
                metadata.permissions().mode() & 0o111 != 0
            };
            #[cfg(not(unix))]
            let executable = false;
            files.push(SkillPackageFile {
                path,
                content_base64: STANDARD.encode(bytes),
                executable,
            });
        } else {
            // Never silently omit resources or follow links outside the skill.
            return Err(SkillManagerError::InvalidPackage);
        }
    }
    Ok(())
}

fn set_executable(path: &Path, executable: bool) -> Result<(), SkillManagerError> {
    #[cfg(unix)]
    if executable {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    let _ = (path, executable);
    Ok(())
}

#[cfg(test)]
mod tests;
