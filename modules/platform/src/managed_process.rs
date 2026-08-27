use std::fs as std_fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use crate::env::apply_launch_environment;
use crate::process_tree::SignalDelivery;
use crate::{LaunchEnvironment, PlatformError};

pub struct ManagedProcess {
    child: Child,
    record_path: Option<PathBuf>,
    /// Windows job-object containment for the child tree; held for the
    /// child's whole lifetime so `signal_process_tree(id, Kill)` terminates
    /// the registered job. No equivalent is needed on unix, where
    /// `process_group(0)` at spawn scopes the tree.
    #[cfg(windows)]
    _tree_guard: Option<crate::ProcessTreeGuard>,
}

pub struct TrackedProcessLease {
    path: Option<PathBuf>,
}

impl Drop for TrackedProcessLease {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = remove_if_present(&path);
        }
    }
}

pub struct DaemonInstanceLease {
    _record: TrackedProcessLease,
}

impl ManagedProcess {
    pub fn id(&self) -> u32 {
        self.child.id()
    }

    pub fn try_wait(&mut self) -> Result<Option<std::process::ExitStatus>, PlatformError> {
        Ok(self.child.try_wait()?)
    }

    pub fn terminate(&mut self) -> Result<(), PlatformError> {
        let process_id = self.child.id();
        if self.child.try_wait()?.is_some() && !process_tree_is_running(process_id)? {
            self.remove_record()?;
            return Ok(());
        }
        let delivery = signal_process_tree(process_id, ProcessTreeSignal::Terminate)?;
        if delivery == SignalDelivery::Delivered {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            while std::time::Instant::now() < deadline {
                let _ = self.child.try_wait()?;
                if !process_tree_is_running(process_id)? {
                    self.remove_record()?;
                    return Ok(());
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
        signal_process_tree(process_id, ProcessTreeSignal::Kill)?;
        let _ = self.child.wait()?;
        if !wait_for_process_tree_exit(process_id, std::time::Duration::from_secs(1))? {
            return Err(PlatformError::ProcessOwnershipUncertain);
        }
        self.remove_record()?;
        Ok(())
    }

    fn remove_record(&mut self) -> Result<(), PlatformError> {
        if let Some(path) = self.record_path.take()
            && let Err(error) = std_fs::remove_file(path)
            && error.kind() != io::ErrorKind::NotFound
        {
            return Err(error.into());
        }
        Ok(())
    }
}

impl Drop for ManagedProcess {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

pub fn spawn_managed_process(
    program: &str,
    args: &[String],
    cwd: &Path,
) -> Result<ManagedProcess, PlatformError> {
    spawn_managed_process_inner(program, args, cwd, None, &LaunchEnvironment::os_baseline())
}

pub fn spawn_tracked_managed_process(
    program: &str,
    args: &[String],
    cwd: &Path,
    registry_directory: &Path,
    record_id: &str,
) -> Result<ManagedProcess, PlatformError> {
    validate_process_record_id(record_id)?;
    let record_path = registry_directory.join(format!("{record_id}.process"));
    spawn_managed_process_inner(
        program,
        args,
        cwd,
        Some(record_path),
        &LaunchEnvironment::os_baseline(),
    )
}

pub fn spawn_resolved_tracked_managed_process(
    executable: &crate::ResolvedExecutable,
    args: &[String],
    cwd: &Path,
    registry_directory: &Path,
    record_id: &str,
    environment: &LaunchEnvironment,
) -> Result<ManagedProcess, PlatformError> {
    executable.revalidate()?;
    let program = executable
        .path()
        .to_str()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "executable path is invalid"))?;
    spawn_tracked_managed_process_with_environment(
        program,
        args,
        cwd,
        registry_directory,
        record_id,
        environment,
    )
}

pub fn spawn_tracked_managed_process_with_environment(
    program: &str,
    args: &[String],
    cwd: &Path,
    registry_directory: &Path,
    record_id: &str,
    environment: &LaunchEnvironment,
) -> Result<ManagedProcess, PlatformError> {
    validate_process_record_id(record_id)?;
    let record_path = registry_directory.join(format!("{record_id}.process"));
    spawn_managed_process_inner(program, args, cwd, Some(record_path), environment)
}

pub(super) fn spawn_managed_process_inner(
    program: &str,
    args: &[String],
    cwd: &Path,
    record_path: Option<PathBuf>,
    environment: &LaunchEnvironment,
) -> Result<ManagedProcess, PlatformError> {
    let mut command = Command::new(program);
    apply_launch_environment(&mut command, environment);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let child = command.spawn()?;
    let mut process = ManagedProcess {
        child,
        record_path: None,
        #[cfg(windows)]
        _tree_guard: None,
    };
    #[cfg(windows)]
    {
        // Contain the child tree in a kill-on-close job before anything else
        // can observe it, so tree termination and daemon-death cleanup are
        // sound. An already-exited child yields an inert guard.
        match crate::process_tree::contain_spawned_child(&process.child) {
            Ok(guard) => process._tree_guard = Some(guard),
            Err(error) => return Err(cleanup_failed_spawn(&mut process, error)),
        }
    }
    if let Some(record_path) = record_path {
        let identity = match process_identity(process.child.id()) {
            Ok(Some(identity)) => identity,
            Ok(None) => {
                let error = io::Error::new(
                    io::ErrorKind::NotFound,
                    "spawned process identity was unavailable",
                );
                return Err(cleanup_failed_spawn(&mut process, error.into()));
            }
            Err(error) => return Err(cleanup_failed_spawn(&mut process, error)),
        };
        if let Err(error) =
            create_tracked_process_record(&record_path, process.child.id(), &identity)
        {
            return Err(cleanup_failed_spawn(&mut process, error));
        }
        process.record_path = Some(record_path);
    }
    Ok(process)
}

fn cleanup_failed_spawn(process: &mut ManagedProcess, original: PlatformError) -> PlatformError {
    if process.terminate().is_ok() {
        original
    } else {
        PlatformError::ProcessOwnershipUncertain
    }
}

pub fn register_existing_tracked_process(
    registry_directory: &Path,
    record_id: &str,
    process_id: u32,
) -> Result<TrackedProcessLease, PlatformError> {
    validate_process_record_id(record_id)?;
    let identity = process_identity(process_id)?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "spawned process identity was unavailable",
        )
    })?;
    let path = registry_directory.join(format!("{record_id}.process"));
    create_tracked_process_record(&path, process_id, &identity)?;
    Ok(TrackedProcessLease { path: Some(path) })
}

pub fn acquire_daemon_instance_lease(
    runtime_directory: &Path,
) -> Result<DaemonInstanceLease, PlatformError> {
    let lease_directory = runtime_directory.join("daemon-owner");
    std_fs::create_dir_all(&lease_directory)?;
    let path = lease_directory.join("current.process");
    if path.exists() {
        let record = read_tracked_process_record(path.clone())?.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::AlreadyExists,
                "daemon ownership record is invalid; refusing duplicate startup",
            )
        })?;
        if process_identity(record.process_id)?.as_deref() == Some(record.identity.as_str()) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "another TermLoop daemon owns the runtime directory",
            )
            .into());
        }
        remove_if_present(&path)?;
    }
    let identity = process_identity(std::process::id())?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "current daemon process identity was unavailable",
        )
    })?;
    create_tracked_process_record(&path, std::process::id(), &identity)?;
    Ok(DaemonInstanceLease {
        _record: TrackedProcessLease { path: Some(path) },
    })
}

pub(super) fn validate_process_record_id(record_id: &str) -> Result<(), PlatformError> {
    if record_id.is_empty()
        || !record_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(
            io::Error::new(io::ErrorKind::InvalidInput, "invalid process record id").into(),
        );
    }
    Ok(())
}

fn create_tracked_process_record(
    path: &Path,
    process_id: u32,
    identity: &str,
) -> Result<(), PlatformError> {
    create_tracked_process_record_with(path, process_id, identity, |file, record| {
        io::Write::write_all(file, record)?;
        file.sync_all()
    })
}

pub(super) fn create_tracked_process_record_with(
    path: &Path,
    process_id: u32,
    identity: &str,
    write_record: impl FnOnce(&mut std_fs::File, &[u8]) -> io::Result<()>,
) -> Result<(), PlatformError> {
    let parent = path
        .parent()
        .ok_or(PlatformError::RuntimeDirectoryUnavailable)?;
    std_fs::create_dir_all(parent)?;
    let record = format!("v1\n{process_id}\n{identity}\n");
    let mut options = std_fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        std_fs::set_permissions(parent, std_fs::Permissions::from_mode(0o700))?;
        options.mode(0o600);
    }
    #[cfg(windows)]
    crate::fs::harden_private_directory(parent)?;
    let mut file = options.open(path)?;
    #[cfg(windows)]
    if let Err(error) = crate::fs::harden_private_file(path) {
        drop(file);
        if let Err(removal_error) = std_fs::remove_file(path)
            && removal_error.kind() != io::ErrorKind::NotFound
        {
            return Err(PlatformError::ProcessOwnershipUncertain);
        }
        return Err(error);
    }
    if let Err(error) = write_record(&mut file, record.as_bytes()) {
        drop(file);
        if let Err(removal_error) = std_fs::remove_file(path)
            && removal_error.kind() != io::ErrorKind::NotFound
        {
            return Err(PlatformError::ProcessOwnershipUncertain);
        }
        return Err(error.into());
    }
    Ok(())
}

pub(super) fn write_tracked_process_record(
    path: &Path,
    process_id: u32,
) -> Result<(), PlatformError> {
    let identity = process_identity(process_id)?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "spawned process identity was unavailable",
        )
    })?;
    create_tracked_process_record(path, process_id, &identity)
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ManagedProcessRecovery {
    pub terminated: usize,
    pub stale_records: usize,
    pub failures: usize,
    pub uncertain_record_ids: Vec<String>,
    pub unscoped_failures: usize,
}

#[derive(Debug)]
struct TrackedProcessRecord {
    path: PathBuf,
    process_id: u32,
    identity: String,
}

pub fn reap_tracked_managed_processes(
    registry_directory: &Path,
) -> Result<ManagedProcessRecovery, PlatformError> {
    std_fs::create_dir_all(registry_directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std_fs::set_permissions(registry_directory, std_fs::Permissions::from_mode(0o700))?;
    }

    let mut report = ManagedProcessRecovery::default();
    let mut live = Vec::new();
    let entries = match std_fs::read_dir(registry_directory) {
        Ok(entries) => entries,
        Err(_) => {
            report.failures = 1;
            report.unscoped_failures = 1;
            return Ok(report);
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                report.failures += 1;
                report.unscoped_failures += 1;
                continue;
            }
        };
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("process") {
            continue;
        }
        let record = match read_tracked_process_record(path.clone()) {
            Ok(Some(record)) => record,
            Ok(None) => {
                // A malformed record may have been torn after a child was
                // spawned. Its PID is not authority, so neither signal nor
                // deletion is safe; bind the uncertainty to its record id.
                report.failures += 1;
                push_uncertain_record_id(&mut report, &path);
                continue;
            }
            Err(_) => {
                // Never signal a PID parsed from a corrupt or unreadable record.
                report.failures += 1;
                push_uncertain_record_id(&mut report, &path);
                continue;
            }
        };
        match tracked_process_state(&record) {
            Err(_) => {
                report.failures += 1;
                push_uncertain_record_id(&mut report, &record.path);
            }
            Ok(TrackedProcessState::OwnedTreeRunning) => live.push(record),
            Ok(TrackedProcessState::Stale) => {
                report.stale_records += 1;
                if remove_if_present(&record.path).is_err() {
                    report.failures += 1;
                    push_uncertain_record_id(&mut report, &record.path);
                }
            }
        }
    }

    let mut remaining = Vec::new();
    let mut graceful_signalled = false;
    for record in live {
        if !matches!(
            signal_process_tree(record.process_id, ProcessTreeSignal::Terminate),
            Ok(SignalDelivery::GracefulUnsupported)
        ) {
            graceful_signalled = true;
        }
        remaining.push(record);
    }
    if graceful_signalled {
        report.terminated += wait_for_tracked_processes(
            &mut remaining,
            std::time::Duration::from_secs(2),
            &mut report,
        );
    }
    for record in &remaining {
        let _ = signal_process_tree(record.process_id, ProcessTreeSignal::Kill);
    }
    report.terminated += wait_for_tracked_processes(
        &mut remaining,
        std::time::Duration::from_secs(2),
        &mut report,
    );

    for record in remaining {
        report.failures += 1;
        push_uncertain_record_id(&mut report, &record.path);
    }
    Ok(report)
}

pub fn recover_tracked_managed_process(
    registry_directory: &Path,
    record_id: &str,
) -> Result<ManagedProcessRecovery, PlatformError> {
    validate_process_record_id(record_id)?;
    std_fs::create_dir_all(registry_directory)?;
    let path = registry_directory.join(format!("{record_id}.process"));
    if !path.exists() {
        return Ok(ManagedProcessRecovery::default());
    }
    let mut report = ManagedProcessRecovery::default();
    let Some(record) = read_tracked_process_record(path.clone())? else {
        report.failures = 1;
        push_uncertain_record_id(&mut report, &path);
        return Ok(report);
    };
    match tracked_process_state(&record) {
        Err(_) => {
            report.failures = 1;
            push_uncertain_record_id(&mut report, &record.path);
        }
        Ok(TrackedProcessState::OwnedTreeRunning) => {
            let mut remaining = vec![record];
            if !matches!(
                signal_process_tree(remaining[0].process_id, ProcessTreeSignal::Terminate),
                Ok(SignalDelivery::GracefulUnsupported)
            ) {
                report.terminated += wait_for_tracked_processes(
                    &mut remaining,
                    std::time::Duration::from_secs(2),
                    &mut report,
                );
            }
            if let Some(record) = remaining.first() {
                let _ = signal_process_tree(record.process_id, ProcessTreeSignal::Kill);
            }
            report.terminated += wait_for_tracked_processes(
                &mut remaining,
                std::time::Duration::from_secs(2),
                &mut report,
            );
            if let Some(record) = remaining.first() {
                report.failures += 1;
                push_uncertain_record_id(&mut report, &record.path);
            }
        }
        Ok(TrackedProcessState::Stale) => {
            remove_if_present(&record.path)?;
            report.stale_records = 1;
        }
    }
    Ok(report)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrackedProcessState {
    OwnedTreeRunning,
    Stale,
}

fn tracked_process_state(
    record: &TrackedProcessRecord,
) -> Result<TrackedProcessState, PlatformError> {
    match process_identity(record.process_id)? {
        Some(identity) if identity == record.identity => Ok(TrackedProcessState::OwnedTreeRunning),
        Some(_) => Ok(TrackedProcessState::Stale),
        None if process_tree_is_running(record.process_id)? => {
            // On Unix a process group survives its leader. The group id cannot
            // be reused as a new PID while descendants still occupy the group,
            // so this remains the exact tree named by the private record.
            Ok(TrackedProcessState::OwnedTreeRunning)
        }
        None => Ok(TrackedProcessState::Stale),
    }
}

fn push_uncertain_record_id(report: &mut ManagedProcessRecovery, path: &Path) {
    let Some(id) = path.file_stem().and_then(|value| value.to_str()) else {
        report.unscoped_failures += 1;
        return;
    };
    if validate_process_record_id(id).is_err() {
        report.unscoped_failures += 1;
        return;
    }
    if !report.uncertain_record_ids.iter().any(|value| value == id) {
        report.uncertain_record_ids.push(id.to_owned());
    }
}

fn wait_for_tracked_processes(
    records: &mut Vec<TrackedProcessRecord>,
    timeout: std::time::Duration,
    report: &mut ManagedProcessRecovery,
) -> usize {
    let deadline = std::time::Instant::now() + timeout;
    let mut terminated = 0;
    loop {
        let mut index = 0;
        while index < records.len() {
            let record = &records[index];
            match process_tree_is_running(record.process_id) {
                Ok(true) => index += 1,
                Ok(false) => {
                    let record = records.swap_remove(index);
                    terminated += 1;
                    if remove_if_present(&record.path).is_err() {
                        report.failures += 1;
                        push_uncertain_record_id(report, &record.path);
                    }
                }
                Err(_) => {
                    let record = records.swap_remove(index);
                    report.failures += 1;
                    push_uncertain_record_id(report, &record.path);
                }
            }
        }
        if records.is_empty() || std::time::Instant::now() >= deadline {
            return terminated;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// Reports whether the process group or containment root associated with a
/// TermLoop-owned process can still contain runnable descendants.
///
/// On Unix the group can outlive its leader, so checking only the recorded PID
/// is not sufficient proof that a provider writer has stopped. Windows trees
/// are kill-on-close Job Objects; after a daemon epoch the root identity is the
/// remaining recovery fact and closing the old daemon's job has already killed
/// its descendants.
pub fn process_tree_is_running(process_id: u32) -> Result<bool, PlatformError> {
    #[cfg(unix)]
    {
        // SAFETY: kill(2) with signal 0 performs a permission/existence probe
        // and has no pointer arguments. A negative PID addresses the process
        // group created for every managed or PTY launch.
        #[allow(unsafe_code)]
        let result = unsafe { libc::kill(-(process_id as i32), 0) };
        if result == 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ESRCH) => Ok(false),
            Some(libc::EPERM) => Ok(true),
            _ => Err(error.into()),
        }
    }
    #[cfg(windows)]
    {
        process_identity(process_id).map(|identity| identity.is_some())
    }
    #[cfg(not(any(unix, windows)))]
    {
        process_identity(process_id).map(|identity| identity.is_some())
    }
}

pub fn wait_for_process_tree_exit(
    process_id: u32,
    timeout: std::time::Duration,
) -> Result<bool, PlatformError> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if !process_tree_is_running(process_id)? {
            return Ok(true);
        }
        if std::time::Instant::now() >= deadline {
            return Ok(false);
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

fn read_tracked_process_record(
    path: PathBuf,
) -> Result<Option<TrackedProcessRecord>, PlatformError> {
    let value = std_fs::read_to_string(&path)?;
    if value.len() > 4096 {
        return Ok(None);
    }
    let mut lines = value.lines();
    if lines.next() != Some("v1") {
        return Ok(None);
    }
    let Some(process_id) = lines.next().and_then(|value| value.parse::<u32>().ok()) else {
        return Ok(None);
    };
    let Some(identity) = lines.next().filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    Ok(Some(TrackedProcessRecord {
        path,
        process_id,
        identity: identity.to_owned(),
    }))
}

pub(super) fn remove_if_present(path: &Path) -> Result<(), PlatformError> {
    match std_fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(target_os = "linux")]
pub(super) fn process_identity(process_id: u32) -> Result<Option<String>, PlatformError> {
    let path = PathBuf::from(format!("/proc/{process_id}/stat"));
    let value = match std_fs::read_to_string(path) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let Some(after_name) = value.rsplit_once(')').map(|(_, suffix)| suffix.trim()) else {
        return Ok(None);
    };
    let fields: Vec<_> = after_name.split_whitespace().collect();
    if fields.first() == Some(&"Z") {
        return Ok(None);
    }
    Ok(fields.get(19).map(|start| format!("linux:{start}")))
}

#[cfg(all(unix, not(target_os = "linux")))]
pub(super) fn process_identity(process_id: u32) -> Result<Option<String>, PlatformError> {
    let mut command = Command::new("ps");
    command.args([
        "-p",
        &process_id.to_string(),
        "-o",
        "state=",
        "-o",
        "lstart=",
    ]);
    apply_launch_environment(&mut command, &LaunchEnvironment::os_baseline());
    let output = command.output()?;
    if !output.status.success() {
        return Ok(None);
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if value.starts_with('Z') {
        return Ok(None);
    }
    Ok(value
        .split_once(char::is_whitespace)
        .map(|(_, start)| start.trim())
        .filter(|start| !start.is_empty())
        .map(|start| format!("unix:{start}")))
}

#[cfg(windows)]
#[allow(unsafe_code)]
pub(super) fn process_identity(process_id: u32) -> Result<Option<String>, PlatformError> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // SAFETY: The handle comes from OpenProcess for this PID, every FILETIME
    // output points to initialized stack storage for the duration of the call,
    // and the non-null handle is closed exactly once on every path.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if handle.is_null() {
        let error = io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(87 | 1168) => Ok(None),
            _ => Err(error.into()),
        };
    }
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    let result =
        unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
    let close_result = unsafe { CloseHandle(handle) };
    if result == 0 {
        return Err(io::Error::last_os_error().into());
    }
    if close_result == 0 {
        return Err(io::Error::last_os_error().into());
    }
    // Windows keeps an exited process object queryable while any process
    // handle remains open (ConPTY does this until its child wrapper drops).
    // A non-zero exit time proves the process is no longer runnable, so do
    // not mistake that retained kernel object for a live process tree.
    if exit.dwHighDateTime != 0 || exit.dwLowDateTime != 0 {
        return Ok(None);
    }
    let identity = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    Ok(Some(format!("windows:{identity}")))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessTreeSignal {
    Hangup,
    Terminate,
    Kill,
}

/// Signals a spawned process tree and reports the typed delivery fact.
///
/// Already-exited trees are success on every platform (unix `ESRCH`,
/// Windows released-PID/exited-process tolerance). On Windows there is no
/// reliable graceful cross-console signal a consoleless daemon can deliver,
/// so `Hangup` and `Terminate` return [`SignalDelivery::GracefulUnsupported`]
/// without touching the target, and `Kill` terminates the registered
/// containment job (falling back to the single root process when no guard or
/// job is known for the PID).
pub fn signal_process_tree(
    process_id: u32,
    signal: ProcessTreeSignal,
) -> Result<SignalDelivery, PlatformError> {
    #[cfg(unix)]
    {
        // portable-pty creates the child with setsid(), so its pid is also the
        // process-group id. A negative pid targets the entire group.
        let unix_signal = match signal {
            ProcessTreeSignal::Hangup => libc::SIGHUP,
            ProcessTreeSignal::Terminate => libc::SIGTERM,
            ProcessTreeSignal::Kill => libc::SIGKILL,
        };
        // SAFETY: kill(2) has no pointer arguments or preconditions; the
        // negated pid and signal number are plain integers and the result is
        // checked below.
        #[allow(unsafe_code)]
        let result = unsafe { libc::kill(-(process_id as i32), unix_signal) };
        if result != 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error.into());
            }
        }
        Ok(SignalDelivery::Delivered)
    }
    #[cfg(windows)]
    {
        crate::process_tree::signal_windows_process_tree(process_id, signal)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (process_id, signal);
        Ok(SignalDelivery::Delivered)
    }
}
