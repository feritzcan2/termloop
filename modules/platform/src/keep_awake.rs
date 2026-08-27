//! Keep-awake power assertions.
//!
//! This adapter owns only the OS mechanism that holds a host awake and the
//! typed facts describing what that mechanism cannot promise. Deciding when a
//! hold should exist, and for how long, is caller policy.
//!
//! A hold is an RAII value: dropping it releases every OS assertion it owns.
//! Holds are also process-scoped on every supported OS, so a daemon crash
//! releases them without leaving anything behind to reconcile. That is the
//! reason this is direct FFI rather than a supervised `caffeinate` child.

/// What a caller wants the host to stay awake for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct KeepAwakeRequest {
    /// Additionally prevent the display from sleeping.
    ///
    /// Off by default: an unattended agent run wants the machine awake, not
    /// the screen lit, and a display assertion costs battery and panel life.
    pub keep_display_awake: bool,
}

/// Why an acquisition produced no hold.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum KeepAwakeError {
    /// This OS has no keep-awake mechanism wired up here.
    #[error("this platform has no keep-awake mechanism")]
    Unsupported,
    /// The assertion could not be described to the OS at all.
    #[error("the keep-awake assertion could not be described to the operating system")]
    Undescribable,
    /// The OS was asked and said no.
    #[error("the operating system refused the keep-awake assertion (status {status})")]
    Refused { status: i64 },
}

/// A condition this host can still sleep under while a hold is active.
///
/// These are properties of the OS mechanism, not runtime observations: holding
/// an assertion never proves what a closed lid will do. Callers surface them so
/// a user interface can be honest instead of promising uninterruptible uptime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeepAwakeOverride {
    /// Closing the lid is a user-initiated sleep path the OS may honor anyway.
    LidClose,
    /// An explicit sleep request from a menu, shortcut, or power button.
    UserInitiatedSleep,
    /// Critically low battery overrides assertions.
    LowBattery,
    /// A thermal emergency overrides assertions.
    ThermalEmergency,
}

/// Whether this host has a keep-awake mechanism at all, independent of any
/// request. Callers use this to report an honest unsupported state rather than
/// a silently inactive one.
pub fn keep_awake_supported() -> bool {
    imp::SUPPORTED
}

/// Conditions that can still put this host to sleep while a hold is active.
/// Empty when the host is unsupported.
pub fn keep_awake_overrides() -> &'static [KeepAwakeOverride] {
    imp::OVERRIDES
}

/// Releases a clamshell override left by a previous crashed TermLoop process.
///
/// Normal holds are process-scoped on every OS except macOS lid-close state,
/// which is a global kernel flag. Callers invoke this only when current product
/// policy wants no hold; a live TermLoop holder is detected and never cleared.
/// `false` asks the caller to retry later because another live holder exists.
pub fn release_stale_keep_awake() -> Result<bool, KeepAwakeError> {
    imp::release_stale()
}

/// One active keep-awake hold. Dropping it releases the OS assertions.
pub struct KeepAwakeHold {
    #[allow(dead_code, reason = "the unsupported backend carries no state")]
    inner: imp::Hold,
}

impl KeepAwakeHold {
    /// Asks the OS to hold this host awake until the returned value is dropped.
    pub fn acquire(request: KeepAwakeRequest) -> Result<Self, KeepAwakeError> {
        imp::acquire(request).map(|inner| Self { inner })
    }
}

impl std::fmt::Debug for KeepAwakeHold {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("KeepAwakeHold")
    }
}

#[cfg(all(test, target_os = "macos"))]
pub(crate) fn keep_awake_lid_close_causes_sleep() -> Option<bool> {
    imp::lid_close_causes_sleep()
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::{CString, OsString};
    use std::fs::{File, OpenOptions};
    use std::io::{Read, Seek, SeekFrom, Write};
    use std::os::fd::AsRawFd;
    use std::os::raw::{c_char, c_void};
    use std::os::unix::ffi::OsStringExt;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    use std::path::PathBuf;
    use std::ptr;
    use std::sync::mpsc::{RecvTimeoutError, Sender, channel};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;

    use super::{KeepAwakeError, KeepAwakeOverride, KeepAwakeRequest};

    pub(super) const SUPPORTED: bool = true;
    pub(super) const OVERRIDES: &[KeepAwakeOverride] = &[
        KeepAwakeOverride::UserInitiatedSleep,
        KeepAwakeOverride::LowBattery,
        KeepAwakeOverride::ThermalEmergency,
    ];

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type CFMutableDictionaryRef = *mut c_void;
    type IOPMAssertionId = u32;
    type IOReturn = i32;
    type IoObject = u32;
    type IoService = IoObject;
    type IoConnect = u32;
    type MachPort = u32;
    type CGDirectDisplayId = u32;

    const CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const IOPM_ASSERTION_LEVEL_ON: u32 = 255;
    const IO_RETURN_SUCCESS: IOReturn = 0;
    const CLAMSHELL_SLEEP_SELECTOR: u32 = 12;
    const CG_ERROR_SUCCESS: i32 = 0;
    const CLAMSHELL_HEARTBEAT: Duration = Duration::from_secs(1);
    const COORDINATION_FILE: &str = "termloop-next-keep-awake.lock";
    const TERMLOOP_OWNED_MARKER: &[u8] = b"termloop-owned\n";
    const EXTERNAL_OWNER_MARKER: &[u8] = b"external-owner\n";

    /// `IOPMAssertionCreateWithName` requires a name shorter than 128
    /// characters. Keeping it short and stable also makes the assertion
    /// recognisable in `pmset -g assertions`, which is how a host proves the
    /// hold really exists.
    const ASSERTION_NAME: &str = "TermLoop: agent session running";

    /// Blocks automatic idle system sleep. Deliberately not a display
    /// assertion, so the screen still turns off during a long run.
    const PREVENT_IDLE_SYSTEM_SLEEP: &str = "PreventUserIdleSystemSleep";
    /// Taken only when the caller explicitly asked for a lit screen.
    const PREVENT_IDLE_DISPLAY_SLEEP: &str = "PreventUserIdleDisplaySleep";

    // SAFETY: these are the documented CoreFoundation signatures, declared
    // with the exact argument and return types the framework exports. The
    // system framework is always present on macOS, so linking cannot fail.
    #[allow(unsafe_code)]
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithCString(
            allocator: CFTypeRef,
            bytes: *const c_char,
            encoding: u32,
        ) -> CFStringRef;
        fn CFRelease(value: CFTypeRef);
        fn CFGetTypeID(value: CFTypeRef) -> usize;
        fn CFBooleanGetTypeID() -> usize;
        fn CFBooleanGetValue(value: CFTypeRef) -> u8;
        fn CFStringCompare(left: CFStringRef, right: CFStringRef, options: usize) -> isize;
    }

    // SAFETY: these declarations mirror the public IOKit signatures and the
    // scalar IOPMrootDomain user-client entry point exported by macOS. Selector
    // 12 is `kPMSetClamshellSleepState` in IOPMLibDefs.h. Every owned object and
    // connection is wrapped below so it is released exactly once.
    #[allow(unsafe_code)]
    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            assertion_level: u32,
            assertion_name: CFStringRef,
            assertion_id: *mut IOPMAssertionId,
        ) -> IOReturn;
        fn IOPMAssertionRelease(assertion_id: IOPMAssertionId) -> IOReturn;
        fn IOServiceMatching(name: *const c_char) -> CFMutableDictionaryRef;
        fn IOServiceGetMatchingService(
            main_port: MachPort,
            matching: CFMutableDictionaryRef,
        ) -> IoService;
        fn IOServiceOpen(
            service: IoService,
            owning_task: MachPort,
            connection_type: u32,
            connection: *mut IoConnect,
        ) -> IOReturn;
        fn IOServiceClose(connection: IoConnect) -> IOReturn;
        fn IOObjectRelease(object: IoObject) -> IOReturn;
        fn IOConnectCallScalarMethod(
            connection: IoConnect,
            selector: u32,
            input: *const u64,
            input_count: u32,
            output: *mut u64,
            output_count: *mut u32,
        ) -> IOReturn;
        fn IORegistryEntryCreateCFProperty(
            entry: IoService,
            key: CFStringRef,
            allocator: CFTypeRef,
            options: u32,
        ) -> CFTypeRef;
        fn IOPSCopyPowerSourcesInfo() -> CFTypeRef;
        fn IOPSGetProvidingPowerSourceType(snapshot: CFTypeRef) -> CFStringRef;
        static mach_task_self_: MachPort;
    }

    // SAFETY: these are the public CoreGraphics display-query signatures. The
    // caller supplies a fixed live array and a live count pointer for the
    // duration of each call.
    #[allow(unsafe_code)]
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGGetOnlineDisplayList(
            max_displays: u32,
            displays: *mut CGDirectDisplayId,
            display_count: *mut u32,
        ) -> i32;
        fn CGDisplayIsBuiltin(display: CGDirectDisplayId) -> u32;
    }

    /// Owns one CoreFoundation string for the duration of a single call.
    ///
    /// `CFSTR` is a C macro and cannot be reached through FFI, so every
    /// constant string has to be built and released explicitly.
    struct CfString(CFStringRef);

    impl CfString {
        fn new(value: &str) -> Option<Self> {
            let bytes = CString::new(value).ok()?;
            // SAFETY: `bytes` owns a NUL-terminated buffer that outlives this
            // call, the null allocator selects the default one, and the
            // encoding constant is the documented UTF-8 value. The call either
            // returns null or a +1 reference this wrapper releases in Drop.
            #[allow(unsafe_code)]
            let raw = unsafe {
                CFStringCreateWithCString(ptr::null(), bytes.as_ptr(), CF_STRING_ENCODING_UTF8)
            };
            if raw.is_null() { None } else { Some(Self(raw)) }
        }
    }

    impl Drop for CfString {
        fn drop(&mut self) {
            // SAFETY: self.0 is a non-null +1 reference obtained above and
            // owned solely by this wrapper, so it is released exactly once.
            #[allow(unsafe_code)]
            unsafe {
                CFRelease(self.0)
            };
        }
    }

    /// Owns an arbitrary +1 CoreFoundation value.
    struct CfValue(CFTypeRef);

    impl Drop for CfValue {
        fn drop(&mut self) {
            // SAFETY: this wrapper is constructed only from non-null +1
            // results and owns the reference exclusively.
            #[allow(unsafe_code)]
            unsafe {
                CFRelease(self.0)
            };
        }
    }

    struct Service(IoService);

    impl Service {
        fn root_domain() -> Result<Self, KeepAwakeError> {
            let name = CString::new("IOPMrootDomain").map_err(|_| KeepAwakeError::Undescribable)?;
            // SAFETY: `name` is a live NUL-terminated string. IOKit owns the
            // returned matching dictionary after IOServiceGetMatchingService,
            // and a nonzero service is a +1 object this wrapper releases.
            #[allow(unsafe_code)]
            let service = unsafe {
                let matching = IOServiceMatching(name.as_ptr());
                if matching.is_null() {
                    return Err(KeepAwakeError::Undescribable);
                }
                IOServiceGetMatchingService(0, matching)
            };
            if service == 0 {
                Err(KeepAwakeError::Undescribable)
            } else {
                Ok(Self(service))
            }
        }
    }

    impl Drop for Service {
        fn drop(&mut self) {
            // SAFETY: self.0 is the nonzero +1 IOKit object owned by this
            // wrapper and is released exactly once.
            #[allow(unsafe_code)]
            let _ = unsafe { IOObjectRelease(self.0) };
        }
    }

    struct Connection(IoConnect);

    impl Connection {
        fn open(service: &Service) -> Result<Self, KeepAwakeError> {
            let mut connection = 0;
            // SAFETY: the service is live, the current task port is supplied
            // by libSystem, and `connection` is writable output storage.
            #[allow(unsafe_code)]
            let status =
                unsafe { IOServiceOpen(service.0, mach_task_self_, 0, &raw mut connection) };
            if status == IO_RETURN_SUCCESS && connection != 0 {
                Ok(Self(connection))
            } else {
                Err(KeepAwakeError::Refused {
                    status: status.into(),
                })
            }
        }
    }

    impl Drop for Connection {
        fn drop(&mut self) {
            // SAFETY: self.0 is the live IOKit connection owned by this
            // wrapper and is closed exactly once.
            #[allow(unsafe_code)]
            let _ = unsafe { IOServiceClose(self.0) };
        }
    }

    /// Cross-process ownership for the global clamshell override.
    ///
    /// macOS does not associate selector 12 with the process that set it. All
    /// TermLoop daemons therefore share one advisory lock and only the last
    /// live holder may restore the state. A marker preserves whether TermLoop
    /// made the original transition, so a pre-existing clamshell utility is
    /// not switched off when this hold ends.
    struct ClamshellHold {
        _coordination: CoordinationLock,
        stop: Option<Sender<()>>,
        heartbeat: Option<JoinHandle<()>>,
    }

    impl ClamshellHold {
        fn acquire() -> Result<Self, KeepAwakeError> {
            let coordination = CoordinationLock::acquire()?;
            let (stop, stopped) = channel();
            let heartbeat = thread::Builder::new()
                .name("termloop-lid-keep-awake".to_owned())
                .spawn(move || {
                    while let Err(RecvTimeoutError::Timeout) =
                        stopped.recv_timeout(CLAMSHELL_HEARTBEAT)
                    {
                        let _ = set_clamshell_sleep_disabled(true);
                    }
                })
                .map_err(|_| KeepAwakeError::Undescribable)?;
            Ok(Self {
                _coordination: coordination,
                stop: Some(stop),
                heartbeat: Some(heartbeat),
            })
        }
    }

    impl Drop for ClamshellHold {
        fn drop(&mut self) {
            if let Some(stop) = self.stop.take() {
                let _ = stop.send(());
            }
            if let Some(heartbeat) = self.heartbeat.take() {
                let _ = heartbeat.join();
            }
            // `coordination` drops after the heartbeat has stopped, so a late
            // tick cannot re-enable the global flag after final cleanup.
        }
    }

    struct CoordinationLock {
        file: File,
    }

    impl CoordinationLock {
        fn acquire() -> Result<Self, KeepAwakeError> {
            let mut file = open_coordination_file()?;
            loop {
                if try_lock(&file, libc::LOCK_EX | libc::LOCK_NB)? {
                    initialize_owner_marker(&mut file)?;
                    if let Err(error) = set_clamshell_sleep_disabled(true) {
                        let _ = clear_owner_marker(&mut file);
                        return Err(error);
                    }
                    lock(&file, libc::LOCK_SH)?;
                    return Ok(Self { file });
                }

                lock(&file, libc::LOCK_SH)?;
                if !owner_marker(&mut file)?.is_empty() {
                    set_clamshell_sleep_disabled(true)?;
                    return Ok(Self { file });
                }

                // The previous last holder was finishing cleanup while this
                // process opened the file. Release the now-stale shared lock
                // and retry initialization as the new first holder.
                unlock(&file)?;
            }
        }
    }

    impl Drop for CoordinationLock {
        fn drop(&mut self) {
            let Ok(true) = try_lock(&self.file, libc::LOCK_EX | libc::LOCK_NB) else {
                return;
            };
            let termloop_owned =
                owner_marker(&mut self.file).is_ok_and(|marker| marker == TERMLOOP_OWNED_MARKER);
            // Clearing selector 12 while Apple's normal clamshell mode is
            // active can desynchronise powerd. Ambiguous display/power facts
            // also preserve the flag: cleanup must not turn off a state whose
            // ownership it cannot prove.
            if termloop_owned && normal_clamshell_mode_active() == Some(false) {
                let _ = set_clamshell_sleep_disabled(false);
            }
            let _ = clear_owner_marker(&mut self.file);
        }
    }

    pub(super) struct Hold {
        assertions: Vec<IOPMAssertionId>,
        clamshell: Option<ClamshellHold>,
    }

    impl Drop for Hold {
        fn drop(&mut self) {
            for assertion in self.assertions.drain(..) {
                // SAFETY: each id came from a successful
                // IOPMAssertionCreateWithName owned only by this hold, and
                // draining guarantees it is released exactly once.
                #[allow(unsafe_code)]
                let _ = unsafe { IOPMAssertionRelease(assertion) };
            }
            // Restoring lid-close sleep comes last: if this drop runs while
            // the lid is already closed, macOS may sleep immediately.
            drop(self.clamshell.take());
        }
    }

    pub(super) fn acquire(request: KeepAwakeRequest) -> Result<Hold, KeepAwakeError> {
        let mut hold = Hold {
            assertions: Vec::new(),
            clamshell: None,
        };
        // The idle-sleep assertion is the actual promise; failing it fails the
        // acquisition. Dropping `hold` here releases nothing, because nothing
        // has been created yet.
        hold.assertions.push(create(PREVENT_IDLE_SYSTEM_SLEEP)?);
        if request.keep_display_awake
            && let Ok(assertion) = create(PREVENT_IDLE_DISPLAY_SLEEP)
        {
            hold.assertions.push(assertion);
        }
        // A normal power assertion cannot veto forced clamshell sleep. The
        // IOPMrootDomain override is therefore part of the macOS acquisition,
        // not a best-effort side effect: active status now means a closed lid
        // is covered too.
        hold.clamshell = Some(ClamshellHold::acquire()?);
        Ok(hold)
    }

    fn create(assertion_type: &str) -> Result<IOPMAssertionId, KeepAwakeError> {
        let kind = CfString::new(assertion_type).ok_or(KeepAwakeError::Undescribable)?;
        let name = CfString::new(ASSERTION_NAME).ok_or(KeepAwakeError::Undescribable)?;
        let mut assertion: IOPMAssertionId = 0;
        // SAFETY: both string references stay alive across the call, the level
        // constant is the documented "on" value, and `assertion` is a live
        // local the callee writes only on success.
        #[allow(unsafe_code)]
        let status = unsafe {
            IOPMAssertionCreateWithName(kind.0, IOPM_ASSERTION_LEVEL_ON, name.0, &raw mut assertion)
        };
        if status == IO_RETURN_SUCCESS {
            Ok(assertion)
        } else {
            Err(KeepAwakeError::Refused {
                status: status.into(),
            })
        }
    }

    pub(super) fn release_stale() -> Result<bool, KeepAwakeError> {
        let mut file = open_coordination_file()?;
        if !try_lock(&file, libc::LOCK_EX | libc::LOCK_NB)? {
            return Ok(false);
        }
        let termloop_owned = owner_marker(&mut file)? == TERMLOOP_OWNED_MARKER;
        if termloop_owned && normal_clamshell_mode_active() == Some(false) {
            set_clamshell_sleep_disabled(false)?;
        }
        clear_owner_marker(&mut file)?;
        Ok(true)
    }

    fn set_clamshell_sleep_disabled(disabled: bool) -> Result<(), KeepAwakeError> {
        let service = Service::root_domain()?;
        let connection = Connection::open(&service)?;
        let input = u64::from(disabled);
        let mut output_count = 0;
        // SAFETY: the connection is live, `input` is one scalar as declared by
        // selector 12, and no output scalars are requested.
        #[allow(unsafe_code)]
        let status = unsafe {
            IOConnectCallScalarMethod(
                connection.0,
                CLAMSHELL_SLEEP_SELECTOR,
                &raw const input,
                1,
                ptr::null_mut(),
                &raw mut output_count,
            )
        };
        if status == IO_RETURN_SUCCESS {
            Ok(())
        } else {
            Err(KeepAwakeError::Refused {
                status: status.into(),
            })
        }
    }

    fn root_domain_boolean(property: &str) -> Result<Option<bool>, KeepAwakeError> {
        let service = Service::root_domain()?;
        let key = CfString::new(property).ok_or(KeepAwakeError::Undescribable)?;
        // SAFETY: the service and key are live for the call. A non-null result
        // is a +1 CoreFoundation value owned by the wrapper below.
        #[allow(unsafe_code)]
        let raw = unsafe { IORegistryEntryCreateCFProperty(service.0, key.0, ptr::null(), 0) };
        if raw.is_null() {
            return Ok(None);
        }
        let value = CfValue(raw);
        // SAFETY: `value` is a live CF object; type inspection is valid for
        // every CF object and boolean access follows only an exact type match.
        #[allow(unsafe_code)]
        let boolean = unsafe {
            if CFGetTypeID(value.0) == CFBooleanGetTypeID() {
                Some(CFBooleanGetValue(value.0) != 0)
            } else {
                None
            }
        };
        Ok(boolean)
    }

    fn initialize_owner_marker(file: &mut File) -> Result<(), KeepAwakeError> {
        let stale_marker = owner_marker(file)?;
        let termloop_owned = stale_marker == TERMLOOP_OWNED_MARKER
            || root_domain_boolean("AppleClamshellCausesSleep")?.unwrap_or(true);
        write_owner_marker(
            file,
            if termloop_owned {
                TERMLOOP_OWNED_MARKER
            } else {
                EXTERNAL_OWNER_MARKER
            },
        )
    }

    fn owner_marker(file: &mut File) -> Result<Vec<u8>, KeepAwakeError> {
        file.seek(SeekFrom::Start(0))
            .map_err(|_| KeepAwakeError::Undescribable)?;
        let mut marker = Vec::new();
        file.take(64)
            .read_to_end(&mut marker)
            .map_err(|_| KeepAwakeError::Undescribable)?;
        Ok(marker)
    }

    fn write_owner_marker(file: &mut File, marker: &[u8]) -> Result<(), KeepAwakeError> {
        file.set_len(0).map_err(|_| KeepAwakeError::Undescribable)?;
        file.seek(SeekFrom::Start(0))
            .map_err(|_| KeepAwakeError::Undescribable)?;
        file.write_all(marker)
            .map_err(|_| KeepAwakeError::Undescribable)?;
        file.sync_data().map_err(|_| KeepAwakeError::Undescribable)
    }

    fn clear_owner_marker(file: &mut File) -> Result<(), KeepAwakeError> {
        file.set_len(0).map_err(|_| KeepAwakeError::Undescribable)?;
        file.sync_data().map_err(|_| KeepAwakeError::Undescribable)
    }

    fn open_coordination_file() -> Result<File, KeepAwakeError> {
        let path = coordination_path()?;
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(|_| KeepAwakeError::Undescribable)?;
        let metadata = file.metadata().map_err(|_| KeepAwakeError::Undescribable)?;
        // SAFETY: geteuid has no arguments or preconditions.
        #[allow(unsafe_code)]
        let current_uid = unsafe { libc::geteuid() };
        if !metadata.file_type().is_file()
            || metadata.uid() != current_uid
            || metadata.mode() & 0o777 != 0o600
        {
            return Err(KeepAwakeError::Undescribable);
        }
        Ok(file)
    }

    fn coordination_path() -> Result<PathBuf, KeepAwakeError> {
        // SAFETY: the first confstr call requests only the required size. The
        // second receives exactly that much writable storage, and its returned
        // byte count is checked before the terminal NUL is removed.
        #[allow(unsafe_code)]
        let required = unsafe { libc::confstr(libc::_CS_DARWIN_USER_TEMP_DIR, ptr::null_mut(), 0) };
        if required <= 1 {
            return Err(KeepAwakeError::Undescribable);
        }
        let mut bytes = vec![0_u8; required];
        // SAFETY: `bytes` is writable for `required` bytes and remains live for
        // the call.
        #[allow(unsafe_code)]
        let written = unsafe {
            libc::confstr(
                libc::_CS_DARWIN_USER_TEMP_DIR,
                bytes.as_mut_ptr().cast(),
                bytes.len(),
            )
        };
        if written != required || bytes.last() != Some(&0) {
            return Err(KeepAwakeError::Undescribable);
        }
        bytes.pop();
        Ok(PathBuf::from(OsString::from_vec(bytes)).join(COORDINATION_FILE))
    }

    fn try_lock(file: &File, operation: i32) -> Result<bool, KeepAwakeError> {
        // SAFETY: the file descriptor is live for the call and the operation
        // contains only documented flock flags.
        #[allow(unsafe_code)]
        let status = unsafe { libc::flock(file.as_raw_fd(), operation) };
        if status == 0 {
            return Ok(true);
        }
        if std::io::Error::last_os_error().kind() == std::io::ErrorKind::WouldBlock {
            Ok(false)
        } else {
            Err(KeepAwakeError::Undescribable)
        }
    }

    fn lock(file: &File, operation: i32) -> Result<(), KeepAwakeError> {
        // SAFETY: the file descriptor is live for the call and the operation
        // is one documented blocking flock mode.
        #[allow(unsafe_code)]
        let status = unsafe { libc::flock(file.as_raw_fd(), operation) };
        if status == 0 {
            Ok(())
        } else {
            Err(KeepAwakeError::Undescribable)
        }
    }

    fn unlock(file: &File) -> Result<(), KeepAwakeError> {
        lock(file, libc::LOCK_UN)
    }

    fn normal_clamshell_mode_active() -> Option<bool> {
        let external_display = has_external_display()?;
        if !external_display {
            return Some(false);
        }
        is_on_ac_power()
    }

    fn has_external_display() -> Option<bool> {
        let mut displays = [0; 8];
        let mut count = 0;
        // SAFETY: the fixed array and count remain live and writable for the
        // call. The returned count is clamped to the array length before use.
        #[allow(unsafe_code)]
        let status = unsafe {
            CGGetOnlineDisplayList(displays.len() as u32, displays.as_mut_ptr(), &raw mut count)
        };
        if status != CG_ERROR_SUCCESS {
            return None;
        }
        Some(
            displays[..usize::min(count as usize, displays.len())]
                .iter()
                .any(|display| {
                    // SAFETY: every id was returned by CGGetOnlineDisplayList and is
                    // valid for this immediate property query.
                    #[allow(unsafe_code)]
                    unsafe {
                        CGDisplayIsBuiltin(*display) == 0
                    }
                }),
        )
    }

    fn is_on_ac_power() -> Option<bool> {
        // SAFETY: a non-null result is a +1 CoreFoundation snapshot owned by
        // the wrapper. The source string is borrowed from that live snapshot.
        #[allow(unsafe_code)]
        let raw = unsafe { IOPSCopyPowerSourcesInfo() };
        if raw.is_null() {
            return None;
        }
        let snapshot = CfValue(raw);
        // SAFETY: snapshot remains live across this borrowed lookup.
        #[allow(unsafe_code)]
        let source = unsafe { IOPSGetProvidingPowerSourceType(snapshot.0) };
        if source.is_null() {
            return None;
        }
        let ac = CfString::new("AC Power")?;
        // SAFETY: both CF strings are live and no locale-sensitive options are
        // requested.
        #[allow(unsafe_code)]
        Some(unsafe { CFStringCompare(source, ac.0, 0) == 0 })
    }

    #[cfg(test)]
    pub(crate) fn lid_close_causes_sleep() -> Option<bool> {
        root_domain_boolean("AppleClamshellCausesSleep")
            .ok()
            .flatten()
    }
}

#[cfg(windows)]
mod imp {
    use std::sync::mpsc::{Sender, channel};
    use std::thread::{self, JoinHandle};

    use windows_sys::Win32::System::Power::{
        ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED, EXECUTION_STATE,
        SetThreadExecutionState,
    };

    use super::{KeepAwakeError, KeepAwakeOverride, KeepAwakeRequest};

    pub(super) const SUPPORTED: bool = true;
    pub(super) const OVERRIDES: &[KeepAwakeOverride] = &[
        KeepAwakeOverride::LidClose,
        KeepAwakeOverride::UserInitiatedSleep,
        KeepAwakeOverride::LowBattery,
    ];

    /// `SetThreadExecutionState` applies to the calling thread and is cleared
    /// when that thread exits, so the request has to be raised, held, and
    /// cleared on one dedicated thread rather than wherever the caller runs.
    pub(super) struct Hold {
        release: Option<Sender<()>>,
        thread: Option<JoinHandle<()>>,
    }

    impl Drop for Hold {
        fn drop(&mut self) {
            // Dropping the sender alone would end the wait, but an explicit
            // send keeps the clear path identical whether or not the receiver
            // is still parked. Joining proves the clear was attempted and the
            // thread ended — not that the OS accepted it, whose result is
            // ignored. Either way the request dies with the thread.
            if let Some(release) = self.release.take() {
                let _ = release.send(());
            }
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    pub(super) fn acquire(request: KeepAwakeRequest) -> Result<Hold, KeepAwakeError> {
        let mut state = ES_CONTINUOUS | ES_SYSTEM_REQUIRED;
        if request.keep_display_awake {
            state |= ES_DISPLAY_REQUIRED;
        }

        let (release_sender, release_receiver) = channel::<()>();
        let (raised_sender, raised_receiver) = channel::<bool>();
        let thread = thread::Builder::new()
            .name("termloop-keep-awake".to_owned())
            .spawn(move || {
                let raised = set_execution_state(state);
                let _ = raised_sender.send(raised);
                if !raised {
                    return;
                }
                // Parks until the hold is dropped; a disconnected channel is
                // the same signal, so neither path can strand the request.
                let _ = release_receiver.recv();
                let _ = set_execution_state(ES_CONTINUOUS);
            })
            .map_err(|_| KeepAwakeError::Undescribable)?;

        match raised_receiver.recv() {
            Ok(true) => Ok(Hold {
                release: Some(release_sender),
                thread: Some(thread),
            }),
            Ok(false) => {
                let _ = thread.join();
                Err(KeepAwakeError::Refused { status: 0 })
            }
            Err(_) => {
                let _ = thread.join();
                Err(KeepAwakeError::Undescribable)
            }
        }
    }

    fn set_execution_state(state: EXECUTION_STATE) -> bool {
        // SAFETY: the call takes a plain bitmask by value, has no pointer
        // arguments and no ownership transfer, and affects only the calling
        // thread. A zero return means the request was refused.
        #[allow(unsafe_code)]
        let previous = unsafe { SetThreadExecutionState(state) };
        previous != 0
    }

    pub(super) fn release_stale() -> Result<bool, KeepAwakeError> {
        Ok(true)
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::io::Write;
    use std::process::{Child, Command, Stdio};

    use super::{KeepAwakeError, KeepAwakeOverride, KeepAwakeRequest};

    pub(super) const SUPPORTED: bool = true;
    pub(super) const OVERRIDES: &[KeepAwakeOverride] = &[
        KeepAwakeOverride::LidClose,
        KeepAwakeOverride::UserInitiatedSleep,
        KeepAwakeOverride::LowBattery,
    ];

    /// The logind inhibitor is taken by running `systemd-inhibit`, which holds
    /// the lock for as long as the command it supervises is alive.
    ///
    /// The alternative — speaking D-Bus directly to
    /// `org.freedesktop.login1.Manager.Inhibit` — means implementing the wire
    /// protocol, SASL, and `SCM_RIGHTS` descriptor passing, or taking a D-Bus
    /// dependency into a crate that currently has none. The supervised command
    /// gets the same lifetime guarantee for far less surface.
    const INHIBIT_PROGRAM: &str = "systemd-inhibit";

    /// `cat` is the supervised command precisely because it ends on stdin EOF.
    /// This process owns the write end, so a daemon crash closes the pipe, the
    /// reader exits, and logind releases the lock. That is the same
    /// process-scoped release the macOS and Windows backends get for free, and
    /// it is why this is not the orphan-prone child the other backends avoid.
    const INHIBITED_COMMAND: &str = "cat";

    /// Blocks suspend and the idle transition. `handle-lid-switch` is
    /// deliberately not inhibited: taking it would override an explicit user
    /// action rather than an automatic one.
    const BLOCKED_TRANSITIONS: &str = "sleep:idle";
    /// Adding `handle-lid-switch` here is what a display hold cannot do, so the
    /// display request only widens the idle block that is already taken.
    const WHO: &str = "TermLoop";
    const WHY: &str = "An agent session is running";

    pub(super) struct Hold {
        child: Child,
    }

    impl Drop for Hold {
        fn drop(&mut self) {
            // Closing the pipe is the release: `cat` sees EOF and exits, and
            // logind drops the lock when the inhibitor process ends. Killing
            // is the backstop for a child that ignored EOF.
            drop(self.child.stdin.take());
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    pub(super) fn acquire(request: KeepAwakeRequest) -> Result<Hold, KeepAwakeError> {
        let mut what = BLOCKED_TRANSITIONS.to_owned();
        if request.keep_display_awake {
            // logind has no display-power inhibitor; blocking the lid switch
            // is the closest honest approximation of "stay visibly awake".
            what.push_str(":handle-lid-switch");
        }
        let mut child = Command::new(INHIBIT_PROGRAM)
            .arg(format!("--what={what}"))
            .arg(format!("--who={WHO}"))
            .arg(format!("--why={WHY}"))
            .arg("--mode=block")
            .arg(INHIBITED_COMMAND)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| KeepAwakeError::Unsupported)?;

        // A host without systemd-logind fails here rather than reporting a
        // hold it does not have. Writing a byte proves the pipe is live; the
        // reader discards it.
        let wrote = child
            .stdin
            .as_mut()
            .is_some_and(|stdin| stdin.write_all(b"\n").is_ok());
        if !wrote {
            let _ = child.kill();
            let _ = child.wait();
            return Err(KeepAwakeError::Refused { status: 0 });
        }
        // An immediate exit means systemd-inhibit rejected the request; a
        // still-running child means the lock is held.
        if let Ok(Some(status)) = child.try_wait() {
            return Err(KeepAwakeError::Refused {
                status: status.code().unwrap_or(-1).into(),
            });
        }
        Ok(Hold { child })
    }

    pub(super) fn release_stale() -> Result<bool, KeepAwakeError> {
        Ok(true)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod imp {
    use super::{KeepAwakeError, KeepAwakeOverride, KeepAwakeRequest};

    pub(super) const SUPPORTED: bool = false;
    pub(super) const OVERRIDES: &[KeepAwakeOverride] = &[];

    pub(super) struct Hold;

    pub(super) fn acquire(_request: KeepAwakeRequest) -> Result<Hold, KeepAwakeError> {
        Err(KeepAwakeError::Unsupported)
    }

    pub(super) fn release_stale() -> Result<bool, KeepAwakeError> {
        Ok(true)
    }
}
