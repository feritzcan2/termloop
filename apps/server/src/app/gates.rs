use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

use termloop_core::CoreError;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinSet;
use tokio::time::{Duration, Instant};

const MAX_GIT_HOST_INFLIGHT_KEYS: usize = 256;
const MAX_GIT_HOST_WAITERS_PER_KEY: usize = 256;

#[derive(Clone)]
pub(super) struct FairResumeGate {
    commands: mpsc::UnboundedSender<ResumeGateCommand>,
    admitted: Arc<AtomicUsize>,
    stopped: Arc<AtomicBool>,
    max_admitted: usize,
}

#[derive(Clone)]
pub(super) struct AgentResumeGates {
    ordinary: FairResumeGate,
    steward: FairResumeGate,
    worker: FairResumeGate,
}

pub(super) const MAX_ACTIVE_AGENT_RESUMES: usize = 7;
pub(super) const MAX_ACTIVE_STEWARD_RESUMES: usize = 1;
pub(super) const MAX_ACTIVE_WORKER_RESUMES: usize = 7;
const MAX_QUEUED_AGENT_RESUMES: usize = 64;
#[cfg(test)]
pub(super) const MAX_ADMITTED_AGENT_RESUMES: usize =
    MAX_ACTIVE_AGENT_RESUMES + MAX_QUEUED_AGENT_RESUMES;
pub(super) const AGENT_RESUME_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(30);
pub(super) const AGENT_RELOCATION_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(10);
pub(super) const AGENT_RESUME_STABILITY_WINDOW: Duration = Duration::from_secs(1);
pub(super) const AGENT_RESUME_FINALIZATION_TIMEOUT: Duration = Duration::from_secs(5);
pub(super) const AGENT_RESUME_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

impl AgentResumeGates {
    pub(super) fn new() -> Self {
        Self {
            ordinary: FairResumeGate::new(MAX_ACTIVE_AGENT_RESUMES, MAX_QUEUED_AGENT_RESUMES),
            steward: FairResumeGate::new(MAX_ACTIVE_STEWARD_RESUMES, MAX_QUEUED_AGENT_RESUMES),
            worker: FairResumeGate::new(MAX_ACTIVE_WORKER_RESUMES, MAX_QUEUED_AGENT_RESUMES),
        }
    }

    pub(super) fn for_lane(&self, lane: termloop_core::AgentResumeLane) -> &FairResumeGate {
        match lane {
            termloop_core::AgentResumeLane::Ordinary => &self.ordinary,
            termloop_core::AgentResumeLane::Steward => &self.steward,
            termloop_core::AgentResumeLane::Worker => &self.worker,
        }
    }

    pub(super) async fn shutdown(&self) {
        tokio::join!(
            self.ordinary.shutdown(),
            self.steward.shutdown(),
            self.worker.shutdown(),
        );
    }
}

enum ResumeGateCommand {
    Acquire {
        project_id: String,
        ready: oneshot::Sender<()>,
    },
    Release,
    Shutdown(oneshot::Sender<()>),
}

pub(super) struct FairResumePermit {
    commands: mpsc::UnboundedSender<ResumeGateCommand>,
}

impl Drop for FairResumePermit {
    fn drop(&mut self) {
        let _ = self.commands.send(ResumeGateCommand::Release);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ResumeGateError {
    Full,
    Stopped,
    TimedOut,
}

impl FairResumeGate {
    pub(super) fn new(max_active: usize, max_queued: usize) -> Self {
        assert!(max_active > 0, "a resume gate needs an active slot");
        let (commands, receiver) = mpsc::unbounded_channel();
        let admitted = Arc::new(AtomicUsize::new(0));
        let stopped = Arc::new(AtomicBool::new(false));
        tokio::spawn(run_resume_gate(
            receiver,
            admitted.clone(),
            stopped.clone(),
            max_active,
        ));
        Self {
            commands,
            admitted,
            stopped,
            max_admitted: max_active + max_queued,
        }
    }

    pub(super) async fn acquire(
        &self,
        project_id: String,
    ) -> Result<FairResumePermit, ResumeGateError> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(ResumeGateError::Stopped);
        }
        self.admitted
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |admitted| {
                (admitted < self.max_admitted).then_some(admitted + 1)
            })
            .map_err(|_| ResumeGateError::Full)?;
        let (ready, wait) = oneshot::channel();
        if self
            .commands
            .send(ResumeGateCommand::Acquire { project_id, ready })
            .is_err()
        {
            decrement_resume_admission(&self.admitted);
            return Err(ResumeGateError::Stopped);
        }
        wait.await.map_err(|_| ResumeGateError::Stopped)?;
        Ok(FairResumePermit {
            commands: self.commands.clone(),
        })
    }

    pub(super) async fn shutdown(&self) {
        self.stopped.store(true, Ordering::Release);
        let (done, wait) = oneshot::channel();
        if self
            .commands
            .send(ResumeGateCommand::Shutdown(done))
            .is_ok()
        {
            let _ = wait.await;
        }
    }
}

async fn run_resume_gate(
    mut receiver: mpsc::UnboundedReceiver<ResumeGateCommand>,
    admitted: Arc<AtomicUsize>,
    stopped: Arc<AtomicBool>,
    max_active: usize,
) {
    let mut queues = HashMap::<String, VecDeque<oneshot::Sender<()>>>::new();
    let mut projects = VecDeque::<String>::new();
    let mut active = 0_usize;
    let mut shutdown_waiters = Vec::new();
    while let Some(command) = receiver.recv().await {
        match command {
            ResumeGateCommand::Acquire { project_id, ready } => {
                if stopped.load(Ordering::Acquire) {
                    decrement_resume_admission(&admitted);
                    drop(ready);
                } else {
                    queues
                        .entry(project_id.clone())
                        .or_default()
                        .push_back(ready);
                    if !projects.contains(&project_id) {
                        projects.push_back(project_id);
                    }
                }
            }
            ResumeGateCommand::Release => {
                if active > 0 {
                    active -= 1;
                    decrement_resume_admission(&admitted);
                }
            }
            ResumeGateCommand::Shutdown(done) => {
                stopped.store(true, Ordering::Release);
                let queued_count = queues.values().map(VecDeque::len).sum::<usize>();
                queues.clear();
                projects.clear();
                for _ in 0..queued_count {
                    decrement_resume_admission(&admitted);
                }
                shutdown_waiters.push(done);
            }
        }
        while !stopped.load(Ordering::Acquire) && active < max_active {
            let Some(project_id) = projects.pop_front() else {
                break;
            };
            let Some(project_queue) = queues.get_mut(&project_id) else {
                continue;
            };
            let ready = project_queue.pop_front();
            if project_queue.is_empty() {
                queues.remove(&project_id);
            } else {
                projects.push_back(project_id);
            }
            let Some(ready) = ready else {
                continue;
            };
            if ready.send(()).is_ok() {
                active += 1;
            } else {
                decrement_resume_admission(&admitted);
            }
        }
        if stopped.load(Ordering::Acquire) && active == 0 {
            for waiter in shutdown_waiters.drain(..) {
                let _ = waiter.send(());
            }
        }
    }
}

fn decrement_resume_admission(admitted: &AtomicUsize) {
    let _ = admitted.fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
        Some(value.saturating_sub(1))
    });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ObservationPriority {
    Explicit,
    Background,
}

#[derive(Clone)]
pub(super) struct FairObservationGate {
    commands: mpsc::UnboundedSender<ObservationGateCommand>,
}

#[derive(Clone)]
pub(super) struct GitHostQueryScheduler {
    commands: mpsc::Sender<GitHostQueryCommand>,
}

type QueryJob = termloop_core::companion_integrations::GitHostProviderQueryJob;
type QueryOutcome = termloop_core::companion_integrations::GitHostProviderQueryOutcome;
type ContentJob = termloop_core::companion_integrations::pull_request_changes::GitHostContentJob;
type ContentOutcome =
    termloop_core::companion_integrations::pull_request_changes::GitHostContentOutcome;

enum GitHostQueryCommand {
    Query {
        project_id: String,
        priority: ObservationPriority,
        jobs: Vec<(QueryJob, oneshot::Sender<QueryOutcome>)>,
    },
    Content {
        project_id: String,
        job: Box<ContentJob>,
        waiter: oneshot::Sender<ContentOutcome>,
    },
}

#[derive(Clone)]
enum ScheduledGitHostJob {
    Query(Box<QueryJob>),
    Content(Box<ContentJob>),
}

#[derive(Clone)]
enum ScheduledGitHostOutcome {
    Query(QueryOutcome),
    Content(ContentOutcome),
}

enum ScheduledGitHostWaiter {
    Query(oneshot::Sender<QueryOutcome>),
    Content(oneshot::Sender<ContentOutcome>),
}

struct GitHostQueryEntry {
    job: ScheduledGitHostJob,
    project_id: String,
    running: bool,
    waiters: Vec<ScheduledGitHostWaiter>,
}

#[derive(Default)]
struct ProjectGitHostQueue {
    explicit: VecDeque<String>,
    background: VecDeque<String>,
    explicit_streak: usize,
}

enum ObservationGateCommand {
    Acquire {
        project_id: String,
        priority: ObservationPriority,
        ready: oneshot::Sender<()>,
    },
    Release {
        project_id: String,
    },
}

#[derive(Default)]
struct ProjectObservationQueue {
    explicit: VecDeque<oneshot::Sender<()>>,
    background: VecDeque<oneshot::Sender<()>>,
}

pub(super) struct FairObservationPermit {
    commands: mpsc::UnboundedSender<ObservationGateCommand>,
    project_id: String,
}

impl Drop for FairObservationPermit {
    fn drop(&mut self) {
        let _ = self.commands.send(ObservationGateCommand::Release {
            project_id: self.project_id.clone(),
        });
    }
}

impl FairObservationGate {
    pub(super) fn new() -> Self {
        let (commands, receiver) = mpsc::unbounded_channel();
        tokio::spawn(run_observation_gate(receiver));
        Self { commands }
    }

    pub(super) async fn acquire(
        &self,
        project_id: impl Into<String>,
        priority: ObservationPriority,
    ) -> Result<FairObservationPermit, CoreError> {
        let project_id = project_id.into();
        let (ready, wait) = oneshot::channel();
        self.commands
            .send(ObservationGateCommand::Acquire {
                project_id: project_id.clone(),
                priority,
                ready,
            })
            .map_err(|_| CoreError::GitObservationTimedOut)?;
        wait.await.map_err(|_| CoreError::GitObservationTimedOut)?;
        Ok(FairObservationPermit {
            commands: self.commands.clone(),
            project_id,
        })
    }

    pub(super) async fn acquire_until(
        &self,
        project_id: impl Into<String>,
        priority: ObservationPriority,
        deadline: Instant,
    ) -> Result<FairObservationPermit, CoreError> {
        tokio::time::timeout_at(deadline, self.acquire(project_id, priority))
            .await
            .map_err(|_| CoreError::GitObservationTimedOut)?
    }
}

impl GitHostQueryScheduler {
    pub(super) fn new() -> Self {
        let (commands, receiver) = mpsc::channel(256);
        tokio::spawn(run_git_host_query_scheduler(receiver));
        Self { commands }
    }

    pub(super) async fn schedule(
        &self,
        project_id: String,
        priority: ObservationPriority,
        jobs: Vec<QueryJob>,
    ) -> Vec<oneshot::Receiver<QueryOutcome>> {
        let mut receivers = Vec::with_capacity(jobs.len());
        let jobs = jobs
            .into_iter()
            .map(|job| {
                let (sender, receiver) = oneshot::channel();
                receivers.push(receiver);
                (job, sender)
            })
            .collect();
        let _ = self
            .commands
            .send(GitHostQueryCommand::Query {
                project_id,
                priority,
                jobs,
            })
            .await;
        receivers
    }

    pub(super) async fn schedule_content(
        &self,
        project_id: String,
        job: ContentJob,
    ) -> oneshot::Receiver<ContentOutcome> {
        let (waiter, receiver) = oneshot::channel();
        let _ = self
            .commands
            .send(GitHostQueryCommand::Content {
                project_id,
                job: Box::new(job),
                waiter,
            })
            .await;
        receiver
    }
}

async fn run_git_host_query_scheduler(mut receiver: mpsc::Receiver<GitHostQueryCommand>) {
    let mut entries = HashMap::<String, GitHostQueryEntry>::new();
    let mut queues = HashMap::<String, ProjectGitHostQueue>::new();
    let mut projects = VecDeque::<String>::new();
    let mut running = JoinSet::<(Vec<String>, Option<Vec<ScheduledGitHostOutcome>>)>::new();
    loop {
        tokio::select! {
            command = receiver.recv() => {
                let Some(command) = command else {
                    if running.is_empty() { break; }
                    continue;
                };
                let (project_id, priority, incoming) = match command {
                    GitHostQueryCommand::Query { project_id, priority, jobs } => (
                        project_id,
                        priority,
                        jobs.into_iter()
                            .map(|(job, waiter)| (ScheduledGitHostJob::Query(Box::new(job)), ScheduledGitHostWaiter::Query(waiter)))
                            .collect::<Vec<_>>(),
                    ),
                    GitHostQueryCommand::Content { project_id, job, waiter } => (
                        project_id,
                        ObservationPriority::Explicit,
                        vec![(ScheduledGitHostJob::Content(job), ScheduledGitHostWaiter::Content(waiter))],
                    ),
                };
                for (job, waiter) in incoming {
                    let key = job.key().to_owned();
                    if let Some(entry) = entries.get_mut(&key) {
                        if entry.waiters.len() < MAX_GIT_HOST_WAITERS_PER_KEY {
                            entry.waiters.push(waiter);
                        } else {
                            send_scheduled_outcome(waiter, job.timeout_outcome());
                        }
                        if priority == ObservationPriority::Explicit
                            && !entry.running
                            && let Some(queue) = queues.get_mut(&entry.project_id)
                        {
                            queue.background.retain(|queued| queued != &key);
                            if !queue.explicit.contains(&key) {
                                queue.explicit.push_front(key.clone());
                            }
                        }
                        continue;
                    }
                    if entries.len() >= MAX_GIT_HOST_INFLIGHT_KEYS {
                        send_scheduled_outcome(waiter, job.timeout_outcome());
                        continue;
                    }
                    entries.insert(key.clone(), GitHostQueryEntry {
                        job,
                        project_id: project_id.clone(),
                        running: false,
                        waiters: vec![waiter],
                    });
                    let queue = queues.entry(project_id.clone()).or_default();
                    if queue.explicit.is_empty() && queue.background.is_empty() && !projects.contains(&project_id) {
                        projects.push_back(project_id.clone());
                    }
                    match priority {
                        ObservationPriority::Explicit => queue.explicit.push_back(key),
                        ObservationPriority::Background => queue.background.push_back(key),
                    }
                }
            }
            completed = running.join_next(), if !running.is_empty() => {
                if let Some(Ok((keys, outcomes))) = completed {
                    let mut outcomes = outcomes
                        .unwrap_or_default()
                        .into_iter()
                        .map(|outcome| (outcome.key().to_owned(), outcome))
                        .collect::<HashMap<_, _>>();
                    for key in keys {
                        if let Some(entry) = entries.remove(&key) {
                            let outcome = outcomes.remove(&key)
                                .unwrap_or_else(|| entry.job.timeout_outcome());
                            for waiter in entry.waiters {
                                send_scheduled_outcome(waiter, outcome.clone());
                            }
                        }
                    }
                }
            }
        }
        while running.len() < 2 {
            let Some((keys, jobs)) =
                take_git_host_query_batch(&mut entries, &mut queues, &mut projects)
            else {
                break;
            };
            running.spawn(async move {
                let result = tokio::task::spawn_blocking(move || execute_scheduled_batch(jobs))
                    .await
                    .ok();
                (keys, result)
            });
        }
    }
}

impl ScheduledGitHostJob {
    fn key(&self) -> &str {
        match self {
            Self::Query(job) => job.key(),
            Self::Content(job) => job.key(),
        }
    }

    fn batch_group_key(&self) -> String {
        match self {
            Self::Query(job) => format!("query:{}", job.batch_group_key()),
            Self::Content(job) => format!("content:{}", job.key()),
        }
    }

    fn batch_limit(&self) -> usize {
        match self {
            Self::Query(job) => job.batch_limit(),
            Self::Content(_) => 1,
        }
    }

    fn timeout_outcome(&self) -> ScheduledGitHostOutcome {
        match self {
            Self::Query(job) => ScheduledGitHostOutcome::Query(job.timeout_outcome()),
            Self::Content(job) => ScheduledGitHostOutcome::Content(job.timeout_outcome()),
        }
    }
}

impl ScheduledGitHostOutcome {
    fn key(&self) -> &str {
        match self {
            Self::Query(outcome) => outcome.key(),
            Self::Content(outcome) => outcome.key(),
        }
    }
}

fn send_scheduled_outcome(waiter: ScheduledGitHostWaiter, outcome: ScheduledGitHostOutcome) {
    match (waiter, outcome) {
        (ScheduledGitHostWaiter::Query(waiter), ScheduledGitHostOutcome::Query(outcome)) => {
            let _ = waiter.send(outcome);
        }
        (ScheduledGitHostWaiter::Content(waiter), ScheduledGitHostOutcome::Content(outcome)) => {
            let _ = waiter.send(outcome);
        }
        _ => {}
    }
}

fn execute_scheduled_batch(jobs: Vec<ScheduledGitHostJob>) -> Vec<ScheduledGitHostOutcome> {
    match jobs.first() {
        Some(ScheduledGitHostJob::Query(_)) => {
            let jobs = jobs
                .into_iter()
                .filter_map(|job| match job {
                    ScheduledGitHostJob::Query(job) => Some(*job),
                    ScheduledGitHostJob::Content(_) => None,
                })
                .collect();
            QueryJob::execute_batch(jobs)
                .into_iter()
                .map(ScheduledGitHostOutcome::Query)
                .collect()
        }
        Some(ScheduledGitHostJob::Content(_)) if jobs.len() == 1 => jobs
            .into_iter()
            .filter_map(|job| match job {
                ScheduledGitHostJob::Content(job) => {
                    Some(ScheduledGitHostOutcome::Content((*job).execute()))
                }
                ScheduledGitHostJob::Query(_) => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn take_git_host_query_batch(
    entries: &mut HashMap<String, GitHostQueryEntry>,
    queues: &mut HashMap<String, ProjectGitHostQueue>,
    projects: &mut VecDeque<String>,
) -> Option<(Vec<String>, Vec<ScheduledGitHostJob>)> {
    let turns = projects.len();
    for _ in 0..turns {
        let project = projects.pop_front()?;
        let queue = queues.get_mut(&project)?;
        let take_background = choose_git_host_background(queue);
        let selected = if take_background {
            &mut queue.background
        } else {
            &mut queue.explicit
        };
        let mut keys = Vec::new();
        let mut jobs = Vec::new();
        let mut deferred = VecDeque::new();
        let mut group = None;
        let mut limit = 20;
        while let Some(key) = selected.pop_front() {
            let Some(entry) = entries.get_mut(&key) else {
                continue;
            };
            if entry.running {
                continue;
            }
            let entry_group = entry.job.batch_group_key();
            if group.is_none() {
                group = Some(entry_group.clone());
                limit = entry.job.batch_limit();
            }
            if keys.len() >= limit || group.as_deref() != Some(entry_group.as_str()) {
                deferred.push_back(key);
                continue;
            }
            debug_assert_eq!(entry.project_id, project);
            entry.running = true;
            keys.push(key);
            jobs.push(entry.job.clone());
        }
        *selected = deferred;
        if queue.explicit.is_empty() && queue.background.is_empty() {
            queues.remove(&project);
        } else {
            projects.push_back(project);
        }
        if !keys.is_empty() {
            return Some((keys, jobs));
        }
    }
    None
}

fn choose_git_host_background(queue: &mut ProjectGitHostQueue) -> bool {
    let take_background =
        !queue.background.is_empty() && (queue.explicit.is_empty() || queue.explicit_streak >= 3);
    if take_background {
        queue.explicit_streak = 0;
    } else {
        queue.explicit_streak = queue.explicit_streak.saturating_add(1);
    }
    take_background
}

async fn run_observation_gate(mut receiver: mpsc::UnboundedReceiver<ObservationGateCommand>) {
    let mut queues = HashMap::<String, ProjectObservationQueue>::new();
    let mut projects = VecDeque::<String>::new();
    let mut active_projects = HashSet::<String>::new();
    let mut active = 0_usize;
    while let Some(command) = receiver.recv().await {
        match command {
            ObservationGateCommand::Acquire {
                project_id,
                priority,
                ready,
            } => {
                let queue = queues.entry(project_id.clone()).or_default();
                match priority {
                    ObservationPriority::Explicit => queue.explicit.push_back(ready),
                    ObservationPriority::Background => queue.background.push_back(ready),
                }
                if !projects.contains(&project_id) {
                    projects.push_back(project_id);
                }
            }
            ObservationGateCommand::Release { project_id } => {
                active = active.saturating_sub(1);
                active_projects.remove(&project_id);
            }
        }
        while active < 2 {
            let turns = projects.len();
            let mut admitted = false;
            for _ in 0..turns {
                let Some(project_id) = projects.pop_front() else {
                    break;
                };
                if active_projects.contains(&project_id) {
                    projects.push_back(project_id);
                    continue;
                }
                let Some(queue) = queues.get_mut(&project_id) else {
                    continue;
                };
                let ready = queue
                    .explicit
                    .pop_front()
                    .or_else(|| queue.background.pop_front());
                if !queue.explicit.is_empty() || !queue.background.is_empty() {
                    projects.push_back(project_id.clone());
                } else {
                    queues.remove(&project_id);
                }
                let Some(ready) = ready else {
                    continue;
                };
                if ready.send(()).is_ok() {
                    active += 1;
                    active_projects.insert(project_id);
                    admitted = true;
                    break;
                }
            }
            if !admitted {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_host_queue_prioritizes_explicit_work_without_starving_background() {
        let mut queue = ProjectGitHostQueue::default();
        queue
            .explicit
            .extend(["e1".into(), "e2".into(), "e3".into(), "e4".into()]);
        queue.background.push_back("b1".into());
        assert!(!choose_git_host_background(&mut queue));
        assert!(!choose_git_host_background(&mut queue));
        assert!(!choose_git_host_background(&mut queue));
        assert!(choose_git_host_background(&mut queue));
        assert!(!choose_git_host_background(&mut queue));
    }

    #[tokio::test]
    async fn observation_gate_caps_live_jobs_and_round_robins_projects_with_explicit_priority() {
        let gate = FairObservationGate::new();
        let first = gate
            .acquire("occupied-a", ObservationPriority::Background)
            .await
            .unwrap();
        let second = gate
            .acquire("occupied-b", ObservationPriority::Background)
            .await
            .unwrap();

        let enqueue = |project_id: &str, priority| {
            let (ready, wait) = oneshot::channel();
            gate.commands
                .send(ObservationGateCommand::Acquire {
                    project_id: project_id.into(),
                    priority,
                    ready,
                })
                .unwrap();
            wait
        };
        let cap_probe = enqueue("cap-probe", ObservationPriority::Explicit);
        assert!(
            tokio::time::timeout(Duration::from_millis(25), cap_probe)
                .await
                .is_err(),
            "a third live observation bypassed the two-slot cap"
        );
        let project_a_background = enqueue("project-a", ObservationPriority::Background);
        let project_a_explicit = enqueue("project-a", ObservationPriority::Explicit);
        let project_b_background = enqueue("project-b", ObservationPriority::Background);
        drop(first);
        project_a_explicit.await.unwrap();

        drop(second);
        project_b_background.await.unwrap();

        gate.commands
            .send(ObservationGateCommand::Release {
                project_id: "project-a".into(),
            })
            .unwrap();
        project_a_background.await.unwrap();
        gate.commands
            .send(ObservationGateCommand::Release {
                project_id: "project-b".into(),
            })
            .unwrap();
        gate.commands
            .send(ObservationGateCommand::Release {
                project_id: "project-a".into(),
            })
            .unwrap();
    }

    #[tokio::test]
    async fn observation_gate_serializes_jobs_for_the_same_project() {
        let gate = FairObservationGate::new();
        let first = gate
            .acquire("project", ObservationPriority::Explicit)
            .await
            .unwrap();
        let (ready, mut wait) = oneshot::channel();
        gate.commands
            .send(ObservationGateCommand::Acquire {
                project_id: "project".into(),
                priority: ObservationPriority::Explicit,
                ready,
            })
            .unwrap();

        assert!(
            tokio::time::timeout(Duration::from_millis(25), &mut wait)
                .await
                .is_err(),
            "a second observation for the same Project ran concurrently"
        );
        drop(first);
        wait.await.unwrap();
        gate.commands
            .send(ObservationGateCommand::Release {
                project_id: "project".into(),
            })
            .unwrap();
    }

    #[tokio::test]
    async fn resume_gate_caps_queue_and_dequeues_projects_round_robin() {
        let gate = FairResumeGate::new(MAX_ACTIVE_AGENT_RESUMES, MAX_QUEUED_AGENT_RESUMES);
        let mut active = futures_util::future::join_all(
            (0..MAX_ACTIVE_AGENT_RESUMES).map(|index| gate.acquire(format!("occupied-{index}"))),
        )
        .await
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();

        let mut waits = Vec::new();
        for project_id in (0..32)
            .map(|_| "project-a")
            .chain((0..32).map(|_| "project-b"))
        {
            gate.admitted.fetch_add(1, Ordering::AcqRel);
            let (ready, wait) = oneshot::channel();
            gate.commands
                .send(ResumeGateCommand::Acquire {
                    project_id: project_id.into(),
                    ready,
                })
                .unwrap();
            waits.push(wait);
        }
        tokio::task::yield_now().await;
        assert_eq!(
            gate.admitted.load(Ordering::Acquire),
            MAX_ADMITTED_AGENT_RESUMES
        );
        assert!(matches!(
            gate.acquire("overflow".into()).await,
            Err(ResumeGateError::Full)
        ));

        drop(active.pop().unwrap());
        waits.remove(0).await.unwrap();
        gate.commands.send(ResumeGateCommand::Release).unwrap();
        // After project A receives one slot, the next released slot is given
        // to project B even though A filled the queue first.
        waits.remove(31).await.unwrap();
        gate.commands.send(ResumeGateCommand::Release).unwrap();
        drop(active);
    }

    #[tokio::test]
    async fn resume_gate_shutdown_stops_admission_and_waits_for_active_attempts() {
        let gate = FairResumeGate::new(MAX_ACTIVE_AGENT_RESUMES, MAX_QUEUED_AGENT_RESUMES);
        let active = futures_util::future::join_all(
            (0..MAX_ACTIVE_AGENT_RESUMES).map(|index| gate.acquire(format!("active-{index}"))),
        )
        .await
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
        let waiting_gate = gate.clone();
        let waiting = tokio::spawn(async move { waiting_gate.acquire("queued".into()).await });
        tokio::task::yield_now().await;

        let shutdown = gate.shutdown();
        tokio::pin!(shutdown);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut shutdown)
                .await
                .is_err(),
            "shutdown completed while resume attempts were still active"
        );
        assert!(matches!(
            waiting.await.unwrap(),
            Err(ResumeGateError::Stopped)
        ));
        assert!(matches!(
            gate.acquire("late".into()).await,
            Err(ResumeGateError::Stopped)
        ));

        drop(active);
        tokio::time::timeout(Duration::from_secs(1), &mut shutdown)
            .await
            .expect("shutdown did not finish after active attempts released");
    }

    #[tokio::test]
    async fn persistent_assistant_lanes_are_independent_from_saturated_ordinary_resumes() {
        let gates = AgentResumeGates::new();
        let ordinary = futures_util::future::join_all((0..MAX_ACTIVE_AGENT_RESUMES).map(|index| {
            gates
                .for_lane(termloop_core::AgentResumeLane::Ordinary)
                .acquire(format!("ordinary-{index}"))
        }))
        .await
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();

        let steward = tokio::time::timeout(
            Duration::from_millis(25),
            gates
                .for_lane(termloop_core::AgentResumeLane::Steward)
                .acquire("project-steward".into()),
        )
        .await
        .expect("Steward resume waited behind the ordinary lane")
        .unwrap();
        let worker = tokio::time::timeout(
            Duration::from_millis(25),
            gates
                .for_lane(termloop_core::AgentResumeLane::Worker)
                .acquire("project-worker".into()),
        )
        .await
        .expect("Worker resume waited behind the ordinary lane")
        .unwrap();

        drop((ordinary, steward, worker));
        gates.shutdown().await;
    }
}
