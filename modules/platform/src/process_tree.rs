use crate::PlatformError;

/// Typed delivery fact for one process-tree signal request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalDelivery {
    /// The signal reached the target tree, or the tree had already exited.
    Delivered,
    /// This platform has no reliable graceful cross-console delivery for the
    /// requested signal, so nothing was sent and no process observed anything.
    /// Callers should skip their graceful grace period and escalate to `Kill`.
    GracefulUnsupported,
}

/// Containment handle for one spawned process tree.
///
/// Windows: the guard owns a Job Object created with
/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, holds the target process in it, and
/// registers it under the root PID so `signal_process_tree(pid, Kill)`
/// terminates the whole job while the guard is alive. Descendants inherit job
/// membership, so everything spawned by the target after assignment is
/// contained. Known race: a descendant the target spawned before the
/// assignment completed is not a job member; attaching immediately after
/// spawn keeps that window negligible, and it is accepted.
///
/// Drop semantics: dropping the guard deregisters the PID and closes the job
/// handle. Dropping after the tree has exited is a no-op. Dropping while job
/// members are still alive lets the OS `KILL_ON_JOB_CLOSE` limit terminate
/// them — a deliberate fail-closed backstop for daemon teardown and error
/// paths, not a graceful shutdown path. Hold the guard for the child's whole
/// lifetime and request explicit kills through `signal_process_tree`. Daemon
/// death of any kind closes the handle in the kernel, so the tree dies with
/// the daemon at worst.
///
/// Unix: a no-op. The `setsid`/`process_group(0)` performed at spawn already
/// scopes the tree, and dropping the guard never signals anything.
pub struct ProcessTreeGuard {
    #[cfg(windows)]
    _registration: Option<windows_job::JobRegistration>,
}

/// Attaches tree containment to an already spawned process, for example a
/// PTY child created by `portable-pty`. A target that already exited is
/// success and yields an inert guard, consistent with unix `ESRCH` tolerance.
pub fn attach_process_tree_guard(process_id: u32) -> Result<ProcessTreeGuard, PlatformError> {
    #[cfg(windows)]
    {
        Ok(ProcessTreeGuard {
            _registration: windows_job::attach(process_id)?,
        })
    }
    #[cfg(not(windows))]
    {
        let _ = process_id;
        Ok(ProcessTreeGuard {})
    }
}

/// Contains a child this crate spawned itself, using the still-open child
/// handle. An already-exited child yields an inert guard.
#[cfg(windows)]
pub(crate) fn contain_spawned_child(
    child: &std::process::Child,
) -> Result<ProcessTreeGuard, PlatformError> {
    Ok(ProcessTreeGuard {
        _registration: windows_job::contain_spawned_child(child)?,
    })
}

#[cfg(windows)]
pub(crate) fn signal_windows_process_tree(
    process_id: u32,
    signal: crate::ProcessTreeSignal,
) -> Result<SignalDelivery, PlatformError> {
    match signal {
        crate::ProcessTreeSignal::Hangup | crate::ProcessTreeSignal::Terminate => {
            // A consoleless daemon has no reliable graceful signal for
            // arbitrary cross-console children. Report the typed fact instead
            // of pretending delivery; callers escalate to Kill immediately.
            Ok(SignalDelivery::GracefulUnsupported)
        }
        crate::ProcessTreeSignal::Kill => {
            windows_job::kill_tree(process_id)?;
            Ok(SignalDelivery::Delivered)
        }
    }
}

#[cfg(windows)]
mod windows_job {
    use std::collections::HashMap;
    use std::io;
    use std::sync::{Arc, Mutex, OnceLock, PoisonError};

    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, HANDLE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_BASIC_LIMIT_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{
        IO_COUNTERS, OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE, TerminateProcess,
        WaitForSingleObject,
    };

    /// Exit code assigned to every process terminated through the job.
    const TREE_KILL_EXIT_CODE: u32 = 1;

    /// Owned kernel handle to one kill-on-close job object.
    pub(super) struct JobHandle(HANDLE);

    // SAFETY: a job-object HANDLE is a process-wide kernel handle with no
    // thread affinity. Every use is a thread-safe kernel call through a
    // shared reference, and the handle is closed exactly once in Drop.
    #[allow(unsafe_code)]
    unsafe impl Send for JobHandle {}
    // SAFETY: as above; the kernel serializes concurrent calls on the same
    // job handle, and no interior mutation happens on the Rust side.
    #[allow(unsafe_code)]
    unsafe impl Sync for JobHandle {}

    impl Drop for JobHandle {
        fn drop(&mut self) {
            // SAFETY: self.0 is a live handle owned exclusively by this
            // wrapper and is closed exactly once here. If it is the last
            // handle to the job, KILL_ON_JOB_CLOSE terminates any members
            // still alive — the documented fail-closed backstop.
            #[allow(unsafe_code)]
            let _ = unsafe { CloseHandle(self.0) };
        }
    }

    /// Owned kernel handle to one opened process.
    struct ProcessHandle(HANDLE);

    impl Drop for ProcessHandle {
        fn drop(&mut self) {
            // SAFETY: self.0 came from a successful OpenProcess owned only by
            // this wrapper and is closed exactly once here.
            #[allow(unsafe_code)]
            let _ = unsafe { CloseHandle(self.0) };
        }
    }

    fn registry() -> &'static Mutex<HashMap<u32, Arc<JobHandle>>> {
        static REGISTRY: OnceLock<Mutex<HashMap<u32, Arc<JobHandle>>>> = OnceLock::new();
        REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// Registry membership for one contained root PID. Dropping removes the
    /// registration and, with it, the last in-process reference to the job
    /// handle, so the kernel close (and any kill-on-close backstop) fires.
    pub(super) struct JobRegistration {
        process_id: u32,
        job: Arc<JobHandle>,
    }

    impl Drop for JobRegistration {
        fn drop(&mut self) {
            let mut registered = registry().lock().unwrap_or_else(PoisonError::into_inner);
            if registered
                .get(&self.process_id)
                .is_some_and(|current| Arc::ptr_eq(current, &self.job))
            {
                registered.remove(&self.process_id);
            }
        }
    }

    fn register(process_id: u32, job: JobHandle) -> JobRegistration {
        let job = Arc::new(job);
        registry()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(process_id, job.clone());
        JobRegistration { process_id, job }
    }

    fn registered_job(process_id: u32) -> Option<Arc<JobHandle>> {
        registry()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&process_id)
            .cloned()
    }

    fn create_kill_on_close_job() -> io::Result<JobHandle> {
        // SAFETY: null security attributes and a null name request a fresh
        // anonymous job object; the returned handle is checked before use.
        #[allow(unsafe_code)]
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = JobHandle(raw);
        let limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION {
                PerProcessUserTimeLimit: 0,
                PerJobUserTimeLimit: 0,
                LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                MinimumWorkingSetSize: 0,
                MaximumWorkingSetSize: 0,
                ActiveProcessLimit: 0,
                Affinity: 0,
                PriorityClass: 0,
                SchedulingClass: 0,
            },
            IoInfo: IO_COUNTERS {
                ReadOperationCount: 0,
                WriteOperationCount: 0,
                OtherOperationCount: 0,
                ReadTransferCount: 0,
                WriteTransferCount: 0,
                OtherTransferCount: 0,
            },
            ProcessMemoryLimit: 0,
            JobMemoryLimit: 0,
            PeakProcessMemoryUsed: 0,
            PeakJobMemoryUsed: 0,
        };
        // SAFETY: the pointer and byte length describe one fully initialized
        // JOBOBJECT_EXTENDED_LIMIT_INFORMATION that outlives the call, and
        // job.0 is a live handle owned by this function.
        #[allow(unsafe_code)]
        let configured = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
                    .expect("job limit struct size fits in u32"),
            )
        };
        if configured == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    /// Non-blocking probe of an opened process handle's signaled state.
    fn process_handle_is_signaled(handle: HANDLE) -> bool {
        // SAFETY: the caller passes a live handle opened with SYNCHRONIZE
        // access; a zero timeout makes this a non-blocking state probe.
        #[allow(unsafe_code)]
        let state = unsafe { WaitForSingleObject(handle, 0) };
        state == WAIT_OBJECT_0
    }

    pub(super) fn contain_spawned_child(
        child: &std::process::Child,
    ) -> io::Result<Option<JobRegistration>> {
        use std::os::windows::io::AsRawHandle;

        let job = create_kill_on_close_job()?;
        let process: HANDLE = child.as_raw_handle();
        // SAFETY: job.0 is a live owned job handle and the child's process
        // handle is kept open by the borrowed Child for the whole call.
        #[allow(unsafe_code)]
        let assigned = unsafe { AssignProcessToJobObject(job.0, process) };
        if assigned == 0 {
            let error = io::Error::last_os_error();
            // Assignment races with child exit: a child that already
            // terminated is reported as access denied. Treat a proven-exited
            // child as already dead instead of failing the spawn.
            if error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32)
                && process_handle_is_signaled(process)
            {
                return Ok(None);
            }
            return Err(error);
        }
        Ok(Some(register(child.id(), job)))
    }

    pub(super) fn attach(process_id: u32) -> io::Result<Option<JobRegistration>> {
        // SAFETY: the desired-access mask requests only quota, terminate,
        // and synchronize rights; a null return is checked before any use.
        #[allow(unsafe_code)]
        let raw = unsafe {
            OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE | SYNCHRONIZE,
                0,
                process_id,
            )
        };
        if raw.is_null() {
            let error = io::Error::last_os_error();
            // A fully released PID is reported as an invalid parameter; the
            // target already exited, matching unix ESRCH tolerance.
            if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                return Ok(None);
            }
            return Err(error);
        }
        let process = ProcessHandle(raw);
        let job = create_kill_on_close_job()?;
        // SAFETY: both handles are live and owned by this function for the
        // duration of the call.
        #[allow(unsafe_code)]
        let assigned = unsafe { AssignProcessToJobObject(job.0, process.0) };
        if assigned == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32)
                && process_handle_is_signaled(process.0)
            {
                return Ok(None);
            }
            return Err(error);
        }
        Ok(Some(register(process_id, job)))
    }

    pub(super) fn kill_tree(process_id: u32) -> io::Result<()> {
        if let Some(job) = registered_job(process_id) {
            // SAFETY: the registry stores only live owned job handles; the
            // Arc keeps this one alive across the call.
            #[allow(unsafe_code)]
            let terminated = unsafe { TerminateJobObject(job.0, TREE_KILL_EXIT_CODE) };
            if terminated == 0 {
                return Err(io::Error::last_os_error());
            }
            return Ok(());
        }
        // No containment job is known for this PID (for example a tracked
        // record from a previous daemon epoch, whose job already closed with
        // that daemon). Fall back to terminating the single process.
        // SAFETY: the desired-access mask requests only terminate and
        // synchronize rights; a null return is checked before any use.
        #[allow(unsafe_code)]
        let raw = unsafe { OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, 0, process_id) };
        if raw.is_null() {
            let error = io::Error::last_os_error();
            // Already dead is success, matching unix ESRCH tolerance.
            if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                return Ok(());
            }
            return Err(error);
        }
        let process = ProcessHandle(raw);
        // SAFETY: process.0 is a live handle owned by this function and
        // opened with PROCESS_TERMINATE access.
        #[allow(unsafe_code)]
        let terminated = unsafe { TerminateProcess(process.0, TREE_KILL_EXIT_CODE) };
        if terminated == 0 {
            let error = io::Error::last_os_error();
            // A process that exited between open and terminate reports
            // access denied; tolerate only that proven-exited case.
            if error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32)
                && process_handle_is_signaled(process.0)
            {
                return Ok(());
            }
            return Err(error);
        }
        Ok(())
    }
}
