use termloop_domain::{
    IssueLink, PROJECT_SPRINTS_MAX, ProjectSprint, SprintState, TASK_TICKET_VERSIONS_MAX,
    TaskDeliveryFacts, TaskRecord, TaskTicketContent, TaskTicketProposal, TaskTicketVersion,
    TaskTrackingRecord, TicketAuthor, valid_sprint_name,
};

use super::super::{CoreWriteAuthority, CurrentState, Store, StoreError};

impl Store {
    pub fn create_project_sprint(
        &mut self,
        _authority: &CoreWriteAuthority,
        sprint: ProjectSprint,
    ) -> Result<u64, StoreError> {
        if !self
            .state
            .projects
            .iter()
            .any(|project| project.id == sprint.project_id)
        {
            return Err(StoreError::NotFound);
        }
        if self
            .state
            .project_sprints
            .iter()
            .any(|existing| existing.id == sprint.id)
        {
            return Err(StoreError::AlreadyExists);
        }
        if !sprint.is_valid()
            || sprint.state == SprintState::Active
                && self.active_sprint(&sprint.project_id).is_some()
            || self
                .state
                .project_sprints
                .iter()
                .filter(|existing| existing.project_id == sprint.project_id)
                .count()
                >= PROJECT_SPRINTS_MAX
        {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        self.state.project_sprints.push(sprint);
        self.commit_or_restore(previous)
    }

    /// Renames a sprint or moves it between Planned, Active, and Closed. Only
    /// one sprint per Project is active at a time.
    pub fn update_project_sprint(
        &mut self,
        _authority: &CoreWriteAuthority,
        sprint_id: &str,
        name: &str,
        state: SprintState,
    ) -> Result<u64, StoreError> {
        let index = self
            .state
            .project_sprints
            .iter()
            .position(|sprint| sprint.id == sprint_id)
            .ok_or(StoreError::NotFound)?;
        let project_id = self.state.project_sprints[index].project_id.clone();
        if !valid_sprint_name(name)
            || state == SprintState::Active
                && self
                    .active_sprint(&project_id)
                    .is_some_and(|active| active.id != sprint_id)
        {
            return Err(StoreError::ConstraintViolation);
        }
        let sprint = &self.state.project_sprints[index];
        if sprint.name == name && sprint.state == state {
            return Ok(self.state.revision);
        }
        let previous = self.state.clone();
        let sprint = &mut self.state.project_sprints[index];
        sprint.name = name.to_owned();
        sprint.state = state;
        self.commit_or_restore(previous)
    }

    /// Deletes a sprint; its Tasks return to the backlog with their tracked
    /// facts kept.
    pub fn delete_project_sprint(
        &mut self,
        _authority: &CoreWriteAuthority,
        sprint_id: &str,
    ) -> Result<u64, StoreError> {
        if !self
            .state
            .project_sprints
            .iter()
            .any(|sprint| sprint.id == sprint_id)
        {
            return Err(StoreError::NotFound);
        }
        let previous = self.state.clone();
        self.state
            .project_sprints
            .retain(|sprint| sprint.id != sprint_id);
        for record in &mut self.state.task_tracking_records {
            if record.sprint_id.as_deref() == Some(sprint_id) {
                record.sprint_id = None;
            }
        }
        self.state
            .task_tracking_records
            .retain(|record| !record.is_empty());
        self.commit_or_restore(previous)
    }

    /// Applies one Jira sprint sync of a Project in one commit: the
    /// Project's complete sprint list, Tasks newly copied from Jira issues
    /// with their links, and replaced tracking records. A sprint left out is
    /// removed and its Tasks return to the backlog. Returns `None` when
    /// nothing changed.
    pub fn apply_jira_sprint_sync(
        &mut self,
        _authority: &CoreWriteAuthority,
        project_id: &str,
        sprints: Vec<ProjectSprint>,
        new_tasks: Vec<(TaskRecord, IssueLink)>,
        tracking: Vec<TaskTrackingRecord>,
    ) -> Result<Option<u64>, StoreError> {
        if !self
            .state
            .projects
            .iter()
            .any(|project| project.id == project_id)
        {
            return Err(StoreError::NotFound);
        }
        if sprints.iter().any(|sprint| sprint.project_id != project_id) {
            return Err(StoreError::ConstraintViolation);
        }
        let mut next = self.state.clone();
        next.project_sprints
            .retain(|sprint| sprint.project_id != project_id);
        next.project_sprints.extend(sprints);
        for (task, link) in new_tasks {
            if task.project_id != project_id || link.task_id != task.id {
                return Err(StoreError::ConstraintViolation);
            }
            super::task::insert_task_record(&mut next.tasks, task)?;
            super::issue_link::insert_jira_issue_link_record(
                &next.tasks,
                &next.task_source_configurations,
                &mut next.issue_links,
                link,
            )?;
        }
        for record in tracking {
            if !next
                .tasks
                .iter()
                .any(|task| task.id == record.task_id && task.project_id == project_id)
            {
                return Err(StoreError::ConstraintViolation);
            }
            next.task_tracking_records
                .retain(|existing| existing.task_id != record.task_id);
            if !record.is_empty() {
                next.task_tracking_records.push(record);
            }
        }
        for record in &mut next.task_tracking_records {
            if record.sprint_id.as_deref().is_some_and(|sprint_id| {
                !next
                    .project_sprints
                    .iter()
                    .any(|sprint| sprint.id == sprint_id)
            }) {
                record.sprint_id = None;
            }
        }
        next.task_tracking_records
            .retain(|record| !record.is_empty());
        let project_sprints = |state: &CurrentState| {
            let mut sprints = state
                .project_sprints
                .iter()
                .filter(|sprint| sprint.project_id == project_id)
                .cloned()
                .collect::<Vec<_>>();
            sprints.sort_by(|left, right| left.id.cmp(&right.id));
            sprints
        };
        let mut tracking_before = self.state.task_tracking_records.clone();
        let mut tracking_after = next.task_tracking_records.clone();
        tracking_before.sort_by(|left, right| left.task_id.cmp(&right.task_id));
        tracking_after.sort_by(|left, right| left.task_id.cmp(&right.task_id));
        if next.tasks.len() == self.state.tasks.len()
            && tracking_before == tracking_after
            && project_sprints(&next) == project_sprints(&self.state)
        {
            return Ok(None);
        }
        crate::validation::validate_current_state(&next)
            .map_err(|_| StoreError::ConstraintViolation)?;
        let previous = std::mem::replace(&mut self.state, next);
        self.commit_or_restore(previous).map(Some)
    }

    /// Replaces one Task's tracking record. An empty record is stored as its
    /// absence.
    pub fn set_task_tracking(
        &mut self,
        _authority: &CoreWriteAuthority,
        record: TaskTrackingRecord,
    ) -> Result<u64, StoreError> {
        let task = self
            .state
            .tasks
            .iter()
            .find(|task| task.id == record.task_id)
            .ok_or(StoreError::NotFound)?;
        if !record.is_valid()
            || record.sprint_id.as_deref().is_some_and(|sprint_id| {
                !self
                    .state
                    .project_sprints
                    .iter()
                    .any(|sprint| sprint.id == sprint_id && sprint.project_id == task.project_id)
            })
        {
            return Err(StoreError::ConstraintViolation);
        }
        let current = self
            .state
            .task_tracking_records
            .iter()
            .find(|existing| existing.task_id == record.task_id);
        let unchanged = match current {
            Some(current) => {
                TaskTrackingRecord {
                    updated_at_epoch_ms: record.updated_at_epoch_ms,
                    ..current.clone()
                } == record
            }
            None => record.is_empty(),
        };
        if unchanged {
            return Ok(self.state.revision);
        }
        let previous = self.state.clone();
        self.state
            .task_tracking_records
            .retain(|existing| existing.task_id != record.task_id);
        if !record.is_empty() {
            self.state.task_tracking_records.push(record);
        }
        self.commit_or_restore(previous)
    }

    /// Saves a Task's ticket — its title and description — as its next
    /// version, in one commit. The first save of a ticket that has no version
    /// yet keeps what it said before as version 1. `expected_version` guards
    /// against overwriting a newer save; saving the content the newest
    /// version already holds records nothing. With `settle_proposal` the
    /// Task's pending Agent proposal is removed in the same commit.
    #[allow(clippy::too_many_arguments)]
    pub fn save_task_ticket(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        content: TaskTicketContent,
        author: TicketAuthor,
        summary: Option<String>,
        expected_version: Option<u64>,
        settle_proposal: bool,
        now_epoch_ms: u64,
    ) -> Result<u64, StoreError> {
        let task_index = self
            .state
            .tasks
            .iter()
            .position(|task| task.id == task_id)
            .ok_or(StoreError::NotFound)?;
        if !content.is_valid() {
            return Err(StoreError::ConstraintViolation);
        }
        let head = self.task_ticket_head(task_id).cloned();
        let head_number = head.as_ref().map_or(0, |version| version.number);
        if expected_version.is_some_and(|expected| expected != head_number) {
            return Err(StoreError::RevisionConflict);
        }
        let current = self
            .task_ticket_content(task_id)
            .ok_or(StoreError::NotFound)?;
        let has_proposal = self.task_ticket_proposal(task_id).is_some();
        if current == content
            && head.as_ref().is_some_and(|head| head.content == content)
            && !(settle_proposal && has_proposal)
        {
            return Ok(head_number);
        }
        let previous = self.state.clone();
        if settle_proposal {
            self.state
                .task_ticket_proposals
                .retain(|proposal| proposal.task_id != task_id);
        }
        if current == content && head.as_ref().is_some_and(|head| head.content == content) {
            self.commit_or_restore(previous)?;
            return Ok(head_number);
        }
        let mut number = head_number;
        if head.is_none() && current != content && current.is_valid() {
            number += 1;
            self.state.task_ticket_versions.push(TaskTicketVersion {
                task_id: task_id.to_owned(),
                number,
                author: TicketAuthor::ProjectManager,
                summary: Some("Original ticket".into()),
                content: current,
                created_at_epoch_ms: self.state.tasks[task_index].updated_at_epoch_ms,
            });
        }
        let task = &mut self.state.tasks[task_index];
        task.title = content.title.clone();
        task.brief = content.brief.clone();
        task.updated_at_epoch_ms = now_epoch_ms.max(task.updated_at_epoch_ms + 1);
        number += 1;
        self.state.task_ticket_versions.push(TaskTicketVersion {
            task_id: task_id.to_owned(),
            number,
            author,
            summary,
            content,
            created_at_epoch_ms: now_epoch_ms,
        });
        while self
            .state
            .task_ticket_versions
            .iter()
            .filter(|version| version.task_id == task_id)
            .count()
            > TASK_TICKET_VERSIONS_MAX
        {
            let oldest = self
                .state
                .task_ticket_versions
                .iter()
                .position(|version| version.task_id == task_id)
                .expect("a Task over the version bound has a version");
            self.state.task_ticket_versions.remove(oldest);
        }
        self.commit_or_restore(previous)?;
        Ok(number)
    }

    /// What a Task's ticket says now.
    pub fn task_ticket_content(&self, task_id: &str) -> Option<TaskTicketContent> {
        let task = self.state.tasks.iter().find(|task| task.id == task_id)?;
        Some(TaskTicketContent {
            title: task.title.clone(),
            brief: task.brief.clone(),
        })
    }

    /// Replaces a Task's pending Agent proposal.
    pub fn set_task_ticket_proposal(
        &mut self,
        _authority: &CoreWriteAuthority,
        proposal: TaskTicketProposal,
    ) -> Result<u64, StoreError> {
        if !self
            .state
            .tasks
            .iter()
            .any(|task| task.id == proposal.task_id)
        {
            return Err(StoreError::NotFound);
        }
        if !proposal.is_valid() {
            return Err(StoreError::ConstraintViolation);
        }
        if self.task_ticket_proposal(&proposal.task_id) == Some(&proposal) {
            return Ok(self.state.revision);
        }
        let previous = self.state.clone();
        self.state
            .task_ticket_proposals
            .retain(|existing| existing.task_id != proposal.task_id);
        self.state.task_ticket_proposals.push(proposal);
        self.commit_or_restore(previous)
    }

    pub fn remove_task_ticket_proposal(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
    ) -> Result<u64, StoreError> {
        if self.task_ticket_proposal(task_id).is_none() {
            return Err(StoreError::NotFound);
        }
        let previous = self.state.clone();
        self.state
            .task_ticket_proposals
            .retain(|proposal| proposal.task_id != task_id);
        self.commit_or_restore(previous)
    }

    pub fn task_ticket_proposal(&self, task_id: &str) -> Option<&TaskTicketProposal> {
        self.state
            .task_ticket_proposals
            .iter()
            .find(|proposal| proposal.task_id == task_id)
    }

    /// Replaces the delivery facts of several Tasks in one commit. Records
    /// that end up empty are stored as their absence; unchanged records commit
    /// nothing.
    pub fn set_task_delivery_facts(
        &mut self,
        _authority: &CoreWriteAuthority,
        records: Vec<TaskDeliveryFacts>,
    ) -> Result<u64, StoreError> {
        for record in &records {
            if !self
                .state
                .tasks
                .iter()
                .any(|task| task.id == record.task_id)
            {
                return Err(StoreError::NotFound);
            }
            if !record.is_valid() {
                return Err(StoreError::ConstraintViolation);
            }
        }
        let changed =
            records.iter().any(
                |record| match self.task_delivery_facts_for(&record.task_id) {
                    Some(current) => current != record,
                    None => !record.is_empty(),
                },
            );
        if !changed {
            return Ok(self.state.revision);
        }
        let previous = self.state.clone();
        for record in records {
            self.state
                .task_delivery_facts
                .retain(|existing| existing.task_id != record.task_id);
            if !record.is_empty() {
                self.state.task_delivery_facts.push(record);
            }
        }
        self.commit_or_restore(previous)
    }

    pub fn task_delivery_facts_for(&self, task_id: &str) -> Option<&TaskDeliveryFacts> {
        self.state
            .task_delivery_facts
            .iter()
            .find(|facts| facts.task_id == task_id)
    }

    /// The newest saved version of a Task's ticket.
    pub fn task_ticket_head(&self, task_id: &str) -> Option<&TaskTicketVersion> {
        self.state
            .task_ticket_versions
            .iter()
            .filter(|version| version.task_id == task_id)
            .max_by_key(|version| version.number)
    }

    pub fn task_tracking(&self, task_id: &str) -> Option<&TaskTrackingRecord> {
        self.state
            .task_tracking_records
            .iter()
            .find(|record| record.task_id == task_id)
    }

    pub fn active_sprint(&self, project_id: &str) -> Option<&ProjectSprint> {
        self.state
            .project_sprints
            .iter()
            .find(|sprint| sprint.project_id == project_id && sprint.state == SprintState::Active)
    }
}
