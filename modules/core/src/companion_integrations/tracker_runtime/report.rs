//! Steward Routine completion and problem reports.

use super::*;

impl CoreRuntime {
    #[allow(clippy::too_many_arguments)]
    pub fn complete_steward_routine(
        &mut self,
        capability: &TrackerCheckCapability,
        expected_context_revision: u64,
        context_markdown: String,
        update_summary: Option<String>,
        findings: Vec<RoutineFinding>,
        related_task_ids: Vec<String>,
        report_id: String,
        completed_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        let mut configuration = self.validate_current_check(capability, completed_at_epoch_ms)?;
        if expected_context_revision > configuration.context_revision {
            return Err(CoreError::RevisionConflict);
        }
        // A user may edit or clear this Routine's visible context while its
        // Steward is inspecting sources. The findings still belong to the live
        // claimed check, but its replacement Markdown came from an older
        // source document. Preserve the newer user document and finish the
        // check instead of overwriting it or making the Steward retry forever.
        let context_markdown_applied = configuration.context_revision == expected_context_revision;
        if context_markdown.len() > ROUTINE_CONTEXT_MAX_BYTES
            || update_summary
                .as_ref()
                .is_some_and(|summary| summary.trim().is_empty() || summary.len() > 4_096)
            || findings.len() > 16
            || !unique_bounded(&related_task_ids, ROUTINE_RELATED_TASKS_MAX, 256)
            || !self.same_project_tasks_exist(&configuration.project_id, &related_task_ids)
        {
            return Err(CoreError::InvalidParams("routineContext".into()));
        }
        let mut finding_ids = Vec::with_capacity(findings.len());
        let mut finding_keys = Vec::with_capacity(findings.len());
        for finding in &findings {
            let value = PendingRoutineFinding {
                id: finding.id.clone(),
                source_key: finding.source_key.clone(),
                routine_generation: configuration.generation,
                summary: finding.summary.clone(),
                evidence: finding.evidence.clone(),
                source_references: finding.source_references.clone(),
                related_task_ids: finding.related_task_ids.clone(),
                created_at_epoch_ms: completed_at_epoch_ms,
            };
            if !value.is_valid()
                || !valid_source_key(&finding.source_key)
                || finding.summary.trim().is_empty()
                || finding.summary.len() > ROUTINE_FINDING_SUMMARY_MAX_BYTES
                || finding.evidence.trim().is_empty()
                || finding.evidence.len() > ROUTINE_FINDING_EVIDENCE_MAX_BYTES
                || !unique_bounded(
                    &finding.source_references,
                    TRACKER_REPORT_SOURCE_REFS_MAX,
                    TRACKER_REPORT_SOURCE_REF_MAX_BYTES,
                )
                || !unique_bounded(&finding.related_task_ids, ROUTINE_RELATED_TASKS_MAX, 256)
                || finding_ids.contains(&finding.id)
                || finding_keys.contains(&finding.source_key)
                || !self
                    .same_project_tasks_exist(&configuration.project_id, &finding.related_task_ids)
            {
                return Err(CoreError::TrackerReportInvalid);
            }
            finding_ids.push(finding.id.clone());
            finding_keys.push(finding.source_key.clone());
        }

        let novel_findings = findings
            .into_iter()
            .filter(|finding| {
                !configuration
                    .recent_source_keys
                    .contains(&finding.source_key)
            })
            .collect::<Vec<_>>();
        let mut recent_source_keys = configuration.recent_source_keys.clone();
        for finding in &novel_findings {
            if !recent_source_keys.contains(&finding.source_key) {
                recent_source_keys.push(finding.source_key.clone());
            }
        }
        if recent_source_keys.len() > ROUTINE_RECENT_SOURCE_KEYS_MAX {
            recent_source_keys.drain(
                ..recent_source_keys
                    .len()
                    .saturating_sub(ROUTINE_RECENT_SOURCE_KEYS_MAX),
            );
        }
        let pending_findings = if configuration.trigger_mode.is_scheduled()
            && configuration.action_handling != RoutineActionHandling::Off
        {
            novel_findings
                .iter()
                .map(|finding| PendingRoutineFinding {
                    id: finding.id.clone(),
                    source_key: finding.source_key.clone(),
                    routine_generation: configuration.generation,
                    summary: finding.summary.trim().to_owned(),
                    evidence: finding.evidence.trim().to_owned(),
                    source_references: finding.source_references.clone(),
                    related_task_ids: finding.related_task_ids.clone(),
                    created_at_epoch_ms: completed_at_epoch_ms,
                })
                .collect::<Vec<_>>()
        } else {
            vec![]
        };
        if configuration
            .pending_routine_findings
            .len()
            .saturating_add(pending_findings.len())
            > ROUTINE_PENDING_FINDINGS_MAX
        {
            return Err(CoreError::TrackerReportInvalid);
        }
        configuration
            .pending_routine_findings
            .extend(pending_findings.iter().cloned());
        let context_changed = (context_markdown_applied
            && configuration.context_markdown != context_markdown)
            || configuration.recent_source_keys != recent_source_keys
            || configuration.related_task_ids != related_task_ids;
        if context_changed {
            configuration.context_revision = configuration
                .context_revision
                .checked_add(1)
                .ok_or(CoreError::RevisionConflict)?;
        }
        if context_markdown_applied {
            configuration.context_markdown = context_markdown;
        }
        configuration.recent_source_keys = recent_source_keys;
        configuration.related_task_ids = related_task_ids.clone();
        configuration.last_check_started_at_epoch_ms = Some(capability.claimed_at_epoch_ms);
        configuration.last_attempt_at_epoch_ms = Some(completed_at_epoch_ms);
        configuration.last_successful_report_at_epoch_ms = Some(completed_at_epoch_ms);
        configuration.updated_at_epoch_ms = completed_at_epoch_ms;

        let update_summary = update_summary.map(|summary| summary.trim().to_owned());
        let report = if update_summary.is_none() && novel_findings.is_empty() {
            None
        } else {
            let mut message_parts = Vec::new();
            if let Some(summary) = update_summary.as_ref() {
                message_parts.push(summary.clone());
            }
            message_parts.extend(novel_findings.iter().map(|finding| {
                format!(
                    "- {}\n  Evidence: {}",
                    finding.summary.trim(),
                    finding.evidence.trim()
                )
            }));
            let message = message_parts.join("\n");
            let source_references = novel_findings
                .iter()
                .flat_map(|finding| finding.source_references.iter().cloned())
                .fold(Vec::new(), |mut values, reference| {
                    if !values.contains(&reference) {
                        values.push(reference);
                    }
                    values
                });
            let report_task_ids = update_summary
                .as_ref()
                .map_or_else(Vec::new, |_| related_task_ids.clone())
                .into_iter()
                .chain(
                    novel_findings
                        .iter()
                        .flat_map(|finding| finding.related_task_ids.iter().cloned()),
                )
                .fold(Vec::new(), |mut values, task_id| {
                    if !values.contains(&task_id) {
                        values.push(task_id);
                    }
                    values
                });
            let report = TrackerReport {
                id: report_id,
                project_id: capability.project_id.clone(),
                routine_id: capability.tracker_id.clone(),
                check_id: capability.check_id.clone(),
                generation: capability.generation,
                kind: TrackerReportKind::Success,
                message,
                source_references,
                related_task_ids: report_task_ids,
                created_at_epoch_ms: completed_at_epoch_ms,
            };
            if !report.is_valid() {
                return Err(CoreError::TrackerReportInvalid);
            }
            Some(report)
        };
        self.store
            .set_tracker_configuration(
                &self.write_authority,
                configuration.clone(),
                self.store.revision(),
            )
            .map_err(store_error)?;
        let pending_trigger = self.finish_steward_routine_check(
            capability,
            None,
            completed_at_epoch_ms,
            &configuration,
        );
        if let Some(report) = report.as_ref() {
            self.push_runtime_report(report.clone());
        }
        Ok(json!({
            "status": "completed",
            "newFindingCount": novel_findings.len(),
            "newPendingFindingCount": pending_findings.len(),
            "contextChanged": context_changed,
            "contextMarkdownApplied": context_markdown_applied,
            "contextRevision": configuration.context_revision,
            "pendingTrigger": pending_trigger,
            "reportCreated": report.is_some(),
            "stateRevision": self.store.revision(),
        }))
    }

    pub fn report_steward_routine_problem(
        &mut self,
        capability: &TrackerCheckCapability,
        message: String,
        source_references: Vec<String>,
        report_id: String,
        completed_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        let mut configuration = self.validate_current_check(capability, completed_at_epoch_ms)?;
        let related_task_ids: Vec<String> = if configuration.trigger_mode.is_scheduled() {
            configuration
                .related_task_ids
                .iter()
                .filter(|task_id| {
                    self.store.tasks().iter().any(|task| {
                        task.id == **task_id && task.project_id == configuration.project_id
                    })
                })
                .cloned()
                .collect()
        } else {
            self.claimed_step_task_id(capability).into_iter().collect()
        };
        let message = message.trim().to_owned();
        let report = TrackerReport {
            id: report_id,
            project_id: capability.project_id.clone(),
            routine_id: capability.tracker_id.clone(),
            check_id: capability.check_id.clone(),
            generation: capability.generation,
            kind: TrackerReportKind::Problem,
            message: message.clone(),
            source_references: source_references.clone(),
            related_task_ids: related_task_ids.clone(),
            created_at_epoch_ms: completed_at_epoch_ms,
        };
        if !report.is_valid() {
            return Err(CoreError::TrackerReportInvalid);
        }
        let duplicate_report = self
            .tracker_runtime
            .reports
            .iter()
            .rev()
            .find(|candidate| {
                candidate.project_id == report.project_id
                    && candidate.routine_id == report.routine_id
            })
            .is_some_and(|candidate| {
                candidate.kind == TrackerReportKind::Problem
                    && candidate.message == report.message
                    && candidate.source_references == report.source_references
                    && candidate.related_task_ids == report.related_task_ids
            });
        let problem_episode = configuration
            .last_successful_report_at_epoch_ms
            .unwrap_or(0)
            .to_string();
        let source_key = routine_problem_source_key(
            &configuration.id,
            &problem_episode,
            &message,
            &source_references,
            &related_task_ids,
        );
        let mut new_pending_finding_count = 0;
        let mut steward_review_required = false;
        if configuration.action_handling != RoutineActionHandling::Off {
            if configuration
                .pending_routine_findings
                .iter()
                .any(|finding| finding.source_key == source_key)
            {
                steward_review_required =
                    !self.companion_has_pending_proposal(&configuration.project_id);
            } else if !configuration.recent_source_keys.contains(&source_key) {
                let summary = format!(
                    "{} could not complete its evidence check.",
                    configuration.name
                );
                let evidence = truncate_utf8(&message, ROUTINE_FINDING_EVIDENCE_MAX_BYTES);
                let replacement_index = if related_task_ids.is_empty() {
                    None
                } else {
                    configuration
                        .pending_routine_findings
                        .iter()
                        .position(|finding| {
                            finding
                                .related_task_ids
                                .iter()
                                .any(|task_id| related_task_ids.contains(task_id))
                        })
                };
                if let Some(index) = replacement_index {
                    let finding_id = configuration.pending_routine_findings[index].id.clone();
                    configuration.pending_routine_findings[index] = PendingRoutineFinding {
                        id: finding_id.clone(),
                        source_key: source_key.clone(),
                        routine_generation: configuration.generation,
                        summary,
                        evidence,
                        source_references: source_references.clone(),
                        related_task_ids: related_task_ids.clone(),
                        created_at_epoch_ms: completed_at_epoch_ms,
                    };
                    steward_review_required =
                        !self.companion_has_pending_proposal(&configuration.project_id);
                } else if configuration.pending_routine_findings.len()
                    < ROUTINE_PENDING_FINDINGS_MAX
                {
                    configuration
                        .pending_routine_findings
                        .push(PendingRoutineFinding {
                            id: report.id.clone(),
                            source_key: source_key.clone(),
                            routine_generation: configuration.generation,
                            summary,
                            evidence,
                            source_references: source_references.clone(),
                            related_task_ids: related_task_ids.clone(),
                            created_at_epoch_ms: completed_at_epoch_ms,
                        });
                    new_pending_finding_count = 1;
                    steward_review_required = true;
                }
                if steward_review_required {
                    configuration.recent_source_keys.push(source_key);
                }
            }
        }
        if configuration.recent_source_keys.len() > ROUTINE_RECENT_SOURCE_KEYS_MAX {
            configuration.recent_source_keys.drain(
                ..configuration
                    .recent_source_keys
                    .len()
                    .saturating_sub(ROUTINE_RECENT_SOURCE_KEYS_MAX),
            );
        }
        configuration.last_check_started_at_epoch_ms = Some(capability.claimed_at_epoch_ms);
        configuration.last_attempt_at_epoch_ms = Some(completed_at_epoch_ms);
        configuration.updated_at_epoch_ms = completed_at_epoch_ms;
        self.store
            .set_tracker_configuration(
                &self.write_authority,
                configuration.clone(),
                self.store.revision(),
            )
            .map_err(store_error)?;
        let pending_trigger = self.finish_steward_routine_check(
            capability,
            Some(message),
            completed_at_epoch_ms,
            &configuration,
        );
        if !duplicate_report {
            self.push_runtime_report(report);
        }
        Ok(json!({
            "status": "problemReported",
            "pendingTrigger": pending_trigger,
            "problemChanged": !duplicate_report,
            "reportCreated": !duplicate_report,
            "relatedTaskIds": related_task_ids,
            "newPendingFindingCount": new_pending_finding_count,
            "stewardReviewRequired": steward_review_required,
            "stateRevision": self.store.revision(),
        }))
    }
}

fn routine_problem_source_key(
    routine_id: &str,
    episode: &str,
    message: &str,
    source_references: &[String],
    related_task_ids: &[String],
) -> String {
    let mut digest = Sha256::new();
    for part in std::iter::once(routine_id)
        .chain(std::iter::once(episode))
        .chain(std::iter::once(message))
        .chain(source_references.iter().map(String::as_str))
        .chain(related_task_ids.iter().map(String::as_str))
    {
        digest.update(part.as_bytes());
        digest.update([0]);
    }
    let digest = digest.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut hex, "{byte:02x}").expect("writing to String cannot fail");
    }
    format!("routine-problem:{hex}")
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn valid_source_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= ROUTINE_SOURCE_KEY_MAX_BYTES
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'/' | b'-')
        })
}

fn unique_bounded(values: &[String], max_items: usize, max_bytes: usize) -> bool {
    values.len() <= max_items
        && values.iter().enumerate().all(|(index, value)| {
            !value.trim().is_empty()
                && value.len() <= max_bytes
                && !values[index + 1..].contains(value)
        })
}
