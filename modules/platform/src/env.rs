use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

/// A complete child-process environment reconstructed from an explicit
/// cross-platform baseline plus purpose-specific additions.
///
/// Values deliberately have no serialization surface and `Debug` exposes only
/// key names. Callers can add visible runtime entries, but cannot obtain an
/// unfiltered snapshot through this type.
#[derive(Clone, PartialEq, Eq)]
pub struct LaunchEnvironment {
    entries: Vec<(OsString, OsString)>,
}

impl LaunchEnvironment {
    pub fn os_baseline() -> Self {
        Self::baseline_with_user_directories(std::env::vars_os(), user_executable_directories())
    }

    /// Minimal baseline for a TermLoop-owned helper that is launched by exact
    /// path and must not inherit homes, provider credentials, proxies, or
    /// arbitrary temporary/config roots.
    pub fn isolated_process_baseline() -> Self {
        let variables = std::env::vars_os().filter(|(key, _)| restricted_key_allowed(key));
        let mut environment = Self { entries: vec![] };
        for (key, value) in variables {
            environment.insert(key, value);
        }
        environment.insert("TERM".into(), "xterm-256color".into());
        environment.insert("COLORTERM".into(), "truecolor".into());
        environment.insert("TERM_PROGRAM".into(), "TermLoop".into());
        environment.insert(
            "TERM_PROGRAM_VERSION".into(),
            env!("CARGO_PKG_VERSION").into(),
        );
        environment
    }

    pub fn with_explicit<K, V>(mut self, key: K, value: V) -> Self
    where
        K: AsRef<OsStr>,
        V: AsRef<OsStr>,
    {
        self.insert(key.as_ref().to_owned(), value.as_ref().to_owned());
        self
    }

    pub fn entries(&self) -> impl Iterator<Item = (&OsStr, &OsStr)> {
        self.entries
            .iter()
            .map(|(key, value)| (key.as_os_str(), value.as_os_str()))
    }

    pub fn keys(&self) -> impl Iterator<Item = &OsStr> {
        self.entries.iter().map(|(key, _)| key.as_os_str())
    }

    pub fn contains_key<K>(&self, key: K) -> bool
    where
        K: AsRef<OsStr>,
    {
        self.entries
            .iter()
            .any(|(candidate, _)| environment_keys_equal(candidate, key.as_ref()))
    }

    fn value<K>(&self, key: K) -> Option<&OsStr>
    where
        K: AsRef<OsStr>,
    {
        self.entries
            .iter()
            .find(|(candidate, _)| environment_keys_equal(candidate, key.as_ref()))
            .map(|(_, value)| value.as_os_str())
    }

    #[cfg(test)]
    fn baseline_from<I>(variables: I) -> Self
    where
        I: IntoIterator<Item = (OsString, OsString)>,
    {
        Self::baseline_with_user_directories(variables, &[])
    }

    fn baseline_with_user_directories<I>(variables: I, user_directories: &[PathBuf]) -> Self
    where
        I: IntoIterator<Item = (OsString, OsString)>,
    {
        let mut environment = Self::allowlisted(variables);
        repair_user_executable_path(&mut environment, user_directories);
        environment.insert("TERM".into(), "xterm-256color".into());
        environment.insert("COLORTERM".into(), "truecolor".into());
        environment.insert("TERM_PROGRAM".into(), "TermLoop".into());
        environment.insert(
            "TERM_PROGRAM_VERSION".into(),
            env!("CARGO_PKG_VERSION").into(),
        );
        environment
    }

    fn allowlisted<I>(variables: I) -> Self
    where
        I: IntoIterator<Item = (OsString, OsString)>,
    {
        let mut environment = Self { entries: vec![] };
        for (key, value) in variables {
            if baseline_key_allowed(&key) {
                environment.insert(key, value);
            }
        }
        environment
    }

    fn insert(&mut self, key: OsString, value: OsString) {
        if let Some((existing_key, existing_value)) = self
            .entries
            .iter_mut()
            .find(|(existing, _)| environment_keys_equal(existing, &key))
        {
            *existing_key = key;
            *existing_value = value;
        } else {
            self.entries.push((key, value));
        }
    }
}

/// Appends the directories a user's own terminal would search to the inherited
/// PATH. Apps opened from the Dock or Finder inherit launchd's bare system PATH,
/// so a CLI installed through Homebrew, nvm, Volta, mise and similar managers
/// was otherwise invisible to the daemon. The inherited order still wins.
fn repair_user_executable_path(
    _environment: &mut LaunchEnvironment,
    _user_directories: &[PathBuf],
) {
    #[cfg(not(windows))]
    {
        let home = _environment
            .entries
            .iter()
            .find(|(key, _)| key == "HOME")
            .map(|(_, value)| PathBuf::from(value));
        let Some(home) = home else {
            return;
        };
        let inherited = _environment
            .entries
            .iter()
            .find(|(key, _)| key == "PATH")
            .map(|(_, value)| value.as_os_str());
        let candidates = [home.join(".local/bin"), home.join(".bun/bin")];
        let mut paths = candidates.to_vec();
        if let Some(inherited) = inherited {
            paths.extend(
                std::env::split_paths(inherited)
                    .filter(|path| !candidates.iter().any(|candidate| candidate == path)),
            );
        }
        for directory in _user_directories {
            if !paths.contains(directory) {
                paths.push(directory.clone());
            }
        }
        if let Ok(path) = std::env::join_paths(paths) {
            _environment.insert("PATH".into(), path);
        }
    }
}

/// The user's login-shell PATH entries plus well-known package-manager
/// directories, resolved once per process. A failed or slow shell degrades to
/// the well-known directories only.
fn user_executable_directories() -> &'static [PathBuf] {
    static DIRECTORIES: OnceLock<Vec<PathBuf>> = OnceLock::new();
    DIRECTORIES.get_or_init(|| {
        #[cfg(windows)]
        {
            Vec::new()
        }
        #[cfg(not(windows))]
        {
            let environment = LaunchEnvironment::allowlisted(std::env::vars_os());
            let mut directories = login_shell_path(&environment)
                .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
                .unwrap_or_default();
            for directory in ["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from) {
                if !directories.contains(&directory) && directory.is_dir() {
                    directories.push(directory);
                }
            }
            directories.retain(|directory| directory.is_absolute());
            directories
        }
    })
}

#[cfg(not(windows))]
const LOGIN_SHELL_PATH_MARKER: &str = "__TERMLOOP_LOGIN_PATH__";

/// Asks the user's interactive login shell for its PATH, the same startup files
/// a TermLoop terminal runs. Only `PATH` is read back; markers isolate it from
/// anything the startup files print. `+m` disables job control: the probe runs
/// in its own process group, and an interactive shell that tried to take a
/// controlling terminal would be stopped until the timeout. Shells that reject
/// these flags fail fast and leave only the well-known directories.
#[cfg(not(windows))]
fn login_shell_path(environment: &LaunchEnvironment) -> Option<OsString> {
    use std::os::unix::ffi::OsStringExt;

    let shell = environment
        .value("SHELL")
        .filter(|shell| !shell.is_empty())?;
    let script = format!(
        "printf '%s' '{LOGIN_SHELL_PATH_MARKER}'; printenv PATH; printf '%s' '{LOGIN_SHELL_PATH_MARKER}'"
    );
    let outcome = crate::run_command(
        crate::CommandRequest::with_launch_environment(shell, environment.clone())
            .args(["+m", "-i", "-l", "-c", script.as_str()])
            .timeout(std::time::Duration::from_secs(5))
            .output_limit(64 * 1024),
    )
    .ok()?;
    if !outcome.success() || outcome.stdout_truncated {
        return None;
    }
    login_shell_path_from_output(&outcome.stdout).map(OsString::from_vec)
}

#[cfg(not(windows))]
fn login_shell_path_from_output(stdout: &[u8]) -> Option<Vec<u8>> {
    let marker = LOGIN_SHELL_PATH_MARKER.as_bytes();
    let start = stdout
        .windows(marker.len())
        .position(|window| window == marker)?
        + marker.len();
    let length = stdout[start..]
        .windows(marker.len())
        .position(|window| window == marker)?;
    let path = stdout[start..start + length].trim_ascii();
    (!path.is_empty()).then(|| path.to_vec())
}

impl std::fmt::Debug for LaunchEnvironment {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LaunchEnvironment")
            .field("keys", &self.keys().collect::<Vec<_>>())
            .finish()
    }
}

fn baseline_key_allowed(key: &OsStr) -> bool {
    let Some(key) = key.to_str() else {
        return false;
    };
    baseline_key_allowed_for(key, cfg!(windows))
}

fn restricted_key_allowed(key: &OsStr) -> bool {
    let Some(key) = key.to_str() else {
        return false;
    };
    let normalized = cfg!(windows).then(|| key.to_ascii_uppercase());
    let key = normalized.as_deref().unwrap_or(key);
    const EXACT: &[&str] = &[
        "LANG",
        "LANGUAGE",
        "TZ",
        "SYSTEMROOT",
        "WINDIR",
        "SYSTEMDRIVE",
        "COMSPEC",
        "PATHEXT",
        "OS",
    ];
    EXACT.contains(&key) || key.starts_with("LC_")
}

fn baseline_key_allowed_for(key: &str, case_insensitive: bool) -> bool {
    let normalized = case_insensitive.then(|| key.to_ascii_uppercase());
    let key = normalized.as_deref().unwrap_or(key);

    const EXACT: &[&str] = &[
        "PATH",
        "HOME",
        "SHELL",
        "USER",
        "LOGNAME",
        "LANG",
        "LANGUAGE",
        "TZ",
        "TMPDIR",
        "TEMP",
        "TMP",
        "SSH_AUTH_SOCK",
        "SSH_AGENT_PID",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
        "all_proxy",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
        "REQUESTS_CA_BUNDLE",
        "XDG_RUNTIME_DIR",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "DBUS_SESSION_BUS_ADDRESS",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "USERNAME",
        "SYSTEMROOT",
        "WINDIR",
        "SYSTEMDRIVE",
        "COMSPEC",
        "PATHEXT",
        "PROGRAMDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "APPDATA",
        "LOCALAPPDATA",
        "PUBLIC",
        "COMPUTERNAME",
        "USERDOMAIN",
        "NUMBER_OF_PROCESSORS",
        "PROCESSOR_ARCHITECTURE",
        "OS",
        // Preserve enterprise Gemini configuration authority. TermLoop may
        // add a lowest-priority system-defaults overlay only when the latter
        // key and its native default file are both absent.
        "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
        "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
    ];

    EXACT.contains(&key) || key.starts_with("LC_")
}

pub fn gemini_cli_system_defaults_source_present(environment: &LaunchEnvironment) -> bool {
    environment.contains_key("GEMINI_CLI_SYSTEM_DEFAULTS_PATH")
        || environment
            .value("GEMINI_CLI_SYSTEM_SETTINGS_PATH")
            .is_some_and(gemini_cli_derived_system_defaults_source_present)
        || gemini_cli_system_defaults_path().is_file()
}

fn gemini_cli_derived_system_defaults_source_present(settings_path: &OsStr) -> bool {
    let settings_path = std::path::PathBuf::from(settings_path);
    if !settings_path.is_absolute() {
        return true;
    }
    settings_path
        .parent()
        .is_none_or(|parent| parent.join("system-defaults.json").is_file())
}

pub fn gemini_cli_system_defaults_path() -> std::path::PathBuf {
    #[cfg(target_os = "macos")]
    {
        std::path::PathBuf::from("/Library/Application Support/GeminiCli/system-defaults.json")
    }
    #[cfg(target_os = "linux")]
    {
        std::path::PathBuf::from("/etc/gemini-cli/system-defaults.json")
    }
    #[cfg(windows)]
    {
        std::env::var_os("PROGRAMDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from(r"C:\ProgramData"))
            .join("gemini-cli")
            .join("system-defaults.json")
    }
}

fn environment_keys_equal(left: &OsStr, right: &OsStr) -> bool {
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

pub(super) fn apply_launch_environment(command: &mut Command, environment: &LaunchEnvironment) {
    command.env_clear();
    command.envs(environment.entries());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_environment_filters_parent_markers_and_redacts_values() {
        let environment = LaunchEnvironment::baseline_from([
            ("PATH".into(), "/safe/bin".into()),
            ("HOME".into(), "/safe/home".into()),
            ("LANG".into(), "tr_TR.UTF-8".into()),
            ("SSH_AUTH_SOCK".into(), "/private/agent.sock".into()),
            ("TERM".into(), "parent-term".into()),
            ("CLAUDE_CODE_CHILD_SESSION".into(), "1".into()),
            ("TERMLOOP_MCP_TOKEN".into(), "secret-mcp".into()),
            ("ANTHROPIC_API_KEY".into(), "secret-anthropic".into()),
            ("AWS_SECRET_ACCESS_KEY".into(), "secret-aws".into()),
            (
                "GEMINI_CLI_SYSTEM_DEFAULTS_PATH".into(),
                "/managed/defaults.json".into(),
            ),
            (
                "GEMINI_CLI_SYSTEM_SETTINGS_PATH".into(),
                "/managed/settings.json".into(),
            ),
        ]);
        let entries = environment
            .entries()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.to_string_lossy().into_owned(),
                )
            })
            .collect::<std::collections::HashMap<_, _>>();
        #[cfg(not(windows))]
        assert_eq!(
            entries.get("PATH").map(String::as_str),
            Some("/safe/home/.local/bin:/safe/home/.bun/bin:/safe/bin")
        );
        #[cfg(windows)]
        assert_eq!(entries.get("PATH").map(String::as_str), Some("/safe/bin"));
        assert_eq!(entries.get("HOME").map(String::as_str), Some("/safe/home"));
        assert_eq!(entries.get("LANG").map(String::as_str), Some("tr_TR.UTF-8"));
        assert!(environment.contains_key("GEMINI_CLI_SYSTEM_DEFAULTS_PATH"));
        assert!(environment.contains_key("GEMINI_CLI_SYSTEM_SETTINGS_PATH"));
        assert_eq!(
            entries.get("SSH_AUTH_SOCK").map(String::as_str),
            Some("/private/agent.sock")
        );
        assert_eq!(
            entries.get("TERM").map(String::as_str),
            Some("xterm-256color")
        );
        assert!(!entries.contains_key("CLAUDE_CODE_CHILD_SESSION"));
        assert!(!entries.contains_key("TERMLOOP_MCP_TOKEN"));
        assert!(!entries.contains_key("ANTHROPIC_API_KEY"));
        assert!(!entries.contains_key("AWS_SECRET_ACCESS_KEY"));

        let debug = format!("{environment:?}");
        assert!(debug.contains("SSH_AUTH_SOCK"));
        assert!(!debug.contains("/private/agent.sock"));
        assert!(!debug.contains("secret-"));
        assert!(baseline_key_allowed_for("Path", true));
        assert!(baseline_key_allowed_for("lc_all", true));
        assert!(!baseline_key_allowed_for("Path", false));
        assert!(!baseline_key_allowed_for("CLAUDE_CODE_CHILD_SESSION", true));
    }

    #[test]
    fn explicit_gemini_system_defaults_source_prevents_an_invocation_overlay() {
        let environment = LaunchEnvironment::baseline_from([(
            "GEMINI_CLI_SYSTEM_DEFAULTS_PATH".into(),
            "/managed/defaults.json".into(),
        )]);
        assert!(gemini_cli_system_defaults_source_present(&environment));
    }

    #[test]
    fn system_settings_path_detects_its_derived_system_defaults_sibling() {
        let root = std::env::temp_dir().join(format!(
            "termloop-platform-gemini-system-settings-{}-{}",
            std::process::id(),
            crate::generate_opaque_id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let settings_path = root.join("settings.json");
        let environment = LaunchEnvironment::baseline_from([(
            "GEMINI_CLI_SYSTEM_SETTINGS_PATH".into(),
            settings_path.as_os_str().to_owned(),
        )]);
        assert!(!gemini_cli_derived_system_defaults_source_present(
            environment
                .value("GEMINI_CLI_SYSTEM_SETTINGS_PATH")
                .unwrap()
        ));

        std::fs::write(root.join("system-defaults.json"), b"{}").unwrap();
        assert!(gemini_cli_derived_system_defaults_source_present(
            environment
                .value("GEMINI_CLI_SYSTEM_SETTINGS_PATH")
                .unwrap()
        ));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn relative_system_settings_path_degrades_conservatively() {
        let environment = LaunchEnvironment::baseline_from([(
            "GEMINI_CLI_SYSTEM_SETTINGS_PATH".into(),
            "managed/settings.json".into(),
        )]);
        assert!(gemini_cli_derived_system_defaults_source_present(
            environment
                .value("GEMINI_CLI_SYSTEM_SETTINGS_PATH")
                .unwrap()
        ));
    }

    #[test]
    fn isolated_process_environment_excludes_ambient_authority() {
        for key in [
            "HOME",
            "PATH",
            "SSH_AUTH_SOCK",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "XDG_CONFIG_HOME",
            "TMPDIR",
            "SSL_CERT_FILE",
            "NODE_EXTRA_CA_CERTS",
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
        ] {
            assert!(!restricted_key_allowed(OsStr::new(key)));
        }
        for key in ["LANG", "SYSTEMROOT"] {
            assert!(restricted_key_allowed(OsStr::new(key)));
        }
    }

    #[cfg(unix)]
    #[test]
    fn login_shell_path_is_isolated_from_startup_file_output() {
        let output = format!(
            "Welcome!\n\x1b]0;title\x07{LOGIN_SHELL_PATH_MARKER}/opt/homebrew/bin:/usr/bin\n{LOGIN_SHELL_PATH_MARKER}bye"
        );
        assert_eq!(
            login_shell_path_from_output(output.as_bytes()).as_deref(),
            Some(b"/opt/homebrew/bin:/usr/bin".as_slice())
        );
        assert_eq!(login_shell_path_from_output(b"no markers"), None);
        let unterminated = format!("{LOGIN_SHELL_PATH_MARKER}/usr/bin");
        assert_eq!(login_shell_path_from_output(unterminated.as_bytes()), None);
        let empty = format!("{LOGIN_SHELL_PATH_MARKER}\n{LOGIN_SHELL_PATH_MARKER}");
        assert_eq!(login_shell_path_from_output(empty.as_bytes()), None);
    }

    #[cfg(unix)]
    #[test]
    fn user_directories_extend_a_bare_inherited_path_without_reordering_it() {
        let environment = LaunchEnvironment::baseline_with_user_directories(
            [
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("HOME".into(), "/safe/home".into()),
            ],
            &[
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/bin"),
                PathBuf::from("/safe/home/.nvm/versions/node/v22/bin"),
            ],
        );
        assert_eq!(
            environment.value("PATH"),
            Some(OsStr::new(
                "/safe/home/.local/bin:/safe/home/.bun/bin:/usr/bin:/bin:/opt/homebrew/bin:/safe/home/.nvm/versions/node/v22/bin"
            ))
        );
    }

    #[cfg(unix)]
    #[test]
    fn login_shell_probe_reads_the_users_path_from_a_real_shell() {
        let home = std::env::temp_dir().join(format!(
            "termloop-login-shell-{}-{}",
            std::process::id(),
            crate::generate_opaque_id()
        ));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            home.join(".profile"),
            "echo profile noise\nPATH=/termloop/login/bin:$PATH; export PATH\n",
        )
        .unwrap();
        let environment = LaunchEnvironment::allowlisted([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("HOME".into(), home.as_os_str().to_owned()),
            ("SHELL".into(), "/bin/sh".into()),
        ]);
        let started = std::time::Instant::now();
        let path = login_shell_path(&environment).expect("login shell PATH");
        assert!(started.elapsed() < std::time::Duration::from_secs(4));
        assert!(
            std::env::split_paths(&path)
                .any(|entry| entry == std::path::Path::new("/termloop/login/bin")),
            "{path:?}"
        );
        assert_eq!(
            login_shell_path(&LaunchEnvironment::allowlisted([(
                "HOME".into(),
                home.as_os_str().to_owned()
            )])),
            None
        );
        std::fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn reconstructed_path_resolves_standard_user_installs() {
        use crate::current_epoch_ms;
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let home = std::env::temp_dir().join(format!(
            "termloop-user-path-{}-{}",
            std::process::id(),
            current_epoch_ms()
        ));
        let bin = home.join(".local/bin");
        fs::create_dir_all(&bin).unwrap();
        let executable = bin.join("termloop-user-tool");
        fs::write(&executable, b"#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();

        let environment = LaunchEnvironment::baseline_from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("HOME".into(), home.as_os_str().to_owned()),
        ]);
        let mut command = Command::new("termloop-user-tool");
        apply_launch_environment(&mut command, &environment);
        assert!(command.status().unwrap().success());

        let _ = fs::remove_dir_all(home);
    }
}
