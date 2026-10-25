mod checks;
mod delivery;
mod jira;
mod note;
mod project;
mod skill;
mod skill_owners;
mod skill_slack;
mod sprint;
mod store;
mod ticket;

use crate::{NewTicket, PmStore, Sprint, SprintState, Ticket};

fn store() -> PmStore {
    PmStore::open_in_memory().expect("in-memory PM store")
}

fn sprint(store: &mut PmStore, project_id: &str, name: &str) -> Sprint {
    store
        .create_sprint(project_id, name, None, SprintState::Planned)
        .expect("sprint")
}

fn ticket(store: &mut PmStore, project_id: &str, title: &str, sprint_id: Option<&str>) -> Ticket {
    store
        .create_ticket(NewTicket {
            sprint_id: sprint_id.map(str::to_owned),
            ..NewTicket::new(project_id, title)
        })
        .expect("ticket")
}
