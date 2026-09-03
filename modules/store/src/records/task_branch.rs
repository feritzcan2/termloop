use std::collections::HashSet;

use termloop_domain::{TASK_BRANCH_MEMBERSHIPS_MAX, TaskBranchMembership, TaskBranchSet};

use super::super::{CoreWriteAuthority, CurrentState, Store, StoreError};

impl Store {
    /// Monotonically adds exact-worktree branch evidence to the Task's bounded
    /// current membership set. Existing rows retain their first observation.
    pub fn reconcile_task_branch_set(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        expected_worktree_generation: u64,
        expected_repository_common_dir: &str,
        incoming: Vec<TaskBranchMembership>,
        evidence_truncated: bool,
    ) -> Result<TaskBranchSet, StoreError> {
        let task = self
            .state
            .tasks
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(StoreError::NotFound)?;
        let binding = task
            .branch
            .as_ref()
            .ok_or(StoreError::ConstraintViolation)?;
        let proof = self
            .state
            .managed_worktrees
            .iter()
            .find(|proof| proof.task_id == task_id)
            .ok_or(StoreError::ConstraintViolation)?;
        if task.worktree_generation != expected_worktree_generation
            || proof.worktree_generation != expected_worktree_generation
            || proof.repository_common_dir != expected_repository_common_dir
            || proof.normalized_spec.repository_root != binding.repository_root
        {
            return Err(StoreError::ConstraintViolation);
        }

        let primary_ref = format!("refs/heads/{}", binding.name);
        let mut incoming_refs = HashSet::new();
        for membership in &incoming {
            if membership.id.is_empty()
                || membership.id.len() > 64
                || membership.repository_root != binding.repository_root
                || membership.repository_common_dir != expected_repository_common_dir
                || membership.first_observed_worktree_generation != expected_worktree_generation
                || membership.ref_name == primary_ref
                || !valid_local_ref(&membership.ref_name)
                || membership
                    .parent_ref_name
                    .as_deref()
                    .is_some_and(|reference| !valid_ref(reference))
                || !valid_oid(&membership.first_observed_oid)
                || !incoming_refs.insert(membership.ref_name.as_str())
            {
                return Err(StoreError::ConstraintViolation);
            }
        }

        let existing_index = self
            .state
            .task_branch_sets
            .iter()
            .position(|set| set.task_id == task_id);
        let existing_memberships = existing_index
            .map(|index| self.state.task_branch_sets[index].memberships.as_slice())
            .unwrap_or(&[]);
        let additions = incoming
            .into_iter()
            .filter(|candidate| {
                !existing_memberships.iter().any(|existing| {
                    existing.repository_common_dir == candidate.repository_common_dir
                        && existing.ref_name == candidate.ref_name
                })
            })
            .collect::<Vec<_>>();
        if existing_memberships.len().saturating_add(additions.len()) > TASK_BRANCH_MEMBERSHIPS_MAX
            || additions.iter().any(|candidate| {
                self.state.task_branch_sets.iter().any(|set| {
                    set.memberships
                        .iter()
                        .any(|membership| membership.id == candidate.id)
                })
            })
        {
            return Err(StoreError::ConstraintViolation);
        }

        if additions.is_empty()
            && existing_index.is_none_or(|index| {
                !evidence_truncated || self.state.task_branch_sets[index].evidence_truncated
            })
        {
            return Ok(existing_index
                .map(|index| self.state.task_branch_sets[index].clone())
                .unwrap_or(TaskBranchSet {
                    task_id: task_id.to_owned(),
                    evidence_truncated: false,
                    memberships: Vec::new(),
                }));
        }

        let previous = self.state.clone();
        let set = if let Some(index) = existing_index {
            let set = &mut self.state.task_branch_sets[index];
            set.evidence_truncated |= evidence_truncated;
            set.memberships.extend(additions);
            set
        } else {
            self.state.task_branch_sets.push(TaskBranchSet {
                task_id: task_id.to_owned(),
                evidence_truncated,
                memberships: additions,
            });
            self.state
                .task_branch_sets
                .last_mut()
                .expect("Task branch set was inserted")
        };
        let result = set.clone();
        self.commit_or_restore(previous)?;
        Ok(result)
    }
}

pub(crate) fn task_branch_sets_are_invalid(state: &CurrentState) -> bool {
    let mut ids = HashSet::new();
    !state.task_branch_sets.iter().all(|set| {
        let Some(task) = state.tasks.iter().find(|task| task.id == set.task_id) else {
            return false;
        };
        let Some(binding) = task.branch.as_ref() else {
            return false;
        };
        let primary_ref = format!("refs/heads/{}", binding.name);
        set.memberships.len() <= TASK_BRANCH_MEMBERSHIPS_MAX
            && state
                .task_branch_sets
                .iter()
                .filter(|candidate| candidate.task_id == set.task_id)
                .count()
                == 1
            && set.memberships.iter().all(|membership| {
                ids.insert(membership.id.as_str())
                    && !membership.id.is_empty()
                    && membership.id.len() <= 64
                    && membership.repository_root == binding.repository_root
                    && !membership.repository_common_dir.is_empty()
                    && membership.ref_name != primary_ref
                    && valid_local_ref(&membership.ref_name)
                    && membership.parent_ref_name.as_deref().is_none_or(valid_ref)
                    && valid_oid(&membership.first_observed_oid)
                    && membership.first_observed_worktree_generation > 0
                    && membership.first_observed_worktree_generation <= task.worktree_generation
            })
            && set
                .memberships
                .iter()
                .enumerate()
                .all(|(index, membership)| {
                    !set.memberships[index + 1..].iter().any(|candidate| {
                        candidate.repository_common_dir == membership.repository_common_dir
                            && candidate.ref_name == membership.ref_name
                    })
                })
    })
}

fn valid_local_ref(reference: &str) -> bool {
    reference.starts_with("refs/heads/") && valid_ref(reference)
}

fn valid_ref(reference: &str) -> bool {
    !reference.is_empty()
        && reference.len() <= 1024
        && reference.starts_with("refs/")
        && !reference.bytes().any(|byte| byte.is_ascii_control())
        && !reference.contains([' ', '~', '^', ':', '?', '*', '[', '\\'])
        && !reference.contains("..")
        && !reference.ends_with(['.', '/'])
}

fn valid_oid(oid: &str) -> bool {
    matches!(oid.len(), 40 | 64) && oid.bytes().all(|byte| byte.is_ascii_hexdigit())
}
