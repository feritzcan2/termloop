use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

use crate::PlatformError;
use rand::RngCore;

/// Ends a daemon whose serialized durable-state owner has stopped making
/// progress. The external daemon supervisor starts a fresh process; graceful
/// shutdown cannot help because it would wait on the same lock.
pub fn terminate_for_unrecoverable_runtime_stall() -> ! {
    std::process::exit(70)
}

/// Generates a non-zero runtime generation fence exactly representable by
/// JavaScript clients. Callers compare epochs for equality, never ordering.
pub fn generate_runtime_epoch() -> u64 {
    u64::from(rand::random::<u32>()).max(1)
}

/// Generates a non-secret opaque identifier without exposing randomness to a
/// composition root. The fixed lowercase hexadecimal form is safe for current
/// state keys and never carries user/provider content.
pub fn generate_opaque_id() -> String {
    let bytes = rand::random::<[u8; 16]>();
    let mut encoded = String::with_capacity(32);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").expect("writing into a String cannot fail");
    }
    encoded
}

/// Generates an RFC 4122 UUID v4 string for provider surfaces that require
/// that exact syntax, while keeping randomness behind the platform boundary.
pub fn generate_uuid_v4() -> String {
    let mut bytes = rand::random::<[u8; 16]>();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

/// Generates a non-secret opaque one-time identifier for a runtime-scoped
/// capability record. Callers must still bind, expire, and consume the record.
pub fn generate_opaque_runtime_token() -> String {
    let bytes = rand::random::<[u8; 32]>();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Generates a runtime-only bearer suitable for a narrowly scoped local
/// capability. Callers must keep the value out of argv, persistence, and
/// diagnostics.
pub fn generate_capability_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut token, "{byte:02x}").expect("writing to a String cannot fail");
    }
    token
}

pub fn default_shell() -> (String, Vec<String>) {
    #[cfg(target_os = "windows")]
    {
        ("powershell.exe".to_owned(), vec!["-NoLogo".to_owned()])
    }
    #[cfg(not(target_os = "windows"))]
    {
        (
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned()),
            vec![],
        )
    }
}

/// Resolves a user-authored command line into the host shell's explicit
/// program/argv form. The command remains one argument; callers never splice
/// it into an outer command line.
pub fn shell_command(command: &str) -> (String, Vec<String>) {
    #[cfg(target_os = "windows")]
    {
        (
            "powershell.exe".to_owned(),
            vec![
                "-NoLogo".to_owned(),
                "-Command".to_owned(),
                command.to_owned(),
            ],
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        (
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned()),
            vec!["-lc".to_owned(), command.to_owned()],
        )
    }
}

/// Renders an exact executable invocation for command-hook providers that use
/// PowerShell on Windows and a POSIX shell elsewhere. The provider owns the
/// shell choice; platform owns host-specific quoting.
pub fn powershell_or_posix_hook_command(executable: &Path, args: &[&str]) -> String {
    #[cfg(windows)]
    {
        render_powershell_hook_command(executable, args)
    }
    #[cfg(not(windows))]
    {
        render_posix_hook_command(executable, args)
    }
}

#[cfg(any(windows, test))]
fn render_powershell_hook_command(executable: &Path, args: &[&str]) -> String {
    let quote = |value: &str| format!("'{}'", value.replace('\'', "''"));
    std::iter::once(format!("& {}", quote(&executable.to_string_lossy())))
        .chain(args.iter().map(|arg| quote(arg)))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(any(not(windows), test))]
fn render_posix_hook_command(executable: &Path, args: &[&str]) -> String {
    let quote = |value: &str| format!("'{}'", value.replace('\'', "'\"'\"'"));
    std::iter::once(quote(&executable.to_string_lossy()))
        .chain(args.iter().map(|arg| quote(arg)))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Composes setup and primary commands while emitting an invisible terminal
/// marker only after setup succeeds. The runtime uses the marker to persist
/// once-per-worktree completion without treating process spawn as completion.
pub fn shell_command_with_setup_marker(
    setup: &str,
    command: &str,
    marker: &str,
) -> (String, Vec<String>) {
    #[cfg(target_os = "windows")]
    let chained = format!(
        "$ErrorActionPreference = 'Stop'; {setup}; if ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}; [Console]::Write(([char]27) + ']777;termloop-run-setup={marker}' + ([char]7)); {command}"
    );
    #[cfg(not(target_os = "windows"))]
    let chained =
        format!("{setup} && printf '\\033]777;termloop-run-setup={marker}\\007' && {command}");
    shell_command(&chained)
}

#[derive(Debug, Clone, Copy)]
pub struct MonotonicDeadline {
    deadline: Instant,
}

impl MonotonicDeadline {
    pub fn after(duration: Duration) -> Result<Self, PlatformError> {
        let deadline = Instant::now().checked_add(duration).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "deadline duration is too large",
            )
        })?;
        Ok(Self { deadline })
    }

    pub fn remaining(self) -> Option<Duration> {
        self.deadline.checked_duration_since(Instant::now())
    }
}

pub fn current_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

pub fn reserve_loopback_port() -> Result<u16, PlatformError> {
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    Ok(listener.local_addr()?.port())
}

pub async fn wait_for_daemon_shutdown_signal() {
    #[cfg(unix)]
    {
        let terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate());
        match terminate {
            Ok(mut terminate) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = terminate.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(windows)]
    {
        use tokio::signal::windows;
        // Console close and OS shutdown must reach the daemon like Ctrl-C so
        // teardown (job-object cleanup included) runs instead of being killed
        // mid-flight. Registration failure falls back to plain Ctrl-C.
        match (
            windows::ctrl_c(),
            windows::ctrl_break(),
            windows::ctrl_close(),
            windows::ctrl_shutdown(),
        ) {
            (Ok(mut ctrl_c), Ok(mut ctrl_break), Ok(mut ctrl_close), Ok(mut ctrl_shutdown)) => {
                tokio::select! {
                    _ = ctrl_c.recv() => {}
                    _ = ctrl_break.recv() => {}
                    _ = ctrl_close.recv() => {}
                    _ = ctrl_shutdown.recv() => {}
                }
            }
            _ => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monotonic_deadline_reports_a_bounded_remaining_duration() {
        let requested = Duration::from_millis(100);
        let deadline = MonotonicDeadline::after(requested).unwrap();
        assert!(deadline.remaining().is_some_and(|value| value <= requested));
        let expired = MonotonicDeadline::after(Duration::ZERO).unwrap();
        assert!(expired.remaining().is_none_or(|value| value.is_zero()));
    }

    #[test]
    fn shell_command_keeps_user_content_in_one_argument() {
        let (program, args) = shell_command("printf '%s' hello");
        assert!(!program.is_empty());
        assert_eq!(args.last().map(String::as_str), Some("printf '%s' hello"));
    }

    #[test]
    fn command_hook_renderers_quote_executable_paths_and_arguments_for_each_shell() {
        let executable = Path::new(r"C:\Program Files\TermLoop's\termloop-server.exe");
        assert_eq!(
            render_powershell_hook_command(executable, &["hook", "it's-safe"]),
            r"& 'C:\Program Files\TermLoop''s\termloop-server.exe' 'hook' 'it''s-safe'"
        );
        assert_eq!(
            render_posix_hook_command(Path::new("/Applications/TermLoop's/server"), &["hook"]),
            "'/Applications/TermLoop'\"'\"'s/server' 'hook'"
        );
    }

    #[cfg(windows)]
    #[test]
    fn powershell_hook_command_executes_through_the_native_call_operator() {
        let command =
            render_powershell_hook_command(Path::new("cmd.exe"), &["/d", "/c", "exit", "0"]);
        let status = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &command])
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[test]
    fn setup_marker_is_emitted_only_between_successful_setup_and_command() {
        let (_program, args) = shell_command_with_setup_marker("prepare", "serve", "abc123");
        let command = args.last().unwrap();
        assert!(command.find("prepare").unwrap() < command.find("abc123").unwrap());
        assert!(command.find("abc123").unwrap() < command.rfind("serve").unwrap());
        assert!(command.contains("termloop-run-setup="));
    }

    #[test]
    fn opaque_ids_are_fixed_safe_and_distinct() {
        let first = generate_opaque_id();
        let second = generate_opaque_id();
        assert_eq!(first.len(), 32);
        assert!(
            first
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        );
        assert_ne!(first, second);
    }

    #[test]
    fn provider_uuid_is_lowercase_v4_with_rfc_variant() {
        let value = generate_uuid_v4();
        let parsed = uuid::Uuid::parse_str(&value).unwrap();
        assert_eq!(parsed.get_version_num(), 4);
        assert_eq!(parsed.get_variant(), uuid::Variant::RFC4122);
        assert_eq!(parsed.hyphenated().to_string(), value);
    }

    #[test]
    fn capability_tokens_are_fixed_width_and_fresh() {
        let first = generate_capability_token();
        let second = generate_capability_token();
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }
}
