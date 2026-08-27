#![forbid(unsafe_code)]

mod branch_commits;
mod changes;
mod command;
mod commit_changes;
mod error;
mod health;
mod mutation;
mod pre_image;
mod remote;
mod repair;
mod repository;
#[cfg(feature = "test-support")]
pub mod test_support;
mod worktree;
mod worktree_branches;

pub use branch_commits::{
    BRANCH_COMMIT_OBSERVATION_DEADLINE, BranchCommitState, BranchCommitSummaryBatchObservation,
    BranchCommitSummaryObservation, BranchCommitSummaryRequest, BranchCommitUnavailable,
};
pub use changes::{
    CHANGE_DIFF_MAX_BYTES, CHANGE_DIFF_MAX_LINES, CHANGE_LIST_MAX_ENTRIES, WorktreeChangeEntry,
    WorktreeChangeKind, WorktreeChangeSide, WorktreeChangesObservation, WorktreeDiffContent,
    WorktreeDiffObservation,
};
pub use command::{
    CLEANUP_GIT_MUTATION_DEADLINE, CLEANUP_GIT_SUBPROCESS_DEADLINE, GitCapabilities, GitRunner,
    GitVersion, HEALTH_GIT_SUBPROCESS_DEADLINE,
};
pub use commit_changes::{
    BRANCH_COMMIT_LIST_MAX_ENTRIES, BranchCommit, BranchCommitListObservation,
    COMMIT_CHANGE_LIST_MAX_ENTRIES, CommitChangeEntry, CommitChangesObservation,
};
pub use error::{GitError, GitFailureKind, GitOperation};
pub use health::{
    ChangeState, ContentState, LockState, SubmoduleFacts, SubmoduleState, UpstreamState,
    WorktreeHealthObservation, WorktreeObservationBudget, WorktreeStatusFacts,
};
pub use mutation::{GitReflogMessage, RefRecoveryFacts, ReflogEntry};
pub use pre_image::{PreImageContent, PreImageObservation, PreImageRevision};
pub use remote::{BranchRemoteFacts, RemoteBranchFact, RemoteFact};
pub use repair::WorktreeRepairFacts;
pub use repository::{GitRefName, HeadState, LocalBranchList, ObjectId, RepositoryFacts};
pub use worktree::{GitText, RegisteredPathState, WorktreeCheckout, WorktreeFacts, WorktreeMarker};
pub use worktree_branches::{WORKTREE_BRANCH_REFLOG_ENTRY_LIMIT, WorktreeBranchEvidence};

pub fn module_name() -> &'static str {
    "gitio"
}
