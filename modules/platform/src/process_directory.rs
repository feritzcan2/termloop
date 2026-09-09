//! Read-only directory observation for a child whose owner prevents PID reuse.

use std::path::PathBuf;

/// The caller must keep the exact child unreaped for the duration of this call.
/// Unsupported hosts and exited/inaccessible processes return no observation.
pub fn process_working_directory(process_id: u32) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStringExt;
        let process_id = i32::try_from(process_id).ok()?;
        let mut info = std::mem::MaybeUninit::<libc::proc_vnodepathinfo>::uninit();
        let size = std::mem::size_of::<libc::proc_vnodepathinfo>();
        // SAFETY: the output buffer has exactly the size the kernel is given.
        // No field is read unless proc_pidinfo confirms it filled the whole struct.
        #[allow(unsafe_code)]
        let written = unsafe {
            libc::proc_pidinfo(
                process_id,
                libc::PROC_PIDVNODEPATHINFO,
                0,
                info.as_mut_ptr().cast(),
                size as i32,
            )
        };
        if written != size as i32 {
            return None;
        }
        // SAFETY: the complete structure was initialized by the successful call above.
        #[allow(unsafe_code)]
        let info = unsafe { info.assume_init() };
        let bytes: Vec<u8> = info
            .pvi_cdir
            .vip_path
            .into_iter()
            .flatten()
            .take_while(|byte| *byte != 0)
            .map(|byte| byte as u8)
            .collect();
        if bytes.is_empty() {
            return None;
        }
        Some(PathBuf::from(std::ffi::OsString::from_vec(bytes)))
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/{process_id}/cwd")).ok()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = process_id;
        None
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;

    #[test]
    fn observes_an_owned_process_directory_and_rejects_missing_processes() {
        assert_eq!(
            process_working_directory(std::process::id()),
            Some(std::env::current_dir().unwrap())
        );
        assert_eq!(process_working_directory(u32::MAX), None);
    }
}
