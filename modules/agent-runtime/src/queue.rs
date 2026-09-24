use std::collections::{HashMap, VecDeque};
use termloop_launch::GeneratedTerminalSubmission;

const MAX_QUEUED_GENERATED_INPUTS_PER_SESSION: usize = 16;
const MAX_QUEUED_GENERATED_INPUTS: usize = 256;

pub struct PendingGeneratedInputQueue {
    pub runtime_epoch: u64,
    pub submissions: VecDeque<termloop_launch::GeneratedTerminalSubmission>,
}

pub fn enqueue(
    queues: &mut HashMap<String, PendingGeneratedInputQueue>,
    session_id: &str,
    runtime_epoch: u64,
    submission: GeneratedTerminalSubmission,
) -> bool {
    let total_queued = queues
        .values()
        .map(|queue| queue.submissions.len())
        .sum::<usize>();
    let queue = queues
        .entry(session_id.to_owned())
        .or_insert_with(|| PendingGeneratedInputQueue {
            runtime_epoch,
            submissions: VecDeque::new(),
        });
    if queue.runtime_epoch != runtime_epoch {
        queue.runtime_epoch = runtime_epoch;
        queue.submissions.clear();
    }
    if queue.submissions.len() >= MAX_QUEUED_GENERATED_INPUTS_PER_SESSION
        || total_queued >= MAX_QUEUED_GENERATED_INPUTS
    {
        return false;
    }
    queue.submissions.push_back(submission);
    true
}

pub fn pop(
    queues: &mut HashMap<String, PendingGeneratedInputQueue>,
    session_id: &str,
    runtime_epoch: u64,
) -> Option<GeneratedTerminalSubmission> {
    let submission = queues
        .get_mut(session_id)
        .filter(|queue| queue.runtime_epoch == runtime_epoch)
        .and_then(|queue| queue.submissions.pop_front());
    let remove_queue = queues
        .get(session_id)
        .is_some_and(|queue| queue.runtime_epoch != runtime_epoch || queue.submissions.is_empty());
    if remove_queue {
        queues.remove(session_id);
    }
    submission
}
