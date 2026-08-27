use std::sync::{Mutex, MutexGuard, OnceLock};

#[cfg(target_os = "macos")]
use crate::keep_awake::keep_awake_lid_close_causes_sleep;
use crate::{
    KeepAwakeError, KeepAwakeHold, KeepAwakeRequest, keep_awake_overrides, keep_awake_supported,
};

/// Power assertions are visible system-wide, so two tests holding one at the
/// same time would observe each other. Every test that takes a hold serializes
/// here; a poisoned lock is still usable because the guarded state is only the
/// absence of a hold, which a panicking test restores by unwinding.
fn exclusive_hold() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The exact name this adapter gives its assertions, mirrored from the macOS
/// backend so the visibility test asserts on the real string.
#[cfg(target_os = "macos")]
const ASSERTION_NAME: &str = "TermLoop: agent session running";

/// The support fact has to match the host the code was built for, otherwise a
/// caller cannot tell an unsupported OS from a silently inactive hold.
#[test]
fn support_matches_the_host() {
    assert_eq!(
        keep_awake_supported(),
        cfg!(any(target_os = "macos", target_os = "linux", windows))
    );
    assert_eq!(keep_awake_overrides().is_empty(), !keep_awake_supported());
    // macOS takes the clamshell override as part of acquisition, so an active
    // hold no longer reports lid close as an uncovered transition.
    #[cfg(target_os = "macos")]
    assert!(!keep_awake_overrides().contains(&crate::KeepAwakeOverride::LidClose));
}

/// A build with no mechanism must say so. A build that has one may still be
/// turned down at runtime — Linux needs a live systemd-logind — but the
/// refusal has to arrive as a typed reason rather than a silently absent hold.
#[test]
fn acquisition_reflects_host_support() {
    let _exclusive = exclusive_hold();
    let outcome = KeepAwakeHold::acquire(KeepAwakeRequest::default());
    if !keep_awake_supported() {
        assert_eq!(outcome.unwrap_err(), KeepAwakeError::Unsupported);
        return;
    }
    if let Err(error) = outcome {
        assert!(
            matches!(
                error,
                KeepAwakeError::Unsupported | KeepAwakeError::Refused { .. }
            ),
            "unexpected refusal shape: {error:?}"
        );
    }
}

/// Re-acquiring after a drop proves the release path runs: on Windows the
/// dedicated thread must have cleared and exited, on macOS the assertions must
/// have been released, and on Linux the inhibitor child must have exited.
#[test]
fn holds_can_be_taken_released_and_retaken() {
    let _exclusive = exclusive_hold();
    if KeepAwakeHold::acquire(KeepAwakeRequest::default()).is_err() {
        // This host has no working mechanism, which
        // `acquisition_reflects_host_support` already covers.
        return;
    }
    for _ in 0..3 {
        let hold = KeepAwakeHold::acquire(KeepAwakeRequest::default()).unwrap();
        drop(hold);
    }
    let display = KeepAwakeHold::acquire(KeepAwakeRequest {
        keep_display_awake: true,
    });
    assert!(display.is_ok(), "display hold refused: {display:?}");
}

/// Runtime evidence rather than a type-check: while a hold is alive the OS
/// must actually list the named assertion, and it must be gone afterwards.
#[cfg(target_os = "macos")]
#[test]
fn macos_assertion_is_visible_to_the_operating_system() {
    /// `pmset` lists assertions by owning process, so every check is scoped to
    /// this test binary's pid. A real TermLoop daemon running on the same
    /// machine holds an identically named assertion, and matching on the name
    /// alone would fail this test because of it.
    fn own_assertions() -> Option<String> {
        let output = std::process::Command::new("/usr/bin/pmset")
            .args(["-g", "assertions"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let owner = format!("pid {}(", std::process::id());
        Some(
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter(|line| line.contains(&owner))
                .collect::<Vec<_>>()
                .join("\n"),
        )
    }

    let _exclusive = exclusive_hold();
    let Some(before) = own_assertions() else {
        // `pmset` is unavailable in this environment, so this test can prove
        // nothing. Report it rather than pass silently.
        eprintln!("skipped: pmset is not runnable here, OS visibility unmeasured");
        return;
    };
    assert!(
        !before.contains(ASSERTION_NAME),
        "this process already held a TermLoop assertion before the test:\n{before}"
    );

    let hold = KeepAwakeHold::acquire(KeepAwakeRequest::default()).unwrap();
    let during = own_assertions().expect("pmset ran once already");
    assert!(
        during.contains(ASSERTION_NAME),
        "named assertion missing while a hold is active:\n{during}"
    );

    drop(hold);
    let after = own_assertions().expect("pmset ran once already");
    assert!(
        !after.contains(ASSERTION_NAME),
        "assertion outlived its hold:\n{after}"
    );
}

/// Runtime proof for the bug this adapter exists to prevent: while the hold is
/// active, IOPMrootDomain must report that closing the lid does not cause
/// sleep. Releasing the final TermLoop hold restores the exact pre-test fact,
/// including when another clamshell utility already owned the override.
#[cfg(target_os = "macos")]
#[test]
fn macos_hold_covers_lid_close_and_restores_the_previous_state() {
    let _exclusive = exclusive_hold();
    let Some(before) = keep_awake_lid_close_causes_sleep() else {
        eprintln!("skipped: this Mac exposes no clamshell sleep property");
        return;
    };

    let hold = KeepAwakeHold::acquire(KeepAwakeRequest::default()).unwrap();
    assert_eq!(keep_awake_lid_close_causes_sleep(), Some(false));

    drop(hold);
    assert_eq!(keep_awake_lid_close_causes_sleep(), Some(before));
}
