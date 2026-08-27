use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::{LaunchEnvironment, PlatformError};

/// How a resolved launch target must be started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchTargetKind {
    /// A directly spawnable native binary (Mach-O, ELF, or PE).
    NativeExecutable,
    /// A Unix `#!` interpreter script; the kernel resolves the interpreter.
    ShebangScript,
    /// A Windows `.cmd`/`.bat` shim that requires an explicit `cmd.exe`
    /// wrapper because `CreateProcessW` cannot execute it directly.
    WindowsCmdScript,
}

/// An externally installed CLI resolved from an explicit launch environment,
/// carrying the exact spawn composition it requires.
///
/// The wrapper for `.cmd`/`.bat` shims is owned by this type: callers obtain
/// the complete `(program, arguments)` tuple from [`Self::command_line`] and
/// cannot compose the wrapper themselves. `Debug` deliberately hides the
/// resolved path.
#[derive(Clone, PartialEq, Eq)]
pub struct ResolvedLaunchTarget {
    target: PathBuf,
    kind: LaunchTargetKind,
    /// Present exactly when `kind` is [`LaunchTargetKind::WindowsCmdScript`].
    cmd_interpreter: Option<PathBuf>,
}

impl std::fmt::Debug for ResolvedLaunchTarget {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ResolvedLaunchTarget")
            .field("kind", &self.kind)
            .field("target_present", &true)
            .finish()
    }
}

impl ResolvedLaunchTarget {
    /// The resolved on-disk target file (the CLI entry point itself, not the
    /// wrapper interpreter). Suitable for inspection and diagnostics policy
    /// owned by the caller.
    pub fn target_path(&self) -> &Path {
        &self.target
    }

    pub fn kind(&self) -> LaunchTargetKind {
        self.kind
    }

    /// Returns the exact `(program, arguments)` spawn tuple for this target
    /// with `args` appended, for an argument-vector spawn primitive. For
    /// directly spawnable targets the program is the target itself; for
    /// `.cmd`/`.bat` shims the program is the resolved `cmd.exe` and the
    /// arguments are `/d /s /c <target> <args…>`. Callers must pass the tuple
    /// through unchanged.
    pub fn command_line<I, S>(&self, args: I) -> (PathBuf, Vec<OsString>)
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        match &self.cmd_interpreter {
            Some(interpreter) => {
                let mut arguments = vec![
                    OsString::from("/d"),
                    OsString::from("/s"),
                    OsString::from("/c"),
                    self.target.clone().into_os_string(),
                ];
                arguments.extend(args.into_iter().map(Into::into));
                (interpreter.clone(), arguments)
            }
            None => (
                self.target.clone(),
                args.into_iter().map(Into::into).collect(),
            ),
        }
    }
}

/// Resolves an externally installed agent CLI (for example `claude` or
/// `codex`) against the `PATH` of the provided launch environment only; the
/// ambient process environment is never consulted.
///
/// Unlike [`crate::resolve_executable`] — which stays strict-native for
/// TermLoop-owned binaries — this resolver accepts the shapes external CLIs
/// actually install as: native binaries, Unix `#!` interpreter scripts, and
/// Windows `.cmd`/`.bat` shims (honoring `PATHEXT` ordering from the provided
/// environment). Errors distinguish a target that was not found
/// ([`PlatformError::LaunchTargetNotFound`]) from one that exists but cannot
/// be launched ([`PlatformError::LaunchTargetUnusable`]).
pub fn resolve_launch_target(
    program_name: &str,
    environment: &LaunchEnvironment,
) -> Result<ResolvedLaunchTarget, PlatformError> {
    crate::process::validate_executable_name(program_name)?;
    let search_path =
        environment_value(environment, "PATH").ok_or(PlatformError::LaunchTargetNotFound)?;
    let candidates = launch_candidate_names(program_name, environment);
    let mut found_unusable = false;
    for directory in std::env::split_paths(search_path) {
        if directory.as_os_str().is_empty() {
            continue;
        }
        for (file_name, extension_kind) in &candidates {
            let candidate = directory.join(file_name);
            match classify_launch_candidate(&candidate, *extension_kind) {
                CandidateProbe::Usable(kind) => {
                    return launch_target_for(candidate, kind, environment);
                }
                CandidateProbe::Unusable => found_unusable = true,
                CandidateProbe::Missing => {}
            }
        }
    }
    Err(if found_unusable {
        PlatformError::LaunchTargetUnusable
    } else {
        PlatformError::LaunchTargetNotFound
    })
}

fn launch_target_for(
    target: PathBuf,
    kind: LaunchTargetKind,
    environment: &LaunchEnvironment,
) -> Result<ResolvedLaunchTarget, PlatformError> {
    let cmd_interpreter = if kind == LaunchTargetKind::WindowsCmdScript {
        Some(
            resolved_windows_cmd_interpreter(environment)
                .ok_or(PlatformError::LaunchTargetUnusable)?,
        )
    } else {
        None
    };
    Ok(ResolvedLaunchTarget {
        target,
        kind,
        cmd_interpreter,
    })
}

enum CandidateProbe {
    /// No candidate file at this path; keep searching later `PATH` entries.
    Missing,
    /// A candidate exists but cannot be launched (not executable, unreadable,
    /// or unrecognized content). The search continues, and this fact upgrades
    /// a final not-found into [`PlatformError::LaunchTargetUnusable`].
    Unusable,
    Usable(LaunchTargetKind),
}

fn launch_candidate_names(
    name: &str,
    environment: &LaunchEnvironment,
) -> Vec<(String, Option<LaunchTargetKind>)> {
    #[cfg(windows)]
    {
        let pathext = environment_value(environment, "PATHEXT").and_then(OsStr::to_str);
        windows_launch_candidate_names(name, pathext)
            .into_iter()
            .map(|(file_name, kind)| (file_name, Some(kind)))
            .collect()
    }
    #[cfg(not(windows))]
    {
        let _ = environment;
        vec![(name.to_owned(), None)]
    }
}

fn classify_launch_candidate(
    path: &Path,
    extension_kind: Option<LaunchTargetKind>,
) -> CandidateProbe {
    #[cfg(windows)]
    {
        match extension_kind {
            Some(kind) => classify_windows_launch_candidate(path, kind),
            None => CandidateProbe::Missing,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = extension_kind;
        classify_unix_launch_candidate(path)
    }
}

#[cfg(not(windows))]
fn classify_unix_launch_candidate(path: &Path) -> CandidateProbe {
    let Ok(metadata) = std::fs::metadata(path) else {
        return CandidateProbe::Missing;
    };
    if !metadata.is_file() {
        return CandidateProbe::Missing;
    }
    if !crate::process::executable_mode_is_eligible(&metadata) {
        return CandidateProbe::Unusable;
    }
    let Some(header) = read_launch_header(path) else {
        return CandidateProbe::Unusable;
    };
    if crate::process::native_executable_header_is_supported(&header) {
        CandidateProbe::Usable(LaunchTargetKind::NativeExecutable)
    } else if header.starts_with(b"#!") {
        CandidateProbe::Usable(LaunchTargetKind::ShebangScript)
    } else {
        CandidateProbe::Unusable
    }
}

#[cfg(windows)]
fn classify_windows_launch_candidate(
    path: &Path,
    extension_kind: LaunchTargetKind,
) -> CandidateProbe {
    let Ok(metadata) = std::fs::metadata(path) else {
        return CandidateProbe::Missing;
    };
    if !metadata.is_file() {
        return CandidateProbe::Missing;
    }
    match extension_kind {
        LaunchTargetKind::NativeExecutable => {
            let Some(header) = read_launch_header(path) else {
                return CandidateProbe::Unusable;
            };
            if crate::process::native_executable_header_is_supported(&header) {
                CandidateProbe::Usable(LaunchTargetKind::NativeExecutable)
            } else {
                CandidateProbe::Unusable
            }
        }
        LaunchTargetKind::WindowsCmdScript => {
            CandidateProbe::Usable(LaunchTargetKind::WindowsCmdScript)
        }
        LaunchTargetKind::ShebangScript => CandidateProbe::Missing,
    }
}

fn read_launch_header(path: &Path) -> Option<Vec<u8>> {
    let file = std::fs::File::open(path).ok()?;
    let mut header = Vec::with_capacity(8);
    file.take(8).read_to_end(&mut header).ok()?;
    Some(header)
}

fn resolved_windows_cmd_interpreter(environment: &LaunchEnvironment) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        windows_cmd_interpreter_candidates(
            environment_value(environment, "COMSPEC"),
            environment_value(environment, "SYSTEMROOT"),
        )
        .into_iter()
        .find(|candidate| candidate.is_file())
    }
    #[cfg(not(windows))]
    {
        let _ = environment;
        None
    }
}

const WINDOWS_DEFAULT_LAUNCH_EXTENSIONS: &[(&str, LaunchTargetKind)] = &[
    (".EXE", LaunchTargetKind::NativeExecutable),
    (".COM", LaunchTargetKind::NativeExecutable),
    (".CMD", LaunchTargetKind::WindowsCmdScript),
    (".BAT", LaunchTargetKind::WindowsCmdScript),
];

/// Ordered `(file name, kind)` launch candidates for one program name on
/// Windows. `PATHEXT` ordering wins when it lists supported extensions;
/// unsupported entries are skipped and an empty result falls back to the
/// fixed `.exe`/`.com`/`.cmd`/`.bat` list. Compiled on every host so ordering
/// and classification stay testable off-Windows.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_launch_candidate_names(
    name: &str,
    pathext: Option<&str>,
) -> Vec<(String, LaunchTargetKind)> {
    let mut extensions: Vec<(String, LaunchTargetKind)> = Vec::new();
    for extension in pathext.unwrap_or_default().split(';') {
        let extension = extension.trim().to_ascii_uppercase();
        let Some(kind) = windows_launch_kind_for_extension(&extension) else {
            continue;
        };
        if extensions
            .iter()
            .all(|(existing, _)| existing != &extension)
        {
            extensions.push((extension, kind));
        }
    }
    if extensions.is_empty() {
        extensions = WINDOWS_DEFAULT_LAUNCH_EXTENSIONS
            .iter()
            .map(|(extension, kind)| ((*extension).to_owned(), *kind))
            .collect();
    }
    extensions
        .into_iter()
        .map(|(extension, kind)| (format!("{name}{}", extension.to_ascii_lowercase()), kind))
        .collect()
}

#[cfg_attr(not(windows), allow(dead_code))]
fn windows_launch_kind_for_extension(extension_upper: &str) -> Option<LaunchTargetKind> {
    match extension_upper {
        ".EXE" | ".COM" => Some(LaunchTargetKind::NativeExecutable),
        ".CMD" | ".BAT" => Some(LaunchTargetKind::WindowsCmdScript),
        _ => None,
    }
}

/// Ordered `cmd.exe` interpreter candidates from explicit environment values:
/// `COMSPEC` first, then `SYSTEMROOT\System32\cmd.exe`. Pure so the ordering
/// stays testable off-Windows; the Windows resolver keeps the first candidate
/// that exists as a file.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_cmd_interpreter_candidates(
    comspec: Option<&OsStr>,
    system_root: Option<&OsStr>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(comspec) = comspec.filter(|value| !value.is_empty()) {
        candidates.push(PathBuf::from(comspec));
    }
    if let Some(system_root) = system_root.filter(|value| !value.is_empty()) {
        candidates.push(Path::new(system_root).join("System32").join("cmd.exe"));
    }
    candidates
}

fn environment_value<'environment>(
    environment: &'environment LaunchEnvironment,
    key: &str,
) -> Option<&'environment OsStr> {
    environment
        .entries()
        .find(|(entry_key, _)| entry_key.to_string_lossy().eq_ignore_ascii_case(key))
        .map(|(_, value)| value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_directory(label: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "termloop-launch-target-{label}-{}-{}",
            std::process::id(),
            crate::current_epoch_ms()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[cfg(unix)]
    fn write_fixture_file(directory: &Path, name: &str, contents: &[u8], mode: u32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = directory.join(name);
        std::fs::write(&path, contents).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        path
    }

    #[test]
    fn windows_candidates_honor_pathext_order_and_skip_unsupported_extensions() {
        let candidates = windows_launch_candidate_names("claude", Some(".COM;.PS1;.BAT;.EXE;.CMD"));
        assert_eq!(
            candidates,
            vec![
                ("claude.com".to_owned(), LaunchTargetKind::NativeExecutable),
                ("claude.bat".to_owned(), LaunchTargetKind::WindowsCmdScript),
                ("claude.exe".to_owned(), LaunchTargetKind::NativeExecutable),
                ("claude.cmd".to_owned(), LaunchTargetKind::WindowsCmdScript),
            ]
        );
        let deduplicated = windows_launch_candidate_names("claude", Some(".EXE;.exe;.CMD"));
        assert_eq!(
            deduplicated,
            vec![
                ("claude.exe".to_owned(), LaunchTargetKind::NativeExecutable),
                ("claude.cmd".to_owned(), LaunchTargetKind::WindowsCmdScript),
            ]
        );
    }

    #[test]
    fn windows_candidates_fall_back_to_the_fixed_extension_list() {
        for pathext in [None, Some(""), Some(";;"), Some(".PS1;.VBS")] {
            let candidates = windows_launch_candidate_names("codex", pathext);
            assert_eq!(
                candidates,
                vec![
                    ("codex.exe".to_owned(), LaunchTargetKind::NativeExecutable),
                    ("codex.com".to_owned(), LaunchTargetKind::NativeExecutable),
                    ("codex.cmd".to_owned(), LaunchTargetKind::WindowsCmdScript),
                    ("codex.bat".to_owned(), LaunchTargetKind::WindowsCmdScript),
                ],
                "pathext: {pathext:?}"
            );
        }
    }

    #[test]
    fn cmd_interpreter_candidates_prefer_comspec_then_system_root() {
        let candidates = windows_cmd_interpreter_candidates(
            Some(OsStr::new("C:\\Windows\\system32\\cmd.exe")),
            Some(OsStr::new("C:\\Windows")),
        );
        assert_eq!(
            candidates,
            vec![
                PathBuf::from("C:\\Windows\\system32\\cmd.exe"),
                Path::new("C:\\Windows").join("System32").join("cmd.exe"),
            ]
        );
        assert_eq!(
            windows_cmd_interpreter_candidates(Some(OsStr::new("")), None),
            Vec::<PathBuf>::new()
        );
        assert_eq!(
            windows_cmd_interpreter_candidates(None, Some(OsStr::new("C:\\Windows"))),
            vec![Path::new("C:\\Windows").join("System32").join("cmd.exe")]
        );
    }

    #[test]
    fn command_line_composes_the_exact_spawn_tuple() {
        let direct = ResolvedLaunchTarget {
            target: PathBuf::from("/opt/tools/claude"),
            kind: LaunchTargetKind::ShebangScript,
            cmd_interpreter: None,
        };
        let (program, arguments) = direct.command_line(["--version"]);
        assert_eq!(program, PathBuf::from("/opt/tools/claude"));
        assert_eq!(arguments, vec![OsString::from("--version")]);

        let wrapped = ResolvedLaunchTarget {
            target: PathBuf::from("C:\\npm\\claude.cmd"),
            kind: LaunchTargetKind::WindowsCmdScript,
            cmd_interpreter: Some(PathBuf::from("C:\\Windows\\System32\\cmd.exe")),
        };
        let (program, arguments) = wrapped.command_line(["--continue", "abc"]);
        assert_eq!(program, PathBuf::from("C:\\Windows\\System32\\cmd.exe"));
        assert_eq!(
            arguments,
            vec![
                OsString::from("/d"),
                OsString::from("/s"),
                OsString::from("/c"),
                OsString::from("C:\\npm\\claude.cmd"),
                OsString::from("--continue"),
                OsString::from("abc"),
            ]
        );
    }

    #[test]
    fn debug_output_hides_the_resolved_path() {
        let target = ResolvedLaunchTarget {
            target: PathBuf::from("/secret-location/claude"),
            kind: LaunchTargetKind::NativeExecutable,
            cmd_interpreter: None,
        };
        let debug = format!("{target:?}");
        assert!(!debug.contains("secret-location"), "{debug}");
        assert!(debug.contains("NativeExecutable"), "{debug}");
    }

    #[test]
    fn rejects_invalid_program_names() {
        let environment = LaunchEnvironment::os_baseline();
        for name in ["", "name with space", "../claude", "claude/x", "a.b"] {
            assert!(
                matches!(
                    resolve_launch_target(name, &environment),
                    Err(PlatformError::Io(_))
                ),
                "name: {name:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn resolves_shebang_scripts_from_the_provided_environment_path() {
        let directory = fixture_directory("shebang");
        let script = write_fixture_file(
            &directory,
            "termloop-fixture-agent",
            b"#!/usr/bin/env node\nconsole.log(1);\n",
            0o755,
        );
        let environment = LaunchEnvironment::os_baseline().with_explicit("PATH", &directory);
        let target = resolve_launch_target("termloop-fixture-agent", &environment).unwrap();
        assert_eq!(target.kind(), LaunchTargetKind::ShebangScript);
        assert_eq!(target.target_path(), script.as_path());
        let (program, arguments) = target.command_line(["--version"]);
        assert_eq!(program, script);
        assert_eq!(arguments, vec![OsString::from("--version")]);

        // `sh` exists on the ambient PATH but not on the provided one; the
        // resolver must honor only the provided environment.
        assert!(matches!(
            resolve_launch_target("sh", &environment),
            Err(PlatformError::LaunchTargetNotFound)
        ));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[cfg(unix)]
    #[test]
    fn accepts_native_binaries() {
        use std::os::unix::fs::PermissionsExt;
        let directory = fixture_directory("native");
        let path = directory.join("termloop-fixture-agent");
        std::fs::copy(std::env::current_exe().unwrap(), &path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let environment = LaunchEnvironment::os_baseline().with_explicit("PATH", &directory);
        let target = resolve_launch_target("termloop-fixture-agent", &environment).unwrap();
        assert_eq!(target.kind(), LaunchTargetKind::NativeExecutable);
        assert_eq!(target.target_path(), path.as_path());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_present_but_unusable_candidates_with_a_typed_error() {
        let directory = fixture_directory("unusable");
        let environment = LaunchEnvironment::os_baseline().with_explicit("PATH", &directory);

        write_fixture_file(
            &directory,
            "termloop-fixture-agent",
            b"#!/bin/sh\nexit 0\n",
            0o644,
        );
        assert!(matches!(
            resolve_launch_target("termloop-fixture-agent", &environment),
            Err(PlatformError::LaunchTargetUnusable)
        ));

        write_fixture_file(
            &directory,
            "termloop-fixture-agent",
            b"plain text payload",
            0o755,
        );
        assert!(matches!(
            resolve_launch_target("termloop-fixture-agent", &environment),
            Err(PlatformError::LaunchTargetUnusable)
        ));

        assert!(matches!(
            resolve_launch_target("termloop-absent-agent", &environment),
            Err(PlatformError::LaunchTargetNotFound)
        ));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[cfg(unix)]
    #[test]
    fn later_path_entries_win_over_earlier_unusable_candidates() {
        let broken = fixture_directory("broken");
        let working = fixture_directory("working");
        write_fixture_file(&broken, "termloop-fixture-agent", b"#!/bin/sh\n", 0o644);
        let script = write_fixture_file(
            &working,
            "termloop-fixture-agent",
            b"#!/bin/sh\nexit 0\n",
            0o755,
        );
        let path = std::env::join_paths([&broken, &working]).unwrap();
        let environment = LaunchEnvironment::os_baseline().with_explicit("PATH", &path);
        let target = resolve_launch_target("termloop-fixture-agent", &environment).unwrap();
        assert_eq!(target.kind(), LaunchTargetKind::ShebangScript);
        assert_eq!(target.target_path(), script.as_path());
        let _ = std::fs::remove_dir_all(broken);
        let _ = std::fs::remove_dir_all(working);
    }

    #[cfg(windows)]
    #[test]
    fn resolves_cmd_shims_with_an_explicit_cmd_interpreter() {
        let directory = fixture_directory("cmd-shim");
        let shim = directory.join("termloop-fixture-agent.cmd");
        std::fs::write(&shim, "@echo off\r\n").unwrap();
        let environment = LaunchEnvironment::os_baseline().with_explicit("PATH", &directory);
        let target = resolve_launch_target("termloop-fixture-agent", &environment).unwrap();
        assert_eq!(target.kind(), LaunchTargetKind::WindowsCmdScript);
        assert_eq!(target.target_path(), shim.as_path());
        let (program, arguments) = target.command_line(["--version"]);
        assert!(
            program
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("cmd.exe")),
            "{program:?}"
        );
        assert_eq!(
            &arguments[..3],
            &[
                OsString::from("/d"),
                OsString::from("/s"),
                OsString::from("/c"),
            ][..]
        );
        assert_eq!(arguments[3], shim.clone().into_os_string());
        assert_eq!(arguments[4], OsString::from("--version"));
        let _ = std::fs::remove_dir_all(directory);
    }
}
