#![cfg(unix)]

use std::fs;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};
use termloop_terminal::{PtySpawnSpec, TerminalEvent, TerminalService};

struct Fixture {
    root: PathBuf,
    terminal: TerminalService,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "termloop-terminal-duplex-{}",
            termloop_platform::generate_opaque_id()
        ));
        fs::create_dir_all(&root).unwrap();
        Self {
            root,
            terminal: TerminalService::default(),
        }
    }

    fn spawn(&self, id: &str, script: &str) {
        self.terminal
            .spawn(PtySpawnSpec {
                session_id: id.into(),
                runtime_epoch: 17,
                program: "/bin/sh".into(),
                args: vec!["-c".into(), script.into()],
                cwd: self.root.display().to_string(),
                environment: termloop_platform::LaunchEnvironment::os_baseline(),
                recent_output_replay: true,
            })
            .unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.terminal.terminate_all();
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn wait_until(mut condition: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(Instant::now() < end, "fixture timeout");
        thread::sleep(Duration::from_millis(10));
    }
}

#[tokio::test]
async fn duplex_output_drains_while_direct_and_atomic_input_are_writing() {
    for atomic in [false, true] {
        let fixture = Fixture::new();
        fixture.spawn("duplex", "stty raw -echo; touch ready; exec /bin/cat");
        wait_until(|| fixture.root.join("ready").exists());
        let mut output = fixture.terminal.subscribe("duplex", 17).unwrap();
        let bytes = vec![
            b'x';
            if atomic {
                termloop_terminal::MAX_ATOMIC_INPUT_BYTES
            } else {
                termloop_terminal::MAX_IO_CHUNK_BYTES
            }
        ];
        let pending = if atomic {
            fixture
                .terminal
                .input_atomic_receipted("duplex", 17, &bytes)
        } else {
            fixture.terminal.input_user_receipted("duplex", 17, &bytes)
        }
        .unwrap();
        pending
            .wait(Duration::from_secs(3))
            .expect("duplex input must not deadlock the output reader");
        let observed = tokio::time::timeout(Duration::from_secs(3), async {
            let mut observed = Vec::new();
            while observed.len() < bytes.len() {
                match output.recv().await.unwrap() {
                    TerminalEvent::Output(chunk) => observed.extend(chunk),
                    other => panic!("unexpected duplex event: {other:?}"),
                }
            }
            observed
        })
        .await
        .unwrap();
        assert_eq!(observed, bytes);
    }
}

#[test]
fn natural_exit_reaps_descendants_before_reporting_even_when_replay_is_retained() {
    for retain in [false, true] {
        let fixture = Fixture::new();
        fixture.spawn("orphan", "trap '' HUP TERM; echo $$ > root.pid; sleep 60 >/dev/null 2>&1 & echo $! > child.pid; exit 0");
        fixture
            .terminal
            .set_exit_replay_retention("orphan", 17, retain)
            .unwrap();
        wait_until(|| {
            fixture.root.join("child.pid").exists()
                && !fixture.terminal.session_is_running("orphan", 17).unwrap()
        });
        let root_pid = fs::read_to_string(fixture.root.join("root.pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(!termloop_platform::wait_for_process_tree_exit(root_pid, Duration::ZERO).unwrap());
        let reaped = fixture.terminal.reap_exited().unwrap();
        assert_eq!(reaped.len(), 1);
        assert_eq!(reaped[0].runtime_epoch, 17);
        assert!(termloop_platform::wait_for_process_tree_exit(root_pid, Duration::ZERO).unwrap());
        assert_eq!(fixture.terminal.contains_session("orphan").unwrap(), retain);
        assert!(fixture.terminal.reap_exited().unwrap().is_empty());
    }
}
