#[derive(Debug, thiserror::Error, Clone, Copy, PartialEq, Eq)]
pub enum PreparationError {
    #[error("an existing runtime ownership record conflicts with resume")]
    RuntimeConflict,
    #[error("the resume PTY could not be started")]
    PtySpawnFailed,
    #[error("the original resume target is no longer available")]
    TargetUnavailable,
    #[error("the provider rejected runtime preparation")]
    ProviderRejected,
    #[error("the provider history is damaged and requires explicit repair")]
    ProviderHistoryDamaged,
    #[error("daemon shutdown interrupted resume preparation")]
    DaemonInterrupted,
    #[error("exact runtime absence could not be proven")]
    RuntimeOwnershipUncertain,
}

#[derive(Debug, thiserror::Error, Clone, Copy, PartialEq, Eq)]
#[error("exact runtime absence could not be proven")]
pub struct ReapError;
