use termloop_domain::{
    COMPANION_TRANSCRIPT_HARD_BYTES, COMPANION_TRANSCRIPT_HARD_MESSAGES, IssueLinkProvider,
    SessionKind, SessionRelocationStage, SessionRelocationTarget, TASK_STEWARD_BRIEF_MAX_BYTES,
    TaskStatus, TaskSuspensionReason, WorktreeCleanupBlocker, WorktreeCleanupFailure,
    WorktreeCleanupMode, WorktreeCleanupOperation, WorktreeCleanupReceipt,
    WorktreeStaleResolutionFailure, WorktreeStaleResolutionOperation,
    WorktreeStaleResolutionReceipt,
};

use super::{
    CURRENT_SCHEMA_VERSION, CurrentState, StoreError, ensure_repair_tuple,
    ensure_stale_resolution_tuple,
};

pub(super) fn validate_stale_resolution_failure(
    failure: &WorktreeStaleResolutionFailure,
) -> Result<(), StoreError> {
    if failure.blockers.len() > 32
        || failure.blockers.iter().enumerate().any(|(index, blocker)| {
            failure.blockers[index + 1..]
                .iter()
                .any(|candidate| candidate == blocker)
        })
    {
        Err(StoreError::ConstraintViolation)
    } else {
        Ok(())
    }
}

pub(super) fn validate_current_state(state: &CurrentState) -> Result<(), StoreError> {
    if state.schema_version != CURRENT_SCHEMA_VERSION
        || companion_records_are_invalid(state)
        || steward_configurations_are_invalid(state)
        || steward_conversation_refs_are_invalid(state)
        || worker_configurations_are_invalid(state)
        || run_configurations_are_invalid(state)
        || run_setup_marks_are_invalid(state)
        || configuration_versions_are_invalid(state)
        || tracker_configurations_are_invalid(state)
        || playbook_configurations_are_invalid(state)
        || playbook_step_progress_is_invalid(state)
        || sessions_are_invalid(state)
        || deleted_sessions_are_invalid(state)
        || agent_conversation_readiness_is_invalid(state)
        || agent_plans_are_invalid(state)
        || issue_links_are_invalid(state)
        || task_source_configurations_are_invalid(state)
        || project_task_automation_configurations_are_invalid(state)
        || archive_records_are_invalid(state)
        || relocation_records_are_invalid(state)
        || state
            .last_agent_launch_selection
            .as_ref()
            .is_some_and(|selection| !selection.is_valid())
        || state
            .mcp_tool_description_overrides
            .iter()
            .enumerate()
            .any(|(index, value)| {
                !value.description.validate()
                    || state.mcp_tool_description_overrides[index + 1..]
                        .iter()
                        .any(|candidate| candidate.tool == value.tool)
            })
        || state.tasks.iter().any(|task| {
            (task.worktree.is_some() && task.branch.is_none())
                || task.steward_brief_revision == 0
                || task.steward_brief_markdown.len() > TASK_STEWARD_BRIEF_MAX_BYTES
                || (!task.steward_brief_markdown.is_empty()
                    && task.steward_brief_markdown.trim().is_empty())
        })
        || has_duplicate_task_ids(&state.cleanup_operations)
        || has_duplicate_receipt_task_ids(&state.cleanup_receipts)
        || has_duplicate_stale_task_ids(&state.stale_resolution_operations)
        || has_duplicate_stale_receipt_task_ids(&state.stale_resolution_receipts)
        || state
            .repair_operations
            .iter()
            .enumerate()
            .any(|(index, operation)| {
                state.repair_operations[index + 1..]
                    .iter()
                    .any(|candidate| candidate.task_id == operation.task_id)
            })
        || state
            .repair_receipts
            .iter()
            .enumerate()
            .any(|(index, receipt)| {
                state.repair_receipts[index + 1..]
                    .iter()
                    .any(|candidate| candidate.task_id == receipt.task_id)
            })
        || state.repair_operations.iter().any(|repair| {
            state
                .cleanup_operations
                .iter()
                .any(|cleanup| cleanup.task_id == repair.task_id)
                || state
                    .provisioning_operations
                    .iter()
                    .any(|provisioning| provisioning.task_id == repair.task_id)
        })
        || state.cleanup_operations.iter().any(|cleanup| {
            state
                .provisioning_operations
                .iter()
                .any(|provisioning| provisioning.task_id == cleanup.task_id)
        })
        || state.stale_resolution_operations.iter().any(|stale| {
            state
                .provisioning_operations
                .iter()
                .any(|operation| operation.task_id == stale.task_id)
                || state
                    .cleanup_operations
                    .iter()
                    .any(|operation| operation.task_id == stale.task_id)
                || state
                    .repair_operations
                    .iter()
                    .any(|operation| operation.task_id == stale.task_id)
        })
        || state.cleanup_operations.iter().any(|operation| {
            validate_cleanup_intent(
                operation.cleanup_mode,
                &operation.acknowledged_content_blockers,
            )
            .is_err()
        })
        || state.cleanup_receipts.iter().any(|receipt| {
            validate_cleanup_intent(receipt.cleanup_mode, &receipt.acknowledged_content_blockers)
                .is_err()
        })
        || state
            .cleanup_operations
            .iter()
            .filter_map(|operation| operation.failure.as_ref())
            .any(|failure| validate_cleanup_failure(failure).is_err())
        || state
            .repair_operations
            .iter()
            .filter_map(|operation| operation.failure.as_ref())
            .any(|failure| {
                failure.blockers.len() > 32
                    || failure
                        .blockers
                        .iter()
                        .enumerate()
                        .any(|(index, blocker)| failure.blockers[index + 1..].contains(blocker))
            })
        || state
            .repair_operations
            .iter()
            .any(|operation| ensure_repair_tuple(state, operation).is_err())
        || state.stale_resolution_operations.iter().any(|operation| {
            ensure_stale_resolution_tuple(state, operation).is_err()
                || operation
                    .failure
                    .as_ref()
                    .is_some_and(|failure| validate_stale_resolution_failure(failure).is_err())
        })
    {
        return Err(StoreError::CorruptRecord);
    }
    Ok(())
}

fn configuration_versions_are_invalid(state: &CurrentState) -> bool {
    use termloop_domain::{CONFIGURATION_VERSIONS_PER_TARGET_MAX, ImproverSessionTargetKind};

    let target_exists = |project_id: &str, target: &termloop_domain::ImproverSessionTarget| {
        if !state
            .projects
            .iter()
            .any(|project| project.id == project_id)
        {
            return false;
        }
        match target.target_kind {
            ImproverSessionTargetKind::StewardInstructions => state
                .steward_configurations
                .iter()
                .any(|configuration| configuration.project_id == project_id),
            ImproverSessionTargetKind::WorkerInstructions
            | ImproverSessionTargetKind::RoutineBuilder => {
                target.target_id.as_deref().is_some_and(|id| {
                    state.worker_configurations.iter().any(|configuration| {
                        configuration.project_id == project_id && configuration.id == id
                    })
                })
            }
            ImproverSessionTargetKind::RoutineInstructions => {
                target.target_id.as_deref().is_some_and(|id| {
                    state.tracker_configurations.iter().any(|configuration| {
                        configuration.project_id == project_id && configuration.id == id
                    })
                })
            }
            ImproverSessionTargetKind::Playbook => true,
            ImproverSessionTargetKind::RunConfiguration => {
                target.target_id.as_deref().is_some_and(|id| {
                    state.run_configurations.iter().any(|configuration| {
                        configuration.project_id == project_id && configuration.id == id
                    })
                })
            }
            ImproverSessionTargetKind::NewRunConfiguration
            | ImproverSessionTargetKind::SettingsSkill
            | ImproverSessionTargetKind::SettingsPrompt
            | ImproverSessionTargetKind::SettingsMcpTool => true,
        }
    };

    let versions_are_invalid =
        state
            .configuration_versions
            .iter()
            .enumerate()
            .any(|(index, version)| {
                !version.is_well_formed()
                    || !target_exists(&version.project_id, &version.target)
                    || state.configuration_versions[index + 1..]
                        .iter()
                        .any(|candidate| {
                            candidate.id == version.id
                                || candidate.project_id == version.project_id
                                    && candidate.target == version.target
                                    && candidate.sequence == version.sequence
                        })
                    || state
                        .configuration_versions
                        .iter()
                        .filter(|candidate| {
                            candidate.project_id == version.project_id
                                && candidate.target == version.target
                        })
                        .count()
                        > CONFIGURATION_VERSIONS_PER_TARGET_MAX
            });
    let selections_are_invalid = state
        .configuration_version_selections
        .iter()
        .enumerate()
        .any(|(index, selection)| {
            !selection.is_well_formed()
                || state.configuration_version_selections[index + 1..]
                    .iter()
                    .any(|candidate| {
                        candidate.project_id == selection.project_id
                            && candidate.target == selection.target
                    })
                || !state.configuration_versions.iter().any(|version| {
                    version.id == selection.version_id
                        && version.project_id == selection.project_id
                        && version.target == selection.target
                })
        });
    let missing_selection = state.configuration_versions.iter().any(|version| {
        !state
            .configuration_version_selections
            .iter()
            .any(|selection| {
                selection.project_id == version.project_id && selection.target == version.target
            })
    });
    versions_are_invalid || selections_are_invalid || missing_selection
}

fn agent_plans_are_invalid(state: &CurrentState) -> bool {
    state.agent_plans.iter().enumerate().any(|(index, plan)| {
        !plan.is_well_formed()
            || state.agent_plans[index + 1..]
                .iter()
                .any(|candidate| candidate.session_id == plan.session_id)
            || state
                .sessions
                .iter()
                .find(|session| session.id == plan.session_id)
                .is_none_or(|session| {
                    session.kind != SessionKind::Agent
                        || !matches!(
                            (session.process.agent_id.as_deref(), plan.source),
                            (
                                Some("claude"),
                                termloop_domain::DurableAgentPlanSource::ClaudeHook
                            ) | (
                                Some("codex"),
                                termloop_domain::DurableAgentPlanSource::CodexAppServer
                            )
                        )
                })
    })
}

fn relocation_records_are_invalid(state: &CurrentState) -> bool {
    let operation_invalid =
        state
            .session_relocation_operations
            .iter()
            .enumerate()
            .any(|(index, operation)| {
                let session = state
                    .sessions
                    .iter()
                    .find(|session| session.id == operation.session_id);
                let task = state
                    .tasks
                    .iter()
                    .find(|task| task.id == operation.target_task_id);
                let proof = state
                    .managed_worktrees
                    .iter()
                    .find(|proof| proof.task_id == operation.target_task_id);
                let project = state
                    .projects
                    .iter()
                    .find(|project| project.id == operation.project_id);
                operation.operation_id.is_empty()
                    || operation.operation_id.len() > 64
                    || operation.started_at_epoch_ms == 0
                    || operation.updated_at_epoch_ms < operation.started_at_epoch_ms
                    || operation.target_cwd == operation.source_cwd
                    || !matches!(
                        operation.stage,
                        SessionRelocationStage::SourceRetiring
                            | SessionRelocationStage::TargetStarting
                    )
                    || session.is_none_or(|session| {
                        session.kind != SessionKind::Agent
                            || session.project_id != operation.project_id
                            || session.runtime_epoch != operation.source_runtime_epoch
                            || session.process.cwd != operation.source_cwd
                            || session.lifecycle_state != "resuming"
                            || session.archived_at_epoch_ms.is_some()
                            || session
                                .resume_ref
                                .as_ref()
                                .is_none_or(|value| !value.validate())
                    })
                    || project.is_none_or(|project| {
                        operation.target == SessionRelocationTarget::ProjectRoot
                            && project.folder_path != operation.target_cwd
                    })
                    || task.is_none_or(|task| {
                        task.project_id != operation.project_id
                            || (operation.target == SessionRelocationTarget::TaskWorktree
                                && task.status != TaskStatus::Open)
                            || task.archived_at_epoch_ms.is_some()
                            || task.worktree_generation != operation.target_worktree_generation
                            || task.worktree.as_ref().is_none_or(|binding| {
                                operation.target == SessionRelocationTarget::TaskWorktree
                                    && binding.path != operation.target_cwd
                                    || operation.target == SessionRelocationTarget::ProjectRoot
                                        && binding.path != operation.source_cwd
                                        && session.is_none_or(|session| {
                                            session.resume_launch_guard.as_ref().is_none_or(
                                                |guard| {
                                                    guard.task_id != task.id
                                                        || guard.path != binding.path
                                                },
                                            )
                                        })
                            })
                    })
                    || proof.is_none_or(|proof| {
                        proof.operation_id != operation.target_managed_worktree_operation_id
                            || proof.worktree_generation != operation.target_worktree_generation
                            || task.is_none_or(|task| {
                                task.worktree.as_ref().is_none_or(|binding| {
                                    proof.registered_worktree_path != binding.path
                                })
                            })
                    })
                    || state
                        .session_archive_operations
                        .iter()
                        .any(|current| current.session_id == operation.session_id)
                    || state
                        .task_archive_operations
                        .iter()
                        .any(|current| current.task_id == operation.target_task_id)
                    || state
                        .provisioning_operations
                        .iter()
                        .any(|current| current.task_id == operation.target_task_id)
                    || state
                        .cleanup_operations
                        .iter()
                        .any(|current| current.task_id == operation.target_task_id)
                    || state
                        .repair_operations
                        .iter()
                        .any(|current| current.task_id == operation.target_task_id)
                    || state
                        .stale_resolution_operations
                        .iter()
                        .any(|current| current.task_id == operation.target_task_id)
                    || state.session_relocation_operations[index + 1..]
                        .iter()
                        .any(|candidate| {
                            candidate.session_id == operation.session_id
                                || candidate.operation_id == operation.operation_id
                        })
            });
    let receipt_invalid =
        state
            .session_relocation_receipts
            .iter()
            .enumerate()
            .any(|(index, receipt)| {
                let session = state
                    .sessions
                    .iter()
                    .find(|session| session.id == receipt.session_id);
                receipt.operation_id.is_empty()
                    || receipt.operation_id.len() > 64
                    || receipt.runtime_epoch == 0
                    || session.is_none_or(|session| {
                        session.kind != SessionKind::Agent
                            || session.project_id != receipt.project_id
                            || session.runtime_epoch != receipt.runtime_epoch
                            || session.process.cwd != receipt.target_cwd
                            || match receipt.target {
                                SessionRelocationTarget::TaskWorktree => {
                                    session.resume_launch_guard.as_ref().is_none_or(|guard| {
                                        guard.task_id != receipt.target_task_id
                                            || guard.managed_worktree_operation_id
                                                != receipt.target_managed_worktree_operation_id
                                            || guard.worktree_generation
                                                != receipt.target_worktree_generation
                                            || guard.path != receipt.target_cwd
                                    })
                                }
                                SessionRelocationTarget::ProjectRoot => {
                                    session.resume_launch_guard.is_some()
                                        || state.projects.iter().all(|project| {
                                            project.id != receipt.project_id
                                                || project.folder_path != receipt.target_cwd
                                        })
                                }
                            }
                    })
                    || state.session_relocation_receipts[index + 1..]
                        .iter()
                        .any(|candidate| {
                            candidate.session_id == receipt.session_id
                                || candidate.operation_id == receipt.operation_id
                        })
                    || state.session_relocation_operations.iter().any(|operation| {
                        operation.session_id == receipt.session_id
                            || operation.operation_id == receipt.operation_id
                    })
            });
    operation_invalid || receipt_invalid
}

fn archive_records_are_invalid(state: &CurrentState) -> bool {
    let invalid_session_operation =
        state
            .session_archive_operations
            .iter()
            .enumerate()
            .any(|(index, operation)| {
                operation.operation_id.is_empty()
                    || operation.requested_at_epoch_ms == 0
                    || state
                        .sessions
                        .iter()
                        .find(|session| session.id == operation.session_id)
                        .is_none_or(|session| {
                            session.project_id != operation.project_id
                                || session.kind != SessionKind::Agent
                                || session.runtime_epoch != operation.runtime_epoch
                                || session.archived_at_epoch_ms.is_some()
                        })
                    || state.session_archive_operations[index + 1..]
                        .iter()
                        .any(|candidate| {
                            candidate.session_id == operation.session_id
                                || candidate.operation_id == operation.operation_id
                        })
            });
    let invalid_operation =
        state
            .task_archive_operations
            .iter()
            .enumerate()
            .any(|(index, operation)| {
                let task = state.tasks.iter().find(|task| task.id == operation.task_id);
                task.is_none_or(|task| {
                    task.archived_at_epoch_ms.is_some()
                        || task.project_id != operation.project_id
                        || task.worktree.as_ref().map(|binding| binding.path.as_str())
                            != operation.worktree_path.as_deref()
                        || task.worktree_generation != operation.worktree_generation
                }) || operation.operation_id.is_empty()
                    || state.task_archive_operations[index + 1..]
                        .iter()
                        .any(|candidate| {
                            candidate.task_id == operation.task_id
                                || candidate.operation_id == operation.operation_id
                        })
                    || operation
                        .targets
                        .iter()
                        .enumerate()
                        .any(|(target_index, target)| {
                            state
                                .task_archive_suspensions
                                .iter()
                                .any(|suspension| suspension.session_id == target.session_id)
                                || !state.sessions.iter().any(|session| {
                                    session.id == target.session_id
                                        && session.project_id == operation.project_id
                                        && session.runtime_epoch == target.runtime_epoch
                                })
                                || operation.targets[target_index + 1..]
                                    .iter()
                                    .any(|candidate| candidate.session_id == target.session_id)
                        })
            });
    let invalid_suspension =
        state
            .task_archive_suspensions
            .iter()
            .enumerate()
            .any(|(index, suspension)| {
                let session = state
                    .sessions
                    .iter()
                    .find(|session| session.id == suspension.session_id);
                session.is_none_or(|session| {
                    !state.tasks.iter().any(|task| {
                        task.project_id == session.project_id
                            && suspension
                                .task_id
                                .as_ref()
                                .is_none_or(|task_id| task_id == &task.id)
                            && match suspension.reason {
                                TaskSuspensionReason::Archived => {
                                    task.archived_at_epoch_ms
                                        == Some(suspension.archived_at_epoch_ms)
                                }
                                TaskSuspensionReason::ClosedWorktreeRemoved => {
                                    suspension.task_id.as_deref() == Some(task.id.as_str())
                                        && task.archived_at_epoch_ms.is_none()
                                        && task.status == TaskStatus::Closed
                                        && task.worktree.is_none()
                                }
                            }
                    })
                }) || state.task_archive_suspensions[index + 1..]
                    .iter()
                    .any(|candidate| candidate.session_id == suspension.session_id)
            });
    invalid_session_operation || invalid_operation || invalid_suspension
}

fn issue_links_are_invalid(state: &CurrentState) -> bool {
    state.issue_links.iter().enumerate().any(|(index, link)| {
        !state.tasks.iter().any(|task| task.id == link.task_id)
            || link.external_ref.is_empty()
            || link.external_ref.len() > 85
            || link.source_id.as_ref().is_some_and(|value| {
                value.is_empty()
                    || value.len() > 64
                    || link.external_id.is_none()
                    || link.external_updated_at.is_none()
            })
            || link.external_id.as_ref().is_some_and(|value| {
                value.is_empty()
                    || value.len() > termloop_domain::TASK_SOURCE_EXTERNAL_ID_MAX_BYTES
                    || !value.bytes().all(|byte| byte.is_ascii_digit())
                    || link.source_id.is_none()
            })
            || link.external_updated_at.as_ref().is_some_and(|value| {
                value.is_empty()
                    || value.len() > 128
                    || value.bytes().any(|byte| byte.is_ascii_control())
                    || link.source_id.is_none()
                    || link.external_id.is_none()
            })
            || link.url.as_ref().is_some_and(|url| {
                url.is_empty()
                    || url.len() > 2_048
                    || url.bytes().any(|byte| byte.is_ascii_control())
                    || url.contains(['?', '#', '@'])
            })
            || state.issue_links[index + 1..].iter().any(|candidate| {
                (candidate.task_id == link.task_id
                    && candidate.provider == IssueLinkProvider::Jira
                    && link.provider == IssueLinkProvider::Jira)
                    || super::records::issue_link::same_source_issue(candidate, link)
                    || super::records::issue_link::same_site_issue(candidate, link)
            })
    })
}

fn task_source_configurations_are_invalid(state: &CurrentState) -> bool {
    state
        .task_source_configurations
        .iter()
        .enumerate()
        .any(|(index, source)| {
            !source.is_valid()
                || !state
                    .projects
                    .iter()
                    .any(|project| project.id == source.project_id)
                || state.task_source_configurations[index + 1..]
                    .iter()
                    .any(|candidate| candidate.id == source.id)
                || state
                    .task_source_configurations
                    .iter()
                    .filter(|candidate| candidate.project_id == source.project_id)
                    .count()
                    > termloop_domain::TASK_SOURCES_PER_PROJECT_MAX
        })
}

fn project_task_automation_configurations_are_invalid(state: &CurrentState) -> bool {
    state
        .project_task_automation_configurations
        .iter()
        .enumerate()
        .any(|(index, configuration)| {
            !configuration.is_valid()
                || !state
                    .projects
                    .iter()
                    .any(|project| project.id == configuration.project_id)
                || state.project_task_automation_configurations[index + 1..]
                    .iter()
                    .any(|candidate| candidate.project_id == configuration.project_id)
        })
}

fn sessions_are_invalid(state: &CurrentState) -> bool {
    state.sessions.iter().enumerate().any(|(index, session)| {
        let invalid_kind = match session.kind {
            SessionKind::Agent => {
                session.process.agent_id.is_none() || !session.launch_selection.is_well_formed()
            }
            SessionKind::Terminal => !session.launch_selection.is_default(),
        };
        let invalid_ask_to_source =
            session
                .ask_to_source_session_id
                .as_ref()
                .is_some_and(|source_id| {
                    source_id.is_empty()
                        || session.kind != SessionKind::Agent
                        || source_id == &session.id
                        || session.process.template_ref.as_deref()
                            != Some("builtin.agent.ask-to-helper")
                        || state
                            .sessions
                            .iter()
                            .find(|source| source.id == *source_id)
                            .is_some_and(|source| {
                                source.kind != SessionKind::Agent
                                    || source.project_id != session.project_id
                            })
                });
        let invalid_ask_to_continuation =
            session
                .ask_to_continuation
                .as_ref()
                .is_some_and(|continuation| {
                    !continuation.is_well_formed()
                        || session.ask_to_source_session_id.is_none()
                        || !state.sessions.iter().any(|source| {
                            session.ask_to_source_session_id.as_deref() == Some(source.id.as_str())
                                && source.kind == SessionKind::Agent
                                && source.project_id == session.project_id
                        })
                        || state.sessions[index + 1..].iter().any(|candidate| {
                            candidate
                                .ask_to_continuation
                                .as_ref()
                                .is_some_and(|candidate| {
                                    candidate.conversation_id == continuation.conversation_id
                                })
                        })
                        || continuation.current_request_id.is_some()
                            && state.sessions[index + 1..].iter().any(|candidate| {
                                candidate.ask_to_source_session_id
                                    == session.ask_to_source_session_id
                                    && candidate.ask_to_continuation.as_ref().is_some_and(
                                        |candidate| candidate.current_request_id.is_some(),
                                    )
                            })
                });
        let invalid_run_configuration = session.run_configuration_id.as_ref().is_some_and(|id| {
            session.kind != SessionKind::Terminal
                || !state.run_configurations.iter().any(|configuration| {
                    configuration.id == *id && configuration.project_id == session.project_id
                })
        });
        let invalid_improver_target = session.improver_target.as_ref().is_some_and(|target| {
            use termloop_domain::ImproverSessionTargetKind;
            let expected_template = match target.target_kind {
                ImproverSessionTargetKind::StewardInstructions => {
                    "builtin.improver.steward-instructions"
                }
                ImproverSessionTargetKind::WorkerInstructions => {
                    "builtin.improver.worker-instructions"
                }
                ImproverSessionTargetKind::RoutineInstructions => {
                    "builtin.improver.routine-instructions"
                }
                ImproverSessionTargetKind::RoutineBuilder => "builtin.builder.routine",
                ImproverSessionTargetKind::Playbook => "builtin.builder.playbook",
                ImproverSessionTargetKind::RunConfiguration => "builtin.improver.run-configuration",
                ImproverSessionTargetKind::NewRunConfiguration => {
                    "builtin.improver.run-configuration-new"
                }
                ImproverSessionTargetKind::SettingsSkill => "builtin.improver.skill-definition",
                ImproverSessionTargetKind::SettingsPrompt => "builtin.improver.prompt-asset",
                ImproverSessionTargetKind::SettingsMcpTool => {
                    "builtin.improver.mcp-tool-description"
                }
            };
            session.kind != SessionKind::Agent
                || !target.is_well_formed()
                || session.process.template_ref.as_deref() != Some(expected_template)
        });
        invalid_kind
            || invalid_ask_to_source
            || invalid_ask_to_continuation
            || invalid_run_configuration
            || invalid_improver_target
    })
}

fn deleted_sessions_are_invalid(state: &CurrentState) -> bool {
    state
        .deleted_sessions
        .iter()
        .enumerate()
        .any(|(index, deleted)| {
            let session = &deleted.session;
            deleted.deleted_at_epoch_ms == 0
                || session.kind != SessionKind::Agent
                || session.process.agent_id.is_none()
                || !session.launch_selection.is_well_formed()
                || session.archived_at_epoch_ms.is_some()
                || !matches!(
                    session.lifecycle_state.as_str(),
                    "exited" | "stale" | "resumeFailed"
                )
                || matches!(
                    session.resume_failure,
                    Some(
                        termloop_domain::ResumeFailureReason::RuntimeOwnershipUncertain
                            | termloop_domain::ResumeFailureReason::RuntimeConflict
                    )
                )
                || session.ask_to_continuation.is_some()
                || state.sessions.iter().any(|active| active.id == session.id)
                || state.deleted_sessions[index + 1..]
                    .iter()
                    .any(|candidate| candidate.session.id == session.id)
        })
}

fn agent_conversation_readiness_is_invalid(state: &CurrentState) -> bool {
    let agent_session_count = state
        .sessions
        .iter()
        .filter(|session| session.kind == SessionKind::Agent)
        .count();
    state.agent_conversation_readiness.len() != agent_session_count
        || state
            .agent_conversation_readiness
            .iter()
            .enumerate()
            .any(|(index, record)| {
                record.session_id.is_empty()
                    || !state.sessions.iter().any(|session| {
                        session.id == record.session_id && session.kind == SessionKind::Agent
                    })
                    || state.agent_conversation_readiness[index + 1..]
                        .iter()
                        .any(|candidate| candidate.session_id == record.session_id)
            })
}

fn steward_configurations_are_invalid(state: &CurrentState) -> bool {
    state
        .steward_configurations
        .iter()
        .enumerate()
        .any(|(index, configuration)| {
            !configuration.is_valid()
                || !state
                    .projects
                    .iter()
                    .any(|project| project.id == configuration.project_id)
                || state.steward_configurations[index + 1..]
                    .iter()
                    .any(|candidate| candidate.project_id == configuration.project_id)
                || configuration
                    .executor_session_id
                    .as_ref()
                    .is_some_and(|session_id| {
                        !state.sessions.iter().any(|session| {
                            session.id == *session_id
                                && session.project_id == configuration.project_id
                        })
                    })
        })
}

fn steward_conversation_refs_are_invalid(state: &CurrentState) -> bool {
    use crate::migration::provider_matches_agent;

    state
        .steward_conversation_refs
        .iter()
        .enumerate()
        .any(|(index, conversation)| {
            let configuration = state
                .steward_configurations
                .iter()
                .find(|configuration| configuration.project_id == conversation.project_id);
            !conversation.is_valid()
                || configuration.is_none_or(|configuration| {
                    let agent_id = match configuration.agent_id {
                        termloop_domain::StewardAgentId::Claude => "claude",
                        termloop_domain::StewardAgentId::Codex => "codex",
                    };
                    !provider_matches_agent(conversation.resume_ref.provider, Some(agent_id))
                })
                || state.steward_conversation_refs[index + 1..]
                    .iter()
                    .any(|candidate| candidate.project_id == conversation.project_id)
        })
}

fn playbook_configurations_are_invalid(state: &CurrentState) -> bool {
    state
        .playbook_configurations
        .iter()
        .enumerate()
        .any(|(index, configuration)| {
            !configuration.is_valid()
                || !state
                    .projects
                    .iter()
                    .any(|project| project.id == configuration.project_id)
                // Every step names the Routine that checks it, and that
                // Routine must exist in the same Project. A step pointing at
                // nothing could never be decided — including one in a pipeline
                // the Project has switched away from but kept.
                || configuration.all_milestones().any(|milestone| {
                    !state.tracker_configurations.iter().any(|routine| {
                        routine.id == milestone.routine_id
                            && routine.project_id == configuration.project_id
                    })
                })
                || state.playbook_configurations[index + 1..]
                    .iter()
                    .any(|candidate| candidate.project_id == configuration.project_id)
        })
}

fn playbook_step_progress_is_invalid(state: &CurrentState) -> bool {
    state
        .playbook_step_progress
        .iter()
        .enumerate()
        .any(|(index, progress)| {
            crate::records::playbook::step_progress_conflicts(
                state,
                progress,
                &state.playbook_step_progress[index + 1..],
            )
        })
}

fn tracker_configurations_are_invalid(state: &CurrentState) -> bool {
    state
        .tracker_configurations
        .iter()
        .enumerate()
        .any(|(index, configuration)| {
            !configuration.is_valid()
                || !state
                    .projects
                    .iter()
                    .any(|project| project.id == configuration.project_id)
                || state.tracker_configurations[index + 1..]
                    .iter()
                    .any(|candidate| candidate.id == configuration.id)
                || !state.worker_configurations.iter().any(|worker| {
                    worker.id == configuration.worker_id
                        && worker.project_id == configuration.project_id
                })
                || configuration.related_task_ids.iter().any(|task_id| {
                    !state.tasks.iter().any(|task| {
                        task.id == *task_id && task.project_id == configuration.project_id
                    })
                })
                || configuration
                    .pending_routine_findings
                    .iter()
                    .flat_map(|finding| finding.related_task_ids.iter())
                    .any(|task_id| {
                        !state.tasks.iter().any(|task| {
                            task.id == *task_id && task.project_id == configuration.project_id
                        })
                    })
        })
}

fn worker_configurations_are_invalid(state: &CurrentState) -> bool {
    state.projects.iter().any(|project| {
        state
            .worker_configurations
            .iter()
            .filter(|configuration| configuration.project_id == project.id)
            .count()
            > termloop_domain::WORKERS_PER_PROJECT_MAX
    }) || state
        .worker_configurations
        .iter()
        .enumerate()
        .any(|(index, configuration)| {
            !configuration.is_valid()
                || !state
                    .projects
                    .iter()
                    .any(|project| project.id == configuration.project_id)
                || state.worker_configurations[index + 1..]
                    .iter()
                    .any(|candidate| candidate.id == configuration.id)
                || configuration
                    .executor_session_id
                    .as_ref()
                    .is_some_and(|session_id| {
                        !state.sessions.iter().any(|session| {
                            session.id == *session_id
                                && session.project_id == configuration.project_id
                        })
                    })
        })
}

fn run_configurations_are_invalid(state: &CurrentState) -> bool {
    state.projects.iter().any(|project| {
        state
            .run_configurations
            .iter()
            .filter(|configuration| configuration.project_id == project.id)
            .count()
            > termloop_domain::RUN_CONFIGURATIONS_PER_PROJECT_MAX
    }) || state
        .run_configurations
        .iter()
        .enumerate()
        .any(|(index, configuration)| {
            !configuration.is_valid()
                || !state
                    .projects
                    .iter()
                    .any(|project| project.id == configuration.project_id)
                || state.run_configurations[index + 1..]
                    .iter()
                    .any(|candidate| candidate.id == configuration.id)
        })
}

fn run_setup_marks_are_invalid(state: &CurrentState) -> bool {
    state.projects.iter().any(|project| {
        state
            .run_setup_marks
            .iter()
            .filter(|mark| mark.project_id == project.id)
            .count()
            > termloop_domain::RUN_SETUP_MARKS_PER_PROJECT_MAX
    }) || state
        .run_setup_marks
        .iter()
        .enumerate()
        .any(|(index, mark)| {
            !mark.is_valid()
                || !state.run_configurations.iter().any(|configuration| {
                    configuration.id == mark.configuration_id
                        && configuration.project_id == mark.project_id
                })
                || state.run_setup_marks[index + 1..].iter().any(|candidate| {
                    candidate.configuration_id == mark.configuration_id
                        && candidate.worktree_path == mark.worktree_path
                })
        })
}

fn companion_records_are_invalid(state: &CurrentState) -> bool {
    use std::collections::{BTreeMap, BTreeSet};

    let project_ids = state
        .projects
        .iter()
        .map(|project| project.id.as_str())
        .collect::<BTreeSet<_>>();
    let mut message_ids = BTreeSet::new();
    let mut expected_sequences = BTreeMap::<&str, u64>::new();
    let mut by_project = BTreeMap::<&str, Vec<&termloop_domain::CompanionMessage>>::new();
    for message in &state.companion_messages {
        let expected = expected_sequences.entry(&message.project_id).or_insert(1);
        if !message.is_valid()
            || !project_ids.contains(message.project_id.as_str())
            || !message_ids.insert(message.id.as_str())
            || message.sequence != *expected
        {
            return true;
        }
        *expected = match expected.checked_add(1) {
            Some(value) => value,
            None => return true,
        };
        by_project
            .entry(&message.project_id)
            .or_default()
            .push(message);
    }
    if by_project.values().any(|messages| {
        messages.len() > COMPANION_TRANSCRIPT_HARD_MESSAGES
            || serde_json::to_vec(messages)
                .map_or(true, |bytes| bytes.len() > COMPANION_TRANSCRIPT_HARD_BYTES)
    }) {
        return true;
    }
    false
}

pub(super) fn validate_cleanup_failure(failure: &WorktreeCleanupFailure) -> Result<(), StoreError> {
    if failure.blockers.len() > 32
        || failure.blockers.iter().enumerate().any(|(index, blocker)| {
            failure.blockers[index + 1..]
                .iter()
                .any(|candidate| candidate == blocker)
        })
    {
        Err(StoreError::ConstraintViolation)
    } else {
        Ok(())
    }
}

pub(super) fn validate_cleanup_intent(
    mode: WorktreeCleanupMode,
    blockers: &[WorktreeCleanupBlocker],
) -> Result<(), StoreError> {
    let canonical = blockers.windows(2).all(|pair| pair[0] < pair[1]);
    let eligible = blockers.iter().all(|blocker| {
        matches!(
            blocker,
            WorktreeCleanupBlocker::TrackedChanges
                | WorktreeCleanupBlocker::StagedChanges
                | WorktreeCleanupBlocker::UntrackedContent
                | WorktreeCleanupBlocker::IgnoredContent
                | WorktreeCleanupBlocker::SubmodulePresent
        )
    });
    let valid = match mode {
        WorktreeCleanupMode::Safe => blockers.is_empty(),
        WorktreeCleanupMode::DiscardCheckoutContent => {
            !blockers.is_empty() && blockers.len() <= 5 && canonical && eligible
        }
    };
    valid.then_some(()).ok_or(StoreError::ConstraintViolation)
}

fn has_duplicate_task_ids(operations: &[WorktreeCleanupOperation]) -> bool {
    operations.iter().enumerate().any(|(index, operation)| {
        operations[index + 1..]
            .iter()
            .any(|candidate| candidate.task_id == operation.task_id)
    })
}

fn has_duplicate_receipt_task_ids(receipts: &[WorktreeCleanupReceipt]) -> bool {
    receipts.iter().enumerate().any(|(index, receipt)| {
        receipts[index + 1..]
            .iter()
            .any(|candidate| candidate.task_id == receipt.task_id)
    })
}

fn has_duplicate_stale_task_ids(operations: &[WorktreeStaleResolutionOperation]) -> bool {
    operations.iter().enumerate().any(|(index, operation)| {
        operations[index + 1..]
            .iter()
            .any(|candidate| candidate.task_id == operation.task_id)
    })
}

fn has_duplicate_stale_receipt_task_ids(receipts: &[WorktreeStaleResolutionReceipt]) -> bool {
    receipts.iter().enumerate().any(|(index, receipt)| {
        receipts[index + 1..]
            .iter()
            .any(|candidate| candidate.task_id == receipt.task_id)
    })
}
