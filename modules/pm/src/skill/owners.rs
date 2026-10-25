//! Bug owner finder: who most likely owns a ticket, ranked from what the
//! PM could read: commits to the files the ticket names, authors and
//! reviewers of related pull requests, and assignees of similar past
//! tickets. The daemon gathers the signals; this ranks them. It decides
//! nothing: the agent turns the ranking into an assignee suggestion the PM
//! accepts or rejects.

use super::{EVIDENCE_LABEL_MAX_CHARS, EVIDENCE_MAX, Evidence, bounded_line};
use crate::delivery::risks::DAY_MS;
use crate::ticket::{TICKET_ASSIGNEE_MAX_CHARS, Ticket, valid_assignee};

/// Files of a ticket whose history is read.
pub const OWNER_PATHS_MAX: usize = 5;
/// Similar past tickets whose assignees count.
pub const SIMILAR_TICKETS_MAX: usize = 8;
/// People a ranking returns.
pub const OWNER_CANDIDATES_MAX: usize = 3;
const PATH_MAX_BYTES: usize = 200;
/// Title words two tickets must share to be similar.
const SIMILAR_WORDS_MIN: usize = 2;
const RECENT_MS: u64 = 90 * DAY_MS;
const STOP_WORDS: &[&str] = &[
    "about", "after", "again", "also", "does", "doesn", "from", "have", "into", "isnt", "need",
    "should", "some", "that", "then", "there", "this", "when", "where", "which", "while", "with",
    "without", "would",
];
const FILE_EXTENSIONS: &[&str] = &[
    "c", "cc", "cpp", "cs", "css", "dart", "go", "h", "html", "java", "js", "json", "jsx", "kt",
    "md", "mjs", "php", "py", "rb", "rs", "scss", "sh", "sql", "swift", "toml", "ts", "tsx", "vue",
    "yaml", "yml",
];

/// What links a person to the ticket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerSignalKind {
    /// Wrote a commit to a file the ticket names, or naming a similar ticket.
    Commit,
    PullRequestAuthor,
    PullRequestReviewer,
    /// Was the assignee of a similar past ticket.
    PastAssignee,
}

impl OwnerSignalKind {
    const fn weight(self) -> u32 {
        match self {
            Self::Commit | Self::PullRequestAuthor => 3,
            Self::PullRequestReviewer | Self::PastAssignee => 2,
        }
    }
}

/// One piece of evidence for one person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerSignal {
    pub name: String,
    pub kind: OwnerSignalKind,
    pub evidence: Evidence,
    pub at_epoch_ms: u64,
}

impl OwnerSignal {
    /// A signal with a bounded one-line label; `None` for a name that is
    /// not a valid assignee.
    pub fn new(
        name: &str,
        kind: OwnerSignalKind,
        label: &str,
        url: Option<String>,
        at_epoch_ms: u64,
    ) -> Option<Self> {
        let name = bounded_line(name, TICKET_ASSIGNEE_MAX_CHARS);
        valid_assignee(&name).then(|| Self {
            name,
            kind,
            evidence: Evidence {
                label: bounded_line(label, EVIDENCE_LABEL_MAX_CHARS),
                url,
                quote: None,
            },
            at_epoch_ms,
        })
    }

    /// The assignee of a similar past ticket, with the ticket as evidence.
    pub fn past_assignee(ticket: &Ticket) -> Option<Self> {
        let label = match ticket.jira_issue_key() {
            Some(key) => format!("Owned {key}: {}", ticket.title),
            None => format!("Owned a similar ticket: {}", ticket.title),
        };
        Self::new(
            ticket.assignee.as_deref()?,
            OwnerSignalKind::PastAssignee,
            &label,
            ticket.jira_url.clone(),
            ticket.updated_at_epoch_ms,
        )
    }
}

/// One ranked person, best first in a ranking.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerCandidate {
    pub name: String,
    pub score: u32,
    /// One line on why, for the suggestion's shortlist.
    pub reason: String,
    pub evidence: Vec<Evidence>,
}

fn person_key(name: &str) -> String {
    name.chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Ranks people by their signals: commits and authored pull requests
/// weigh 3, reviews and similar tickets 2, doubled within 90 days. The
/// same person under different spellings counts once.
pub fn rank_owners(signals: &[OwnerSignal], now: u64) -> Vec<OwnerCandidate> {
    struct Person<'a> {
        key: String,
        signals: Vec<&'a OwnerSignal>,
        score: u32,
        newest: u64,
    }
    let mut people: Vec<Person> = Vec::new();
    for signal in signals {
        let key = person_key(&signal.name);
        if key.is_empty() {
            continue;
        }
        let recent = now.saturating_sub(signal.at_epoch_ms) <= RECENT_MS;
        let score = signal.kind.weight() * if recent { 2 } else { 1 };
        match people.iter_mut().find(|person| person.key == key) {
            Some(person) => {
                person.score += score;
                person.newest = person.newest.max(signal.at_epoch_ms);
                person.signals.push(signal);
            }
            None => people.push(Person {
                key,
                signals: vec![signal],
                score,
                newest: signal.at_epoch_ms,
            }),
        }
    }
    people.sort_by(|a, b| b.score.cmp(&a.score).then(b.newest.cmp(&a.newest)));
    people
        .into_iter()
        .take(OWNER_CANDIDATES_MAX)
        .map(|mut person| {
            person
                .signals
                .sort_by(|a, b| b.at_epoch_ms.cmp(&a.at_epoch_ms));
            OwnerCandidate {
                name: person.signals[0].name.clone(),
                score: person.score,
                reason: reason(&person.signals),
                evidence: person
                    .signals
                    .iter()
                    .take(EVIDENCE_MAX)
                    .map(|signal| signal.evidence.clone())
                    .collect(),
            }
        })
        .collect()
}

const REASONS: [(OwnerSignalKind, &str, &str); 4] = [
    (OwnerSignalKind::Commit, "related commit", "related commits"),
    (
        OwnerSignalKind::PullRequestAuthor,
        "related pull request written",
        "related pull requests written",
    ),
    (
        OwnerSignalKind::PullRequestReviewer,
        "related pull request reviewed",
        "related pull requests reviewed",
    ),
    (
        OwnerSignalKind::PastAssignee,
        "similar ticket owned",
        "similar tickets owned",
    ),
];

fn reason(signals: &[&OwnerSignal]) -> String {
    let parts: Vec<String> = REASONS
        .iter()
        .filter_map(|(kind, one, many)| {
            let count = signals.iter().filter(|signal| signal.kind == *kind).count();
            (count > 0).then(|| format!("{count} {}", if count == 1 { one } else { many }))
        })
        .collect();
    bounded_line(&parts.join(", "), EVIDENCE_LABEL_MAX_CHARS)
}

/// Repository-relative file paths a ticket names, such as
/// `src/payments/refund.rs` or `checkout.tsx`: no absolute paths, no `..`.
pub fn named_paths(text: &str) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for token in text
        .split(|character: char| character.is_whitespace() || "`'\"()[]{}<>,;".contains(character))
    {
        let token = token.trim_end_matches(['.', ':', '!', '?']);
        let token = token.split(':').next().unwrap_or_default();
        let named = token.len() <= PATH_MAX_BYTES
            && !token.starts_with('/')
            && !token.contains("://")
            && token.split('/').all(|part| {
                !part.is_empty()
                    && part != ".."
                    && part != "."
                    && part.chars().all(|character| {
                        character.is_ascii_alphanumeric() || "._-".contains(character)
                    })
            })
            && token.rsplit_once('.').is_some_and(|(stem, extension)| {
                !stem.is_empty() && FILE_EXTENSIONS.contains(&extension)
            });
        if named && !paths.iter().any(|path| path == token) {
            paths.push(token.to_owned());
            if paths.len() == OWNER_PATHS_MAX {
                break;
            }
        }
    }
    paths
}

fn title_words(title: &str) -> Vec<String> {
    let mut words: Vec<String> = Vec::new();
    for word in title
        .split(|character: char| !character.is_alphanumeric())
        .map(str::to_lowercase)
    {
        if word.chars().count() >= 4
            && !STOP_WORDS.contains(&word.as_str())
            && !words.contains(&word)
        {
            words.push(word);
        }
    }
    words
}

/// The files a ticket's title and description name.
pub fn ticket_paths(ticket: &Ticket) -> Vec<String> {
    named_paths(&format!("{} {}", ticket.title, ticket.description))
}

/// Other tickets with an assignee that share at least two title words or
/// one of the ticket's named `paths`, most alike first, then most recent.
pub fn similar_tickets<'a>(
    ticket: &Ticket,
    paths: &[String],
    tickets: &'a [Ticket],
) -> Vec<&'a Ticket> {
    let words = title_words(&ticket.title);
    let mut similar: Vec<(usize, &Ticket)> = tickets
        .iter()
        .filter(|other| other.id != ticket.id && other.assignee.is_some())
        .filter_map(|other| {
            let shared_words = title_words(&other.title)
                .iter()
                .filter(|word| words.contains(word))
                .count();
            let shared_paths = ticket_paths(other)
                .iter()
                .filter(|path| paths.contains(path))
                .count();
            let alike = shared_words + 2 * shared_paths;
            (shared_words >= SIMILAR_WORDS_MIN || shared_paths > 0).then_some((alike, other))
        })
        .collect();
    similar.sort_by(|(a, first), (b, second)| {
        b.cmp(a)
            .then_with(|| second.updated_at_epoch_ms.cmp(&first.updated_at_epoch_ms))
    });
    similar
        .into_iter()
        .take(SIMILAR_TICKETS_MAX)
        .map(|(_, other)| other)
        .collect()
}

/// How one source of owner evidence went.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerSourceRead {
    /// The project has no such source.
    NotSet,
    Read,
    /// The source is set but could not be read.
    Failed,
}

/// What the ranking could not read, in plain words; `None` when it read
/// both the code folder's history and GitHub.
pub fn owner_limitation(git: OwnerSourceRead, github: OwnerSourceRead) -> Option<String> {
    use OwnerSourceRead::{Failed, NotSet};
    let mut lines: Vec<&str> = Vec::new();
    match (git, github) {
        (NotSet, NotSet) => lines.push(
            "No code folder or GitHub is connected, so these owners come from ticket history \
             only.",
        ),
        (NotSet, _) => {
            lines.push("No code folder is set for this project, so git history was not read.")
        }
        (_, NotSet) => lines
            .push("GitHub is not connected, so pull request authors and reviewers were not read."),
        _ => {}
    }
    if git == Failed {
        lines.push("Git history in the code folder could not be read.");
    }
    if github == Failed {
        lines.push("GitHub could not be read, so pull request people are missing.");
    }
    (!lines.is_empty()).then(|| lines.join(" "))
}
