#![forbid(unsafe_code)]

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriterPresenceObservation {
    pub worktree_identity: String,
    pub write_capable_sessions: u32,
}
