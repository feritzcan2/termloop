//! The Project Manager app's model and its own SQLite store: sprints,
//! tickets with immutable description versions, and project environments.
//! It never reads or writes the developer daemon's `termloop-store` state.

mod board;
mod commands;
mod environment;
mod error;
mod sprint;
mod store;
mod ticket;
mod validation;

#[cfg(test)]
mod tests;

pub use board::Board;
pub use commands::{ClosedSprint, NewTicket, TicketEdit};
pub use environment::{
    ENVIRONMENT_NAME_MAX_CHARS, PROJECT_ENVIRONMENTS_MAX, ProjectEnvironment,
    environment_is_production, valid_environment_name, valid_project_environments,
};
pub use error::PmError;
pub use sprint::{
    PROJECT_OPEN_SPRINTS_MAX, SPRINT_GOAL_MAX_CHARS, SPRINT_NAME_MAX_CHARS, Sprint, SprintState,
    valid_sprint_goal, valid_sprint_name,
};
pub use store::{PmStore, SCHEMA_VERSION};
pub use ticket::{
    AcceptanceCriterion, Blocker, TICKET_ASSIGNEE_MAX_CHARS, TICKET_BLOCKERS_MAX,
    TICKET_CRITERIA_MAX, TICKET_DESCRIPTION_MAX_CHARS, TICKET_ITEM_MAX_CHARS,
    TICKET_TITLE_MAX_CHARS, TICKET_VERSIONS_MAX, Ticket, TicketAuthor, TicketPriority,
    TicketStatus, TicketVersion, TicketVersionsSummary, valid_jira_url,
};
pub use validation::{ID_MAX_BYTES, valid_id};
