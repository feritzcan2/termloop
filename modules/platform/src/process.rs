use std::ffi::{OsStr, OsString};
use std::io;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::env::apply_launch_environment;
use crate::managed_process::{
    remove_if_present, signal_process_tree, validate_process_record_id,
    write_tracked_process_record,
};
use crate::{LaunchEnvironment, PlatformError, ProcessTreeSignal, SignalDelivery};

#[derive(Clone, PartialEq, Eq)]
pub struct ResolvedExecutable {
    path: PathBuf,
    identity: ExecutableIdentity,
}

#[derive(Clone, PartialEq, Eq)]
struct ExecutableIdentity {
    length: u64,
    modified: Option<std::time::SystemTime>,
    content_sha256: [u8; 32],
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

impl std::fmt::Debug for ResolvedExecutable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ResolvedExecutable")
            .field("path_present", &true)
            .finish()
    }
}

impl ResolvedExecutable {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn revalidate(&self) -> Result<(), PlatformError> {
        let current = resolved_executable_from_path(&self.path)?;
        if current != *self {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "executable identity changed after capability discovery",
            )
            .into());
        }
        Ok(())
    }
}

pub(crate) fn validate_executable_name(name: &str) -> Result<(), PlatformError> {
    if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_'))
    {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid executable name").into());
    }
    Ok(())
}

pub fn resolve_executable(name: &str) -> Result<ResolvedExecutable, PlatformError> {
    validate_executable_name(name)?;
    let environment = LaunchEnvironment::os_baseline();
    let path = environment
        .entries()
        .find(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case("PATH"))
        .map(|(_, value)| value)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "executable PATH unavailable"))?;
    let names = executable_candidate_names(name);
    for directory in std::env::split_paths(path) {
        for candidate_name in &names {
            let candidate = directory.join(candidate_name);
            if let Ok(executable) = resolved_executable_from_path(&candidate) {
                return Ok(executable);
            }
        }
    }
    Err(io::Error::new(io::ErrorKind::NotFound, "executable unavailable").into())
}

/// Resolves the exact running TermLoop process image for internal child modes.
/// Callers cannot substitute another executable path.
pub fn current_executable() -> Result<ResolvedExecutable, PlatformError> {
    resolved_executable_from_path(&std::env::current_exe()?)
}

/// Resolves a native executable installed beside the exact current TermLoop
/// image. The name is a closed composition input, never a user-provided path.
pub fn sibling_executable(name: &str) -> Result<ResolvedExecutable, PlatformError> {
    validate_executable_name(name)?;
    let current = std::env::current_exe()?;
    let parent = current.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "current executable parent unavailable",
        )
    })?;
    resolved_executable_from_path(&parent.join(format!("{name}{}", std::env::consts::EXE_SUFFIX)))
}

fn executable_candidate_names(name: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        [".exe", ".com", ".cmd", ".bat"]
            .into_iter()
            .map(|extension| format!("{name}{extension}"))
            .collect()
    }
    #[cfg(not(windows))]
    {
        vec![name.to_owned()]
    }
}

pub(crate) fn resolved_executable_from_path(
    path: &Path,
) -> Result<ResolvedExecutable, PlatformError> {
    let path = std::fs::canonicalize(path)?;
    let mut file = std::fs::File::open(&path)?;
    resolved_executable_from_file(path, &mut file)
}

fn resolved_executable_from_file(
    path: PathBuf,
    file: &mut std::fs::File,
) -> Result<ResolvedExecutable, PlatformError> {
    use sha2::{Digest, Sha256};

    let metadata = file.metadata()?;
    if !metadata.is_file() || !executable_mode_is_eligible(&metadata) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "executable is not eligible",
        )
        .into());
    }
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut first_chunk = true;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        if first_chunk {
            if !native_executable_header_is_supported(&buffer[..count]) {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "native executable is a script or unsupported wrapper",
                )
                .into());
            }
            first_chunk = false;
        }
        digest.update(&buffer[..count]);
    }
    Ok(ResolvedExecutable {
        path,
        identity: ExecutableIdentity {
            length: metadata.len(),
            modified: metadata.modified().ok(),
            content_sha256: digest.finalize().into(),
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
        },
    })
}

pub(crate) fn native_executable_header_is_supported(bytes: &[u8]) -> bool {
    #[cfg(target_os = "macos")]
    {
        bytes.starts_with(&[0xcf, 0xfa, 0xed, 0xfe])
            || bytes.starts_with(&[0xfe, 0xed, 0xfa, 0xcf])
            || bytes.starts_with(&[0xca, 0xfe, 0xba, 0xbe])
            || bytes.starts_with(&[0xbe, 0xba, 0xfe, 0xca])
    }
    #[cfg(target_os = "linux")]
    {
        bytes.starts_with(b"\x7fELF")
    }
    #[cfg(windows)]
    {
        bytes.starts_with(b"MZ")
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        let _ = bytes;
        false
    }
}

pub(crate) fn executable_mode_is_eligible(metadata: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(windows)]
    {
        let _ = metadata;
        true
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandProbe {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct CommandRequest {
    program: OsString,
    args: Vec<OsString>,
    cwd: Option<PathBuf>,
    environment_delta: Vec<(OsString, Option<OsString>)>,
    stdin: Option<Vec<u8>>,
    process_record: Option<(PathBuf, String)>,
    launch_environment: LaunchEnvironment,
    timeout: Duration,
    output_limit: usize,
}

impl std::fmt::Debug for CommandRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CommandRequest")
            .field("program", &"<redacted>")
            .field("argument_count", &self.args.len())
            .field("cwd", &self.cwd.as_ref().map(|_| "<redacted>"))
            .field("environment_delta_count", &self.environment_delta.len())
            .field("stdin_bytes", &self.stdin.as_ref().map_or(0, Vec::len))
            .field("tracked", &self.process_record.is_some())
            .field("timeout", &self.timeout)
            .field("output_limit", &self.output_limit)
            .finish()
    }
}

impl CommandRequest {
    pub fn new(program: impl Into<OsString>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            environment_delta: Vec::new(),
            stdin: None,
            process_record: None,
            launch_environment: LaunchEnvironment::os_baseline(),
            timeout: Duration::from_secs(30),
            output_limit: 8 * 1024 * 1024,
        }
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    pub fn environment(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.environment_delta
            .push((key.into(), Some(value.into())));
        self
    }

    pub fn remove_environment(mut self, key: impl Into<OsString>) -> Self {
        self.environment_delta.push((key.into(), None));
        self
    }

    pub fn stdin(mut self, stdin: Vec<u8>) -> Self {
        self.stdin = Some(stdin);
        self
    }

    pub fn tracked(
        mut self,
        registry_directory: impl Into<PathBuf>,
        record_id: impl Into<String>,
    ) -> Self {
        self.process_record = Some((registry_directory.into(), record_id.into()));
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn output_limit(mut self, output_limit: usize) -> Self {
        self.output_limit = output_limit;
        self
    }

    pub fn launch_environment(mut self, launch_environment: LaunchEnvironment) -> Self {
        self.launch_environment = launch_environment;
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandTermination {
    Exited { code: i32 },
    Signaled { signal: Option<i32> },
    TimedOut,
}

#[derive(Clone, PartialEq, Eq)]
pub struct CommandOutcome {
    pub termination: CommandTermination,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

impl std::fmt::Debug for CommandOutcome {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CommandOutcome")
            .field("termination", &self.termination)
            .field("stdout_bytes", &self.stdout.len())
            .field("stderr_bytes", &self.stderr.len())
            .field("stdout_truncated", &self.stdout_truncated)
            .field("stderr_truncated", &self.stderr_truncated)
            .finish()
    }
}

impl CommandOutcome {
    pub fn success(&self) -> bool {
        self.termination == CommandTermination::Exited { code: 0 }
    }
}

pub fn probe_command(program: &str, args: &[&str]) -> Result<CommandProbe, PlatformError> {
    let mut command = std::process::Command::new(program);
    command.args(args);
    apply_launch_environment(&mut command, &LaunchEnvironment::os_baseline());
    let output = command.output()?;
    Ok(CommandProbe {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

pub fn run_command(request: CommandRequest) -> Result<CommandOutcome, PlatformError> {
    const MAX_STDIN_BYTES: usize = 128 * 1024;
    if request
        .stdin
        .as_ref()
        .is_some_and(|stdin| stdin.len() > MAX_STDIN_BYTES)
    {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "command stdin too large").into());
    }
    if let Some((_, record_id)) = &request.process_record {
        validate_process_record_id(record_id)?;
    }
    let deadline = Instant::now().checked_add(request.timeout).ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "command timeout is too large")
    })?;
    let mut command = Command::new(&request.program);
    apply_launch_environment(&mut command, &request.launch_environment);
    command
        .args(&request.args)
        .stdin(if request.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = &request.cwd {
        command.current_dir(cwd);
    }
    for (key, value) in &request.environment_delta {
        if let Some(value) = value {
            command.env(key, value);
        } else {
            command.env_remove(key);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = command.spawn()?;
    // Windows: contain the bounded command's tree in a kill-on-close job for
    // the child's whole lifetime, so timeout tree-kill reaches descendants and
    // daemon death cannot leak them. Unix relies on process_group(0) above.
    #[cfg(windows)]
    let _tree_guard = match crate::process_tree::contain_spawned_child(&child) {
        Ok(guard) => guard,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let record_path = if let Some((registry_directory, record_id)) = &request.process_record {
        let record_path = registry_directory.join(format!("{record_id}.process"));
        if let Err(error) = write_tracked_process_record(&record_path, child.id()) {
            let exited_before_identity = matches!(
                &error,
                PlatformError::Io(source) if source.kind() == io::ErrorKind::NotFound
            ) && child.try_wait()?.is_some();
            if exited_before_identity {
                None
            } else {
                let _ = signal_process_tree(child.id(), ProcessTreeSignal::Kill);
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        } else {
            Some(record_path)
        }
    } else {
        None
    };
    let stdin_writer = if let Some(stdin) = request.stdin {
        let mut pipe = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("command stdin pipe was unavailable"))?;
        Some(std::thread::spawn(move || {
            let result = pipe.write_all(&stdin);
            drop(pipe);
            result
        }))
    } else {
        None
    };
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("command stdout pipe was unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("command stderr pipe was unavailable"))?;
    let output_limit = request.output_limit;
    let (stdout_sender, stdout_receiver) = std::sync::mpsc::sync_channel(1);
    let (stderr_sender, stderr_receiver) = std::sync::mpsc::sync_channel(1);
    let stdout_reader = std::thread::spawn(move || {
        let _ = stdout_sender.send(read_bounded(stdout, output_limit));
    });
    let stderr_reader = std::thread::spawn(move || {
        let _ = stderr_sender.send(read_bounded(stderr, output_limit));
    });

    let process_id = child.id();
    let mut status = None;
    let mut stdout_result = None;
    let mut stderr_result = None;
    while Instant::now() < deadline {
        poll_command_state(
            &mut child,
            &mut status,
            &stdout_receiver,
            &mut stdout_result,
            &stderr_receiver,
            &mut stderr_result,
        )?;
        if status.is_some() && stdout_result.is_some() && stderr_result.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(1));
    }

    let timed_out = status.is_none() || stdout_result.is_none() || stderr_result.is_none();
    if timed_out {
        // A typed graceful-unsupported outcome means nothing was delivered;
        // skip the grace poll instead of waiting on a signal that never went
        // out. Unix delivery (and any delivery error) keeps the grace period.
        if !matches!(
            signal_process_tree(process_id, ProcessTreeSignal::Terminate),
            Ok(SignalDelivery::GracefulUnsupported)
        ) {
            let terminate_deadline = Instant::now() + Duration::from_millis(250);
            while Instant::now() < terminate_deadline {
                poll_command_state(
                    &mut child,
                    &mut status,
                    &stdout_receiver,
                    &mut stdout_result,
                    &stderr_receiver,
                    &mut stderr_result,
                )?;
                if status.is_some() && stdout_result.is_some() && stderr_result.is_some() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        let _ = signal_process_tree(process_id, ProcessTreeSignal::Kill);
        if status.is_none() {
            let _ = child.kill();
            status = Some(child.wait()?);
        }
        let drain_deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < drain_deadline
            && (stdout_result.is_none() || stderr_result.is_none())
        {
            poll_reader(&stdout_receiver, &mut stdout_result)?;
            poll_reader(&stderr_receiver, &mut stderr_result)?;
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    if stdout_reader.is_finished() {
        stdout_reader
            .join()
            .map_err(|_| io::Error::other("command stdout reader panicked"))?;
    }
    if stderr_reader.is_finished() {
        stderr_reader
            .join()
            .map_err(|_| io::Error::other("command stderr reader panicked"))?;
    }
    if let Some(writer) = stdin_writer {
        match writer
            .join()
            .map_err(|_| io::Error::other("command stdin writer panicked"))?
        {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {}
            Err(error) => return Err(error.into()),
        }
    }
    let (stdout, stdout_truncated) = finish_reader(stdout_result, timed_out)?;
    let (stderr, stderr_truncated) = finish_reader(stderr_result, timed_out)?;
    let termination = if timed_out {
        CommandTermination::TimedOut
    } else {
        command_termination(status.expect("completed command has an exit status"))
    };
    let outcome = CommandOutcome {
        termination,
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
    };
    if let Some(record_path) = record_path {
        remove_if_present(&record_path)?;
    }
    Ok(outcome)
}

type ReaderResult = Result<(Vec<u8>, bool), io::Error>;

fn poll_command_state(
    child: &mut Child,
    status: &mut Option<std::process::ExitStatus>,
    stdout_receiver: &std::sync::mpsc::Receiver<ReaderResult>,
    stdout_result: &mut Option<ReaderResult>,
    stderr_receiver: &std::sync::mpsc::Receiver<ReaderResult>,
    stderr_result: &mut Option<ReaderResult>,
) -> Result<(), PlatformError> {
    if status.is_none() {
        *status = child.try_wait()?;
    }
    poll_reader(stdout_receiver, stdout_result)?;
    poll_reader(stderr_receiver, stderr_result)?;
    Ok(())
}

fn poll_reader(
    receiver: &std::sync::mpsc::Receiver<ReaderResult>,
    result: &mut Option<ReaderResult>,
) -> Result<(), PlatformError> {
    if result.is_some() {
        return Ok(());
    }
    match receiver.try_recv() {
        Ok(value) => *result = Some(value),
        Err(std::sync::mpsc::TryRecvError::Empty) => {}
        Err(std::sync::mpsc::TryRecvError::Disconnected) => {
            return Err(io::Error::other("command output reader disconnected").into());
        }
    }
    Ok(())
}

fn finish_reader(
    result: Option<ReaderResult>,
    timed_out: bool,
) -> Result<(Vec<u8>, bool), PlatformError> {
    match result {
        Some(result) => result.map_err(Into::into),
        None if timed_out => Ok((Vec::new(), true)),
        None => Err(io::Error::other("command output was unavailable").into()),
    }
}

fn read_bounded(mut reader: impl Read, output_limit: usize) -> Result<(Vec<u8>, bool), io::Error> {
    let mut output = Vec::with_capacity(output_limit.min(64 * 1024));
    let mut truncated = false;
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            return Ok((output, truncated));
        }
        let remaining = output_limit.saturating_sub(output.len());
        let retained = remaining.min(count);
        output.extend_from_slice(&buffer[..retained]);
        truncated |= retained < count;
    }
}

fn command_termination(status: std::process::ExitStatus) -> CommandTermination {
    if let Some(code) = status.code() {
        return CommandTermination::Exited { code };
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        CommandTermination::Signaled {
            signal: status.signal(),
        }
    }
    #[cfg(not(unix))]
    {
        CommandTermination::Signaled { signal: None }
    }
}

pub fn os_string_from_process_bytes(bytes: Vec<u8>) -> Result<OsString, PlatformError> {
    if bytes.contains(&0) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "path contains a NUL byte").into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        Ok(OsString::from_vec(bytes))
    }
    #[cfg(windows)]
    {
        let value = String::from_utf8(bytes)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "path is not UTF-8"))?;
        Ok(OsString::from(value))
    }
}

pub fn path_from_process_bytes(bytes: Vec<u8>) -> Result<PathBuf, PlatformError> {
    os_string_from_process_bytes(bytes).map(PathBuf::from)
}

pub fn process_bytes_from_os_str(value: &OsStr) -> Result<Vec<u8>, PlatformError> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        Ok(value.as_bytes().to_vec())
    }
    #[cfg(windows)]
    {
        value
            .to_str()
            .map(str::as_bytes)
            .map(ToOwned::to_owned)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "path is not UTF-8").into())
    }
}
