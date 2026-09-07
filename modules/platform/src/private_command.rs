//! Bounded, non-PTY dialogue with a private child. Output is never logged.
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::{Duration, Instant};

use crate::{LaunchEnvironment, PlatformError};

pub struct PrivateCommandRequest {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    pub environment: LaunchEnvironment,
    pub timeout: Duration,
    pub output_limit: usize,
    pub record_path: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PrivateCommandExit {
    Exited(bool),
    Cancelled,
    TimedOut,
    OutputLimit,
}

/// A failed cleanup returns the owned handle to its caller. The caller must
/// retain it and keep the operation reserved until recovery, not start a
/// replacement child while the original tree's ownership is uncertain.
pub struct PrivateCommandFailure {
    unreaped: Option<crate::ManagedProcess>,
}

impl PrivateCommandFailure {
    pub fn into_unreaped_process(self) -> Option<crate::ManagedProcess> {
        self.unreaped
    }
}

impl std::fmt::Debug for PrivateCommandFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PrivateCommandFailure")
            .field("cleanup_required", &self.unreaped.is_some())
            .finish()
    }
}

impl From<PlatformError> for PrivateCommandFailure {
    fn from(_: PlatformError) -> Self {
        Self { unreaped: None }
    }
}

impl From<io::Error> for PrivateCommandFailure {
    fn from(_: io::Error) -> Self {
        Self { unreaped: None }
    }
}

/// `input` must be a bounded channel. Each submission is limited to 4 KiB.
/// A separate writer ensures a child that does not read cannot block timeout
/// or cancellation. A tracked RAII process owns the entire child tree.
pub fn run_private_command(
    request: PrivateCommandRequest,
    input: mpsc::Receiver<Vec<u8>>,
    cancel: Arc<AtomicBool>,
    mut output: impl FnMut(&[u8], bool),
) -> Result<PrivateCommandExit, PrivateCommandFailure> {
    if cancel.load(Ordering::Acquire) {
        return Ok(PrivateCommandExit::Cancelled);
    }
    let mut command = Command::new(request.program);
    crate::env::apply_launch_environment(&mut command, &request.environment);
    command
        .args(request.args)
        .current_dir(request.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let mut process = crate::managed_process::own_child(child, Some(request.record_path))?;
    let finished = Arc::new(AtomicBool::new(false));
    let writer_done = finished.clone();
    let writer = std::thread::spawn(move || {
        while !writer_done.load(Ordering::Acquire) {
            match input.recv_timeout(Duration::from_millis(50)) {
                Ok(bytes) if bytes.len() <= 4096 => {
                    if stdin
                        .write_all(&bytes)
                        .and_then(|()| stdin.flush())
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(_) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    });
    let (sender, receiver) = mpsc::sync_channel(32);
    let overflow = Arc::new(AtomicBool::new(false));
    let out_reader = read_chunks(stdout, false, sender.clone(), overflow.clone());
    let err_reader = read_chunks(stderr, true, sender, overflow.clone());
    let deadline = Instant::now() + request.timeout;
    let mut total = 0usize;
    let mut exit_status = None;
    let result = (|| -> Result<PrivateCommandExit, PlatformError> {
        loop {
            if cancel.load(Ordering::Acquire) {
                return Ok(PrivateCommandExit::Cancelled);
            }
            if Instant::now() >= deadline {
                return Ok(PrivateCommandExit::TimedOut);
            }
            if overflow.load(Ordering::Acquire) {
                return Ok(PrivateCommandExit::OutputLimit);
            }
            match receiver.recv_timeout(Duration::from_millis(25)) {
                Ok((bytes, is_stderr)) => {
                    total += bytes.len();
                    if total > request.output_limit {
                        return Ok(PrivateCommandExit::OutputLimit);
                    }
                    output(&bytes, is_stderr);
                }
                Err(mpsc::RecvTimeoutError::Disconnected) if exit_status.is_some() => {
                    return Ok(PrivateCommandExit::Exited(exit_status.unwrap()));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    std::thread::sleep(Duration::from_millis(25))
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if exit_status.is_none() {
                exit_status = process.try_wait()?.map(|status| status.success());
            }
        }
    })();
    finished.store(true, Ordering::Release);
    let cleanup = process.terminate();
    // The whole tree has been terminated before joining pipe owners.
    if cleanup.is_ok() {
        let _ = writer.join();
        let _ = out_reader.join();
        let _ = err_reader.join();
    }
    if cleanup.is_err() {
        return Err(PrivateCommandFailure {
            unreaped: Some(process),
        });
    }
    result.map_err(Into::into)
}

fn read_chunks(
    mut pipe: impl Read + Send + 'static,
    stderr: bool,
    sender: mpsc::SyncSender<(Vec<u8>, bool)>,
    overflow: Arc<AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    if sender.try_send((buffer[..count].to_vec(), stderr)).is_err() {
                        overflow.store(true, Ordering::Release);
                        break;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    overflow.store(true, Ordering::Release);
                    break;
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufRead;

    #[test]
    fn fixture_entrypoint() {
        let Ok(mode) = std::env::var("TERMLOOP_PRIVATE_COMMAND_FIXTURE") else {
            return;
        };
        match mode.as_str() {
            "dialogue" => {
                println!("challenge");
                io::stdout().flush().unwrap();
                let mut line = String::new();
                io::stdin().lock().read_line(&mut line).unwrap();
                assert_eq!(line, "reply\n");
                println!("confirmed");
            }
            "flood" => {
                println!("{}", "x".repeat(128 * 1024));
            }
            "hang" => {
                println!("ready");
                io::stdout().flush().unwrap();
                std::thread::sleep(Duration::from_secs(30));
            }
            _ => panic!("unknown fixture"),
        }
    }

    fn request(mode: &str) -> PrivateCommandRequest {
        let directory = std::env::temp_dir().join(format!(
            "termloop-private-command-{}",
            crate::generate_uuid_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        PrivateCommandRequest {
            program: std::env::current_exe().unwrap(),
            args: vec![
                "--exact".into(),
                "private_command::tests::fixture_entrypoint".into(),
                "--nocapture".into(),
            ],
            cwd: directory.clone(),
            environment: LaunchEnvironment::os_baseline()
                .with_explicit("TERMLOOP_PRIVATE_COMMAND_FIXTURE", mode),
            timeout: Duration::from_secs(5),
            output_limit: 8192,
            record_path: directory.join("child.process"),
        }
    }

    #[test]
    fn private_dialogue_reaps_and_removes_owned_record() {
        let request = request("dialogue");
        let directory = request.cwd.clone();
        let (input, receiver) = mpsc::sync_channel(8);
        let mut retained = Vec::new();
        let mut sent = false;
        let result = run_private_command(
            request,
            receiver,
            Arc::new(AtomicBool::new(false)),
            |bytes, stderr| {
                assert!(!stderr);
                retained.extend_from_slice(bytes);
                if !sent && String::from_utf8_lossy(&retained).contains("challenge") {
                    input.try_send(b"reply\n".to_vec()).unwrap();
                    sent = true;
                }
            },
        )
        .unwrap();
        assert_eq!(result, PrivateCommandExit::Exited(true));
        assert!(String::from_utf8_lossy(&retained).contains("confirmed"));
        assert!(!directory.join("child.process").exists());
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn cleanup_failure_returns_the_owned_process_for_recovery() {
        let request = request("dialogue");
        let directory = request.cwd.clone();
        let record = request.record_path.clone();
        let (input, receiver) = mpsc::sync_channel(8);
        let mut retained = Vec::new();
        let mut sent = false;
        let failure = run_private_command(
            request,
            receiver,
            Arc::new(AtomicBool::new(false)),
            |bytes, _| {
                retained.extend_from_slice(bytes);
                if !sent && String::from_utf8_lossy(&retained).contains("challenge") {
                    // Force a real OS cleanup failure after the child was owned.
                    std::fs::remove_file(&record).unwrap();
                    std::fs::create_dir(&record).unwrap();
                    input.try_send(b"reply\n".to_vec()).unwrap();
                    sent = true;
                }
            },
        )
        .unwrap_err();
        let mut process = failure.into_unreaped_process().expect("retained ownership");
        assert!(process.try_wait().unwrap().is_some());
        process.terminate().unwrap();
        std::fs::remove_dir(record).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn timeout_cancel_and_output_limit_bound_process_lifetime() {
        for mode in ["timeout", "cancel", "flood"] {
            let mut request = request(if mode == "flood" { "flood" } else { "hang" });
            if mode == "timeout" {
                request.timeout = Duration::from_millis(250);
            }
            let directory = request.cwd.clone();
            let (_input, receiver) = mpsc::sync_channel(8);
            let cancel = Arc::new(AtomicBool::new(false));
            let signal = cancel.clone();
            let result = run_private_command(request, receiver, cancel, |_, _| {
                if mode == "cancel" {
                    signal.store(true, Ordering::Release);
                }
            })
            .unwrap();
            assert_eq!(
                result,
                match mode {
                    "timeout" => PrivateCommandExit::TimedOut,
                    "cancel" => PrivateCommandExit::Cancelled,
                    _ => PrivateCommandExit::OutputLimit,
                }
            );
            assert!(!directory.join("child.process").exists());
            std::fs::remove_dir(directory).unwrap();
        }
    }
}
