//! Bug owner finder ranking: weights and recency, merged spellings, the
//! caps, the paths a ticket names, similar tickets and the plain-language
//! limitation.

use super::store;
use crate::skill::{
    EVIDENCE_MAX, OWNER_CANDIDATES_MAX, OWNER_PATHS_MAX, OwnerSignal, OwnerSignalKind,
    OwnerSourceRead, named_paths, owner_limitation, rank_owners, similar_tickets, ticket_paths,
};
use crate::{NewTicket, PmStore, Ticket};

const DAY: u64 = 86_400_000;
const NOW: u64 = 1_000 * DAY;

fn signal(name: &str, kind: OwnerSignalKind, at: u64) -> OwnerSignal {
    OwnerSignal::new(name, kind, &format!("{name} did something"), None, at).unwrap()
}

fn assigned(store: &mut PmStore, title: &str, description: &str, assignee: &str) -> Ticket {
    store
        .create_ticket(NewTicket {
            description: description.to_owned(),
            assignee: (!assignee.is_empty()).then(|| assignee.to_owned()),
            ..NewTicket::new("p1", title)
        })
        .unwrap()
}

#[test]
fn recent_commits_outrank_an_old_assignee_and_spellings_merge() {
    let signals = [
        signal("Old Owner", OwnerSignalKind::PastAssignee, NOW - 400 * DAY),
        signal("Old Owner", OwnerSignalKind::PastAssignee, NOW - 300 * DAY),
        signal("Ada Lovelace", OwnerSignalKind::Commit, NOW - DAY),
        signal("ada lovelace", OwnerSignalKind::Commit, NOW - 2 * DAY),
        signal("Bo", OwnerSignalKind::PullRequestReviewer, NOW),
    ];
    let ranked = rank_owners(&signals, NOW);
    let names: Vec<&str> = ranked.iter().map(|owner| owner.name.as_str()).collect();
    assert_eq!(names, ["Ada Lovelace", "Bo", "Old Owner"]);
    assert_eq!(ranked[0].score, 12);
    assert_eq!(ranked[0].reason, "2 related commits");
    assert_eq!(ranked[1].score, 4);
    assert_eq!(ranked[2].score, 4);
    assert_eq!(ranked[2].reason, "2 similar tickets owned");
}

#[test]
fn a_ranking_keeps_three_people_and_five_pieces_of_evidence_newest_first() {
    let mut signals: Vec<OwnerSignal> = (0..8)
        .map(|day| signal("Ada", OwnerSignalKind::Commit, NOW - day * DAY))
        .collect();
    for name in ["Bo", "Cy", "Di"] {
        signals.push(signal(name, OwnerSignalKind::PastAssignee, NOW));
    }
    let ranked = rank_owners(&signals, NOW);
    assert_eq!(ranked.len(), OWNER_CANDIDATES_MAX);
    assert_eq!(ranked[0].evidence.len(), EVIDENCE_MAX);
    assert!(
        ranked
            .iter()
            .all(|owner| owner.evidence.len() <= EVIDENCE_MAX)
    );
    assert!(rank_owners(&[], NOW).is_empty());
    assert!(OwnerSignal::new("", OwnerSignalKind::Commit, "x", None, NOW).is_none());
}

#[test]
fn a_ticket_names_repository_relative_files_only() {
    let text = "Refund fails in `src/payments/refund.rs:42`, see checkout.tsx and \
                /etc/passwd, ../secret.rs, https://x.io/a.js, README, src/payments/refund.rs.";
    assert_eq!(
        named_paths(text),
        ["src/payments/refund.rs", "checkout.tsx"]
    );
    let many: String = (0..9).map(|n| format!("f{n}.rs ")).collect();
    assert_eq!(named_paths(&many).len(), OWNER_PATHS_MAX);
}

#[test]
fn similar_tickets_share_two_title_words_or_a_named_file_and_have_an_assignee() {
    let mut store = store();
    let bug = assigned(&mut store, "Refund webhook times out", "See refund.rs", "");
    let words = assigned(&mut store, "Refund webhook retries", "", "Ada");
    let file = assigned(&mut store, "Refund cleanup", "Touches refund.rs", "Bo");
    let one_word = assigned(&mut store, "Refund page copy", "", "Cy");
    let unassigned = assigned(&mut store, "Refund webhook logging", "", "");
    let tickets = [
        bug.clone(),
        words.clone(),
        file.clone(),
        one_word,
        unassigned,
    ];
    let similar: Vec<&str> = similar_tickets(&bug, &ticket_paths(&bug), &tickets)
        .iter()
        .map(|ticket| ticket.id.as_str())
        .collect();
    // A shared file counts as two shared words.
    assert_eq!(similar, [file.id.as_str(), words.id.as_str()]);
}

#[test]
fn the_limitation_says_plainly_what_was_not_read() {
    use OwnerSourceRead::{Failed, NotSet, Read};
    assert_eq!(owner_limitation(Read, Read), None);
    let says = |git, github| owner_limitation(git, github).unwrap();
    assert!(says(NotSet, NotSet).contains("ticket history only"));
    assert!(says(Read, NotSet).starts_with("GitHub is not connected"));
    assert!(says(NotSet, Read).starts_with("No code folder"));
    assert_eq!(
        says(Failed, Failed),
        "Git history in the code folder could not be read. GitHub could not be read, so pull \
         request people are missing."
    );
    assert!(says(Failed, NotSet).contains("GitHub is not connected"));
}

#[test]
fn a_past_assignee_signal_names_the_ticket() {
    let mut store = store();
    let owned = assigned(&mut store, "Refund webhook retries", "", "Ada");
    let signal = OwnerSignal::past_assignee(&owned).unwrap();
    assert_eq!(signal.name, "Ada");
    assert_eq!(signal.kind, OwnerSignalKind::PastAssignee);
    assert_eq!(
        signal.evidence.label,
        "Owned a similar ticket: Refund webhook retries"
    );
    let unowned = assigned(&mut store, "Other", "", "");
    assert!(OwnerSignal::past_assignee(&unowned).is_none());
}
