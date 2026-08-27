//! Bounded discovery and stale-guarded editing of Project agent instructions.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{PlatformError, atomic_replace_file_preserving_permissions};

const ROOT_LINE_LIMIT: usize = 200;
const NESTED_LINE_LIMIT: usize = 100;
const MAX_CONTENT_BYTES: usize = 512 * 1024;
const MAX_FILES: usize = 500;
const MAX_WARNINGS: usize = 16;
const MAX_ENTRIES: usize = 20_000;
const MAX_DEPTH: usize = 32;

const PRUNED_DIRECTORIES: &[&str] = &[
    ".git",
    ".build",
    ".svn",
    ".hg",
    "node_modules",
    "DerivedData",
    ".termloop-worktrees",
    "Pods",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    "dist",
    "build",
    "target",
    "zig-out",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ContextBankFileKind {
    Claude,
    Agents,
    Gemini,
}

impl ContextBankFileKind {
    fn from_name(name: &str) -> Option<Self> {
        match name {
            "CLAUDE.md" => Some(Self::Claude),
            "AGENTS.md" => Some(Self::Agents),
            "GEMINI.md" => Some(Self::Gemini),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBankCatalogItem {
    pub id: String,
    pub relative_path: String,
    pub kind: ContextBankFileKind,
    pub line_count: usize,
    pub line_limit: usize,
    pub over_limit: bool,
    pub is_symlink: bool,
    pub symlink_target_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBankSiblingConflict {
    pub id: String,
    pub directory_path: String,
    pub file_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBankCatalog {
    pub files: Vec<ContextBankCatalogItem>,
    pub sibling_conflicts: Vec<ContextBankSiblingConflict>,
    pub warnings: Vec<String>,
    pub project_name: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBankFile {
    pub file_id: String,
    pub relative_path: String,
    pub path: String,
    pub kind: ContextBankFileKind,
    pub content: String,
    pub content_sha256: String,
    pub line_count: usize,
    pub line_limit: usize,
    pub is_symlink: bool,
    pub symlink_target_path: Option<String>,
    pub editable: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum ContextBankError {
    #[error("the selected Context Bank file is no longer available")]
    FileNotFound,
    #[error(
        "the selected Context Bank file changed on disk since it was read; reload before saving"
    )]
    StaleFile,
    #[error("the selected Context Bank file is read only")]
    ReadOnly,
    #[error("Context Bank files are limited to 512 KiB")]
    ContentTooLarge,
    #[error("Context Bank can read only UTF-8 instruction files")]
    InvalidUtf8,
    #[error(
        "Context Bank could not restore every sibling after a failed reconciliation; inspect the affected folder before retrying"
    )]
    ConflictRollbackFailed,
    #[error(transparent)]
    Platform(#[from] PlatformError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone)]
struct ScannedFile {
    item: ContextBankCatalogItem,
    logical_path: PathBuf,
    canonical_path: PathBuf,
    content: String,
    content_sha256: String,
    editable: bool,
}

#[derive(Debug)]
struct Scan {
    files: Vec<ScannedFile>,
    warnings: Vec<String>,
    truncated: bool,
}

pub fn context_bank_catalog(
    project_root: &Path,
    project_name: &str,
) -> Result<ContextBankCatalog, ContextBankError> {
    Ok(catalog_from_scan(scan(project_root)?, project_name))
}

pub fn read_context_bank_file(
    project_root: &Path,
    file_id: &str,
) -> Result<ContextBankFile, ContextBankError> {
    let file = scan(project_root)?
        .files
        .into_iter()
        .find(|file| file.item.id == file_id)
        .ok_or(ContextBankError::FileNotFound)?;
    Ok(file_definition(file))
}

pub fn write_context_bank_file(
    project_root: &Path,
    file_id: &str,
    expected_content_sha256: &str,
    content: &str,
) -> Result<ContextBankFile, ContextBankError> {
    if content.len() > MAX_CONTENT_BYTES {
        return Err(ContextBankError::ContentTooLarge);
    }
    let mut file = scan(project_root)?
        .files
        .into_iter()
        .find(|file| file.item.id == file_id)
        .ok_or(ContextBankError::FileNotFound)?;
    if !file.editable {
        return Err(ContextBankError::ReadOnly);
    }
    if file.content_sha256 != expected_content_sha256 {
        return Err(ContextBankError::StaleFile);
    }
    let current = read_utf8_bounded(&file.canonical_path)?;
    if sha256_hex(&current) != expected_content_sha256 {
        return Err(ContextBankError::StaleFile);
    }
    atomic_replace_file_preserving_permissions(&file.canonical_path, content.as_bytes())?;
    file.content = content.to_owned();
    file.content_sha256 = sha256_hex(content);
    file.item.line_count = line_count(content);
    file.item.over_limit = file.item.line_count > file.item.line_limit;
    Ok(file_definition(file))
}

pub fn resolve_context_bank_sibling_conflict(
    project_root: &Path,
    project_name: &str,
    conflict_id: &str,
    source_file_id: &str,
) -> Result<ContextBankCatalog, ContextBankError> {
    let initial_scan = scan(project_root)?;
    let conflict = sibling_conflicts(&initial_scan.files)
        .into_iter()
        .find(|conflict| conflict.id == conflict_id)
        .ok_or(ContextBankError::StaleFile)?;
    if !conflict
        .file_ids
        .iter()
        .any(|file_id| file_id == source_file_id)
    {
        return Err(ContextBankError::FileNotFound);
    }

    let source = initial_scan
        .files
        .iter()
        .find(|file| file.item.id == source_file_id)
        .ok_or(ContextBankError::FileNotFound)?;
    let source_content = source.content.clone();
    let member_ids = conflict
        .file_ids
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let members = initial_scan
        .files
        .iter()
        .filter(|file| member_ids.contains(file.item.id.as_str()))
        .collect::<Vec<_>>();

    for file in &members {
        let current = read_utf8_bounded(&file.canonical_path)?;
        if sha256_hex(&current) != file.content_sha256 {
            return Err(ContextBankError::StaleFile);
        }
    }

    let mut replacements = BTreeMap::<PathBuf, String>::new();
    for file in members {
        if file.canonical_path == source.canonical_path || file.content == source_content {
            continue;
        }
        if !file.editable {
            return Err(ContextBankError::ReadOnly);
        }
        replacements
            .entry(file.canonical_path.clone())
            .or_insert_with(|| file.content.clone());
    }

    let mut written = Vec::<(PathBuf, String)>::new();
    for (path, original) in replacements {
        if let Err(error) =
            atomic_replace_file_preserving_permissions(&path, source_content.as_bytes())
        {
            let mut restored = true;
            for (written_path, written_original) in written.iter().rev() {
                if atomic_replace_file_preserving_permissions(
                    written_path,
                    written_original.as_bytes(),
                )
                .is_err()
                {
                    restored = false;
                }
            }
            return if restored {
                Err(ContextBankError::Platform(error))
            } else {
                Err(ContextBankError::ConflictRollbackFailed)
            };
        }
        written.push((path, original));
    }

    Ok(catalog_from_scan(scan(project_root)?, project_name))
}

fn catalog_from_scan(scan: Scan, project_name: &str) -> ContextBankCatalog {
    let sibling_conflicts = sibling_conflicts(&scan.files);
    ContextBankCatalog {
        files: scan.files.into_iter().map(|file| file.item).collect(),
        sibling_conflicts,
        warnings: scan.warnings,
        project_name: project_name.to_owned(),
        truncated: scan.truncated,
    }
}

fn scan(project_root: &Path) -> Result<Scan, ContextBankError> {
    let root = fs::canonicalize(project_root)?;
    if !fs::metadata(&root)?.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Context Bank project root is not a directory",
        )
        .into());
    }

    let mut directories = VecDeque::from([(root.clone(), 0usize)]);
    let mut files = Vec::new();
    let mut warnings = Vec::new();
    let mut observed_entries = 0usize;
    let mut truncated = false;

    while let Some((directory, depth)) = directories.pop_front() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                push_warning(
                    &mut warnings,
                    format!(
                        "Could not scan {}: {error}",
                        display_relative(&directory, &root)
                    ),
                );
                continue;
            }
        };
        let remaining_entries = MAX_ENTRIES.saturating_sub(observed_entries);
        let mut bounded_entries = Vec::new();
        for entry in entries {
            if bounded_entries.len() >= remaining_entries {
                truncated = true;
                break;
            }
            match entry {
                Ok(entry) => bounded_entries.push(entry),
                Err(error) => push_warning(
                    &mut warnings,
                    format!(
                        "Could not inspect an entry in {}: {error}",
                        display_relative(&directory, &root)
                    ),
                ),
            }
        }
        let mut entries = bounded_entries;
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            observed_entries = observed_entries.saturating_add(1);
            if observed_entries > MAX_ENTRIES || files.len() >= MAX_FILES {
                truncated = true;
                break;
            }
            let path = entry.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    push_warning(
                        &mut warnings,
                        format!(
                            "Could not inspect {}: {error}",
                            display_relative(&path, &root)
                        ),
                    );
                    continue;
                }
            };
            let name = match entry.file_name().to_str() {
                Some(name) => name.to_owned(),
                None => {
                    push_warning(&mut warnings, "Skipped a non-UTF-8 project path.".into());
                    continue;
                }
            };

            if metadata.is_dir() {
                if metadata.file_type().is_symlink()
                    || name.starts_with('.')
                    || PRUNED_DIRECTORIES.contains(&name.as_str())
                {
                    continue;
                }
                if depth >= MAX_DEPTH {
                    push_warning(
                        &mut warnings,
                        format!("Skipped folders deeper than {MAX_DEPTH} levels."),
                    );
                } else {
                    directories.push_back((path, depth + 1));
                }
                continue;
            }

            let Some(kind) = ContextBankFileKind::from_name(&name) else {
                continue;
            };
            if !metadata.is_file() && !metadata.file_type().is_symlink() {
                continue;
            }
            let canonical_path = match fs::canonicalize(&path) {
                Ok(canonical) if canonical.starts_with(&root) => canonical,
                Ok(_) => {
                    push_warning(
                        &mut warnings,
                        format!(
                            "Ignored {} because its symlink target is outside the Project.",
                            display_relative(&path, &root)
                        ),
                    );
                    continue;
                }
                Err(error) => {
                    push_warning(
                        &mut warnings,
                        format!(
                            "Could not resolve {}: {error}",
                            display_relative(&path, &root)
                        ),
                    );
                    continue;
                }
            };
            let target_metadata = match fs::metadata(&canonical_path) {
                Ok(metadata) if metadata.is_file() => metadata,
                _ => continue,
            };
            if metadata.file_type().is_symlink()
                && canonical_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .and_then(ContextBankFileKind::from_name)
                    .is_none()
            {
                push_warning(
                    &mut warnings,
                    format!(
                        "Ignored {} because it links to a non-Context-Bank file.",
                        display_relative(&path, &root)
                    ),
                );
                continue;
            }
            let content = match read_utf8_bounded(&canonical_path) {
                Ok(content) => content,
                Err(ContextBankError::ContentTooLarge) => {
                    push_warning(
                        &mut warnings,
                        format!(
                            "Skipped {} because it is larger than 512 KiB.",
                            display_relative(&path, &root)
                        ),
                    );
                    continue;
                }
                Err(ContextBankError::InvalidUtf8) => {
                    push_warning(
                        &mut warnings,
                        format!(
                            "Skipped {} because it is not UTF-8 text.",
                            display_relative(&path, &root)
                        ),
                    );
                    continue;
                }
                Err(error) => {
                    push_warning(
                        &mut warnings,
                        format!("Could not read {}: {error}", display_relative(&path, &root)),
                    );
                    continue;
                }
            };
            let relative = relative_path(&path, &root)?;
            if relative.chars().count() > 4096 || path.to_string_lossy().chars().count() > 4096 {
                push_warning(
                    &mut warnings,
                    "Skipped a Context Bank path longer than 4096 characters.".into(),
                );
                continue;
            }
            let is_symlink = metadata.file_type().is_symlink();
            let symlink_target_path = is_symlink
                .then(|| relative_path(&canonical_path, &root))
                .transpose()?;
            let line_limit = if Path::new(&relative)
                .parent()
                .is_none_or(|path| path.as_os_str().is_empty())
            {
                ROOT_LINE_LIMIT
            } else {
                NESTED_LINE_LIMIT
            };
            let count = line_count(&content);
            let content_sha256 = sha256_hex(&content);
            files.push(ScannedFile {
                item: ContextBankCatalogItem {
                    id: file_id(&relative),
                    relative_path: relative,
                    kind,
                    line_count: count,
                    line_limit,
                    over_limit: count > line_limit,
                    is_symlink,
                    symlink_target_path,
                },
                logical_path: path,
                canonical_path,
                content,
                content_sha256,
                editable: !target_metadata.permissions().readonly(),
            });
        }
        if truncated {
            break;
        }
    }

    files.sort_by(|left, right| left.item.relative_path.cmp(&right.item.relative_path));
    if truncated {
        push_warning(
            &mut warnings,
            "Context Bank scan reached its safety limit; refine the Project tree to see every file.".into(),
        );
    }
    Ok(Scan {
        files,
        warnings,
        truncated,
    })
}

fn sibling_conflicts(files: &[ScannedFile]) -> Vec<ContextBankSiblingConflict> {
    let mut by_directory: BTreeMap<String, Vec<&ScannedFile>> = BTreeMap::new();
    for file in files {
        let directory = Path::new(&file.item.relative_path)
            .parent()
            .and_then(Path::to_str)
            .unwrap_or("")
            .replace('\\', "/");
        by_directory.entry(directory).or_default().push(file);
    }
    let mut conflicts = Vec::new();
    for (directory, siblings) in by_directory {
        let kinds = siblings
            .iter()
            .map(|file| file.item.kind)
            .collect::<BTreeSet<_>>();
        let contents = siblings
            .iter()
            .map(|file| file.content_sha256.as_str())
            .collect::<BTreeSet<_>>();
        if kinds.len() > 1 && contents.len() > 1 {
            let directory_path = if directory.is_empty() {
                "."
            } else {
                &directory
            };
            let mut identity = format!("context-bank-conflict\0{directory_path}");
            let mut file_ids = Vec::with_capacity(siblings.len());
            for file in siblings {
                identity.push('\0');
                identity.push_str(&file.item.id);
                identity.push('\0');
                identity.push_str(&file.content_sha256);
                file_ids.push(file.item.id.clone());
            }
            conflicts.push(ContextBankSiblingConflict {
                id: sha256_hex(&identity),
                directory_path: directory_path.to_owned(),
                file_ids,
            });
        }
    }
    conflicts
}

fn file_definition(file: ScannedFile) -> ContextBankFile {
    ContextBankFile {
        file_id: file.item.id,
        relative_path: file.item.relative_path,
        path: file.logical_path.to_string_lossy().into_owned(),
        kind: file.item.kind,
        content: file.content,
        content_sha256: file.content_sha256,
        line_count: file.item.line_count,
        line_limit: file.item.line_limit,
        is_symlink: file.item.is_symlink,
        symlink_target_path: file.item.symlink_target_path,
        editable: file.editable,
    }
}

fn read_utf8_bounded(path: &Path) -> Result<String, ContextBankError> {
    let mut file = fs::File::open(path)?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take((MAX_CONTENT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_CONTENT_BYTES {
        return Err(ContextBankError::ContentTooLarge);
    }
    String::from_utf8(bytes).map_err(|_| ContextBankError::InvalidUtf8)
}

fn relative_path(path: &Path, root: &Path) -> Result<String, ContextBankError> {
    let relative = path.strip_prefix(root).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Context Bank path escaped its Project root",
        )
    })?;
    let components = relative
        .components()
        .map(|component| component.as_os_str().to_str())
        .collect::<Option<Vec<_>>>()
        .ok_or(ContextBankError::InvalidUtf8)?;
    Ok(components.join("/"))
}

fn display_relative(path: &Path, root: &Path) -> String {
    relative_path(path, root).unwrap_or_else(|_| path.to_string_lossy().into_owned())
}

fn line_count(content: &str) -> usize {
    content.split('\n').count()
}

fn file_id(relative_path: &str) -> String {
    sha256_hex(&format!("context-bank\0{relative_path}"))
}

fn sha256_hex(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

fn push_warning(warnings: &mut Vec<String>, warning: String) {
    let warning = warning.chars().take(400).collect::<String>();
    if warnings.len() < MAX_WARNINGS && !warnings.contains(&warning) {
        warnings.push(warning);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "termloop-context-bank-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn scans_instruction_files_with_legacy_line_budgets_and_pruning() {
        let root = fixture();
        fs::write(root.join("AGENTS.md"), "root\ncontext\n").unwrap();
        fs::create_dir_all(root.join("apps/server")).unwrap();
        fs::write(root.join("apps/server/CLAUDE.md"), "nested\n").unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/AGENTS.md"), "ignored\n").unwrap();
        fs::create_dir_all(root.join("target/generated")).unwrap();
        fs::write(root.join("target/generated/CLAUDE.md"), "ignored\n").unwrap();

        let catalog = context_bank_catalog(&root, "Fixture").unwrap();
        assert_eq!(catalog.project_name, "Fixture");
        assert_eq!(catalog.files.len(), 2);
        assert_eq!(catalog.files[0].relative_path, "AGENTS.md");
        assert_eq!(catalog.files[0].line_limit, 200);
        assert_eq!(catalog.files[1].relative_path, "apps/server/CLAUDE.md");
        assert_eq!(catalog.files[1].line_limit, 100);
        assert!(catalog.sibling_conflicts.is_empty());
        assert!(!catalog.truncated);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn saves_with_a_content_hash_guard_and_returns_the_new_hash() {
        let root = fixture();
        fs::write(root.join("AGENTS.md"), "before\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root.join("AGENTS.md"), fs::Permissions::from_mode(0o640)).unwrap();
        }
        let catalog = context_bank_catalog(&root, "Fixture").unwrap();
        let file_id = &catalog.files[0].id;
        let original = read_context_bank_file(&root, file_id).unwrap();

        let saved =
            write_context_bank_file(&root, file_id, &original.content_sha256, "after\n").unwrap();
        assert_eq!(saved.content, "after\n");
        assert_ne!(saved.content_sha256, original.content_sha256);
        assert_eq!(
            fs::read_to_string(root.join("AGENTS.md")).unwrap(),
            "after\n"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(root.join("AGENTS.md"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o640
            );
        }
        assert!(matches!(
            write_context_bank_file(&root, file_id, &original.content_sha256, "stale\n"),
            Err(ContextBankError::StaleFile)
        ));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reports_and_resolves_divergent_sibling_instructions() {
        let root = fixture();
        fs::write(root.join("AGENTS.md"), "agents\n").unwrap();
        fs::write(root.join("CLAUDE.md"), "claude\n").unwrap();
        fs::write(root.join("GEMINI.md"), "gemini\n").unwrap();

        let catalog = context_bank_catalog(&root, "Fixture").unwrap();
        assert_eq!(catalog.sibling_conflicts.len(), 1);
        assert_eq!(catalog.sibling_conflicts[0].directory_path, ".");
        assert_eq!(catalog.sibling_conflicts[0].file_ids.len(), 3);
        assert!(catalog.warnings.is_empty());
        let conflict_id = catalog.sibling_conflicts[0].id.clone();
        let source_id = catalog
            .files
            .iter()
            .find(|file| file.relative_path == "AGENTS.md")
            .unwrap()
            .id
            .clone();

        let resolved =
            resolve_context_bank_sibling_conflict(&root, "Fixture", &conflict_id, &source_id)
                .unwrap();
        assert!(resolved.sibling_conflicts.is_empty());
        assert_eq!(
            fs::read_to_string(root.join("CLAUDE.md")).unwrap(),
            "agents\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("GEMINI.md")).unwrap(),
            "agents\n"
        );

        fs::write(root.join("CLAUDE.md"), "different again\n").unwrap();
        let stale_catalog = context_bank_catalog(&root, "Fixture").unwrap();
        let stale_conflict_id = stale_catalog.sibling_conflicts[0].id.clone();
        fs::write(root.join("AGENTS.md"), "changed after scan\n").unwrap();
        assert!(matches!(
            resolve_context_bank_sibling_conflict(&root, "Fixture", &stale_conflict_id, &source_id,),
            Err(ContextBankError::StaleFile)
        ));
        assert_eq!(
            fs::read_to_string(root.join("CLAUDE.md")).unwrap(),
            "different again\n"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_read_only_conflict_before_overwriting_any_sibling() {
        use std::os::unix::fs::PermissionsExt;

        let root = fixture();
        fs::write(root.join("AGENTS.md"), "source\n").unwrap();
        fs::write(root.join("CLAUDE.md"), "read only\n").unwrap();
        fs::write(root.join("GEMINI.md"), "must stay unchanged\n").unwrap();
        fs::set_permissions(root.join("CLAUDE.md"), fs::Permissions::from_mode(0o440)).unwrap();

        let catalog = context_bank_catalog(&root, "Fixture").unwrap();
        let conflict = &catalog.sibling_conflicts[0];
        let source_id = &catalog
            .files
            .iter()
            .find(|file| file.relative_path == "AGENTS.md")
            .unwrap()
            .id;
        assert!(matches!(
            resolve_context_bank_sibling_conflict(&root, "Fixture", &conflict.id, source_id,),
            Err(ContextBankError::ReadOnly)
        ));
        assert_eq!(
            fs::read_to_string(root.join("GEMINI.md")).unwrap(),
            "must stay unchanged\n"
        );

        fs::set_permissions(root.join("CLAUDE.md"), fs::Permissions::from_mode(0o640)).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn follows_only_in_project_file_symlinks_and_preserves_them_on_save() {
        use std::os::unix::fs::symlink;

        let root = fixture();
        let outside = root.with_extension("outside.md");
        fs::write(root.join("CLAUDE.md"), "shared\n").unwrap();
        symlink("CLAUDE.md", root.join("AGENTS.md")).unwrap();
        fs::write(&outside, "outside\n").unwrap();
        symlink(&outside, root.join("GEMINI.md")).unwrap();
        fs::write(root.join("package.json"), "{}\n").unwrap();
        fs::create_dir(root.join("unsafe")).unwrap();
        symlink("../package.json", root.join("unsafe/AGENTS.md")).unwrap();

        let catalog = context_bank_catalog(&root, "Fixture").unwrap();
        assert_eq!(catalog.files.len(), 2);
        let alias = catalog
            .files
            .iter()
            .find(|file| file.relative_path == "AGENTS.md")
            .unwrap();
        assert!(alias.is_symlink);
        assert_eq!(alias.symlink_target_path.as_deref(), Some("CLAUDE.md"));
        let definition = read_context_bank_file(&root, &alias.id).unwrap();
        write_context_bank_file(&root, &alias.id, &definition.content_sha256, "updated\n").unwrap();
        assert!(
            fs::symlink_metadata(root.join("AGENTS.md"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            fs::read_to_string(root.join("CLAUDE.md")).unwrap(),
            "updated\n"
        );
        assert!(
            catalog
                .warnings
                .iter()
                .any(|warning| warning.contains("outside the Project"))
        );
        assert!(
            catalog
                .warnings
                .iter()
                .any(|warning| warning.contains("non-Context-Bank file"))
        );

        fs::remove_dir_all(root).unwrap();
        fs::remove_file(outside).unwrap();
    }
}
