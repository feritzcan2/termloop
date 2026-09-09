use super::*;
use tokio::sync::oneshot;

#[tokio::test]
async fn launch_observation_waits_for_the_existing_project_queue() {
    let gate = FairObservationGate::new();
    let holder = gate
        .acquire("project", ObservationPriority::Background)
        .await
        .unwrap();
    let scope = ("helper-task".to_owned(), "project".to_owned());
    let queued =
        acquire_launch_observation(&gate, Some(&scope), Instant::now() + Duration::from_secs(2));
    tokio::pin!(queued);
    assert!(
        tokio::time::timeout(Duration::from_millis(25), &mut queued)
            .await
            .is_err()
    );
    drop(holder);
    let permit = tokio::time::timeout(Duration::from_secs(2), queued)
        .await
        .unwrap()
        .unwrap();
    assert!(permit.is_some());
}

#[tokio::test]
async fn launch_queue_timeout_names_the_task_and_does_not_reserve_a_slot() {
    let gate = FairObservationGate::new();
    let holder = gate
        .acquire("project", ObservationPriority::Explicit)
        .await
        .unwrap();
    let scope = ("helper-task".to_owned(), "project".to_owned());
    let result = acquire_launch_observation(
        &gate,
        Some(&scope),
        Instant::now() + Duration::from_millis(25),
    )
    .await;
    assert!(
        matches!(result, Err(CoreError::TaskWorktreeUnavailable { task_id, reason: termloop_core::TaskWorktreeUnavailableReason::Timeout }) if task_id == "helper-task")
    );
    drop(holder);
    let successor =
        acquire_launch_observation(&gate, Some(&scope), Instant::now() + Duration::from_secs(2))
            .await
            .unwrap();
    assert!(successor.is_some());
}

struct DropProbe(Option<oneshot::Sender<std::thread::ThreadId>>);

impl Drop for DropProbe {
    fn drop(&mut self) {
        let _ = self.0.take().unwrap().send(std::thread::current().id());
    }
}

#[tokio::test]
async fn cancelling_while_waiting_for_core_disposes_off_the_async_worker() {
    let async_thread = std::thread::current().id();
    let (dropped, disposal) = oneshot::channel();
    let (ready, waiting) = oneshot::channel();
    let core = std::sync::Arc::new(tokio::sync::Mutex::new(()));
    let held = core.clone().lock_owned().await;
    let task = tokio::spawn(async move {
        let plan = BlockingDrop::new(DropProbe(Some(dropped)));
        ready.send(()).unwrap();
        let _lock = core.lock().await;
        drop(plan);
    });
    waiting.await.unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    let drop_thread = tokio::time::timeout(Duration::from_secs(2), disposal)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(drop_thread, async_thread);
    drop(held);
}

#[tokio::test]
async fn abandoned_blocking_preparation_keeps_its_permit_until_work_finishes() {
    let gate = FairObservationGate::new();
    let scope = ("helper-task".to_owned(), "project".to_owned());
    let permit =
        acquire_launch_observation(&gate, Some(&scope), Instant::now() + Duration::from_secs(2))
            .await
            .unwrap();
    let (started, working) = oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let (dropped, disposal) = oneshot::channel();
    let task = tokio::spawn(async move {
        run_blocking_preparation(
            BlockingDrop::new(DropProbe(Some(dropped))),
            permit,
            "helper",
            move |_| {
                started.send(()).unwrap();
                released.recv_timeout(Duration::from_secs(2)).unwrap();
                Ok(())
            },
        )
        .await
        .unwrap()
    });
    working.await.unwrap();
    task.abort();
    assert!(task.await.is_err());
    let queued =
        acquire_launch_observation(&gate, Some(&scope), Instant::now() + Duration::from_secs(2));
    tokio::pin!(queued);
    assert!(
        tokio::time::timeout(Duration::from_millis(25), &mut queued)
            .await
            .is_err()
    );
    release.send(()).unwrap();
    let successor = tokio::time::timeout(Duration::from_secs(2), queued)
        .await
        .unwrap()
        .unwrap();
    assert!(successor.is_some());
    let drop_thread = tokio::time::timeout(Duration::from_secs(2), disposal)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(drop_thread, std::thread::current().id());
}

#[tokio::test]
async fn failed_preparation_disposes_the_plan_and_releases_the_project_slot() {
    let gate = FairObservationGate::new();
    let scope = ("helper-task".to_owned(), "project".to_owned());
    let permit =
        acquire_launch_observation(&gate, Some(&scope), Instant::now() + Duration::from_secs(2))
            .await
            .unwrap();
    let (dropped, disposal) = oneshot::channel();
    let result = run_blocking_preparation(
        BlockingDrop::new(DropProbe(Some(dropped))),
        permit,
        "helper",
        |_| Err(CoreError::NotFound),
    )
    .await;
    assert!(matches!(result, Err(CoreError::NotFound)));
    let drop_thread = tokio::time::timeout(Duration::from_secs(2), disposal)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(drop_thread, std::thread::current().id());
    let successor =
        acquire_launch_observation(&gate, Some(&scope), Instant::now() + Duration::from_secs(2))
            .await
            .unwrap();
    assert!(successor.is_some());
}
