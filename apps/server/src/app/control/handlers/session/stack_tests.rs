use super::*;
use std::future::Future;

// Inspect the future types without constructing AppState or polling a future.
// A large nested future can exhaust a worker's stack before parameter validation.
fn future_size<F: Future>(_: impl FnOnce(&'static AppState) -> F) -> usize {
    std::mem::size_of::<F>()
}

#[test]
fn resume_futures_leave_room_on_the_default_worker_stack() {
    // Leave room for dispatch, polling frames and temporary moves within Tokio's
    // default worker stack; no enlarged RUST_MIN_STACK should be necessary.
    const MAX_RESUME_FUTURE_BYTES: usize = 16 * 1024;
    let sizes = [
        (
            "resume",
            future_size(|state| resume_agent_session(serde_json::Value::Null, state)),
        ),
        (
            "restart",
            future_size(|state| restart_agent_session(serde_json::Value::Null, state)),
        ),
        (
            "relocate",
            future_size(|state| relocate_agent_session(serde_json::Value::Null, state)),
        ),
        (
            "resume attempt",
            future_size(|state| {
                run_agent_resume_session(
                    serde_json::Value::Null,
                    state,
                    None,
                    false,
                    true,
                    "manualRetry",
                    Instant::now() + AGENT_RESUME_ATTEMPT_TIMEOUT,
                )
            }),
        ),
    ];
    for (name, size) in sizes {
        eprintln!("{name} future: {size} bytes");
    }
    for (name, size) in sizes {
        assert!(
            size <= MAX_RESUME_FUTURE_BYTES,
            "{name} future occupies {size} bytes; keep resume plans boxed across async boundaries"
        );
    }
}
