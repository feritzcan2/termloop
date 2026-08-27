use futures_util::{SinkExt, StreamExt};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};

const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const PROBE_RETRY_DELAY: Duration = Duration::from_millis(50);
const MAX_ROLLOUT_BYTES: usize = 512 << 20;
const MAX_ROLLOUT_RECORDS: usize = 1_000_000;
const MAX_DUPLICATE_BOUNDARIES: u64 = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexThreadHistoryProbeError {
    Damaged,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexThreadHistoryInspection {
    Healthy,
    Damaged {
        codex_home: PathBuf,
        rollout_path: Option<PathBuf>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexThreadHistoryRepairError {
    Unavailable,
    DamageUnrecognized,
    MutationFailed,
    VerificationFailed,
    RecoveryAttention,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexThreadHistoryRepair {
    pub repaired_records: u64,
    pub duplicate_boundaries: u64,
    pub backup_path: PathBuf,
}

/// Gives a newly started Codex App Server a best-effort opportunity to project
/// the complete durable history before its resume TUI can append. The probe
/// fork is ephemeral and returns no turns, so it creates no rollout. Callers
/// must decide whether an unavailable probe is allowed to continue. A damaged
/// result is authoritative and must never be followed by a writer launch.
pub fn probe_codex_thread_history(
    upstream_endpoint: &str,
    native_thread_id: &str,
) -> Result<(), CodexThreadHistoryProbeError> {
    if native_thread_id.is_empty() {
        return Err(CodexThreadHistoryProbeError::Unavailable);
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| CodexThreadHistoryProbeError::Unavailable)?;
    runtime.block_on(async {
        tokio::time::timeout(
            PROBE_TIMEOUT,
            inspect_codex_thread_history_inner(upstream_endpoint, native_thread_id),
        )
        .await
        .map_err(|_| CodexThreadHistoryProbeError::Unavailable)?
        .and_then(|inspection| match inspection {
            CodexThreadHistoryInspection::Healthy => Ok(()),
            CodexThreadHistoryInspection::Damaged { .. } => {
                Err(CodexThreadHistoryProbeError::Damaged)
            }
        })
    })
}

pub fn inspect_codex_thread_history(
    upstream_endpoint: &str,
    native_thread_id: &str,
) -> Result<CodexThreadHistoryInspection, CodexThreadHistoryProbeError> {
    if native_thread_id.is_empty() {
        return Err(CodexThreadHistoryProbeError::Unavailable);
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| CodexThreadHistoryProbeError::Unavailable)?;
    runtime.block_on(async {
        tokio::time::timeout(
            PROBE_TIMEOUT,
            inspect_codex_thread_history_inner(upstream_endpoint, native_thread_id),
        )
        .await
        .map_err(|_| CodexThreadHistoryProbeError::Unavailable)?
    })
}

async fn inspect_codex_thread_history_inner(
    upstream_endpoint: &str,
    native_thread_id: &str,
) -> Result<CodexThreadHistoryInspection, CodexThreadHistoryProbeError> {
    let mut socket = loop {
        match connect_async(upstream_endpoint).await {
            Ok((socket, _)) => break socket,
            Err(_) => tokio::time::sleep(PROBE_RETRY_DELAY).await,
        }
    };
    socket
        .send(Message::Text(
            serde_json::json!({
                "id": "termloop-history-initialize",
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "termloop",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                    "capabilities": { "experimentalApi": true },
                },
            })
            .to_string()
            .into(),
        ))
        .await
        .map_err(|_| CodexThreadHistoryProbeError::Unavailable)?;
    let initialize = probe_response(&mut socket, "termloop-history-initialize").await?;
    let codex_home = initialize
        .get("codexHome")
        .and_then(serde_json::Value::as_str)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .ok_or(CodexThreadHistoryProbeError::Unavailable)?;
    socket
        .send(Message::Text(
            serde_json::json!({ "method": "initialized" })
                .to_string()
                .into(),
        ))
        .await
        .map_err(|_| CodexThreadHistoryProbeError::Unavailable)?;
    socket
        .send(Message::Text(
            serde_json::json!({
                "id": "termloop-history-read",
                "method": "thread/read",
                "params": {
                    "threadId": native_thread_id,
                    "includeTurns": false,
                },
            })
            .to_string()
            .into(),
        ))
        .await
        .map_err(|_| CodexThreadHistoryProbeError::Unavailable)?;
    let rollout_path = match probe_response(&mut socket, "termloop-history-read").await {
        Ok(result) => result
            .pointer("/thread/path")
            .and_then(serde_json::Value::as_str)
            .filter(|path| !path.is_empty() && path.len() <= 32_768)
            .map(PathBuf::from),
        Err(CodexThreadHistoryProbeError::Damaged) => {
            let _ = socket.close(None).await;
            return Ok(CodexThreadHistoryInspection::Damaged {
                codex_home,
                rollout_path: None,
            });
        }
        Err(error) => return Err(error),
    };
    socket
        .send(Message::Text(
            serde_json::json!({
                "id": "termloop-history-fork",
                "method": "thread/fork",
                "params": {
                    "threadId": native_thread_id,
                    "ephemeral": true,
                    "excludeTurns": true,
                },
            })
            .to_string()
            .into(),
        ))
        .await
        .map_err(|_| CodexThreadHistoryProbeError::Unavailable)?;
    let fork = probe_response(&mut socket, "termloop-history-fork").await;
    let _ = socket.close(None).await;
    match fork {
        Ok(_) => Ok(CodexThreadHistoryInspection::Healthy),
        Err(CodexThreadHistoryProbeError::Damaged) => Ok(CodexThreadHistoryInspection::Damaged {
            codex_home,
            rollout_path,
        }),
        Err(error) => Err(error),
    }
}

async fn probe_response(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    request_id: &str,
) -> Result<serde_json::Value, CodexThreadHistoryProbeError> {
    while let Some(frame) = socket.next().await {
        let message = frame.map_err(|_| CodexThreadHistoryProbeError::Unavailable)?;
        let Message::Text(text) = message else {
            continue;
        };
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|_| CodexThreadHistoryProbeError::Unavailable)?;
        if value.get("id").and_then(serde_json::Value::as_str) != Some(request_id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(classify_probe_error(error));
        }
        return value
            .get("result")
            .cloned()
            .ok_or(CodexThreadHistoryProbeError::Unavailable);
    }
    Err(CodexThreadHistoryProbeError::Unavailable)
}

fn classify_probe_error(error: &serde_json::Value) -> CodexThreadHistoryProbeError {
    let message = error
        .get("message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if message.contains("thread history projection")
        || (message.contains("thread-store internal error") && message.contains("expected ordinal"))
    {
        CodexThreadHistoryProbeError::Damaged
    } else {
        CodexThreadHistoryProbeError::Unavailable
    }
}

pub fn repair_codex_thread_history(
    codex_home: &Path,
    rollout_path: &Path,
    native_thread_id: &str,
) -> Result<CodexThreadHistoryRepair, CodexThreadHistoryRepairError> {
    if native_thread_id.is_empty() {
        return Err(CodexThreadHistoryRepairError::Unavailable);
    }
    let rollout_path = ["sessions", "archived_sessions"]
        .into_iter()
        .find_map(|directory| {
            termloop_platform::canonical_existing_file_within(
                &codex_home.join(directory),
                rollout_path,
            )
            .ok()
        })
        .ok_or(CodexThreadHistoryRepairError::Unavailable)?;
    let original = termloop_platform::read_bounded_file(&rollout_path, MAX_ROLLOUT_BYTES)
        .map_err(|_| CodexThreadHistoryRepairError::Unavailable)?;
    let normalized = normalize_duplicate_ordinals(&original, native_thread_id)?;
    let backup_path = termloop_platform::backup_and_atomic_replace_private_file(
        &rollout_path,
        &original,
        &normalized.bytes,
    )
    .map_err(|_| CodexThreadHistoryRepairError::MutationFailed)?;
    let verified = termloop_platform::read_bounded_file(&rollout_path, normalized.bytes.len())
        .map_err(|_| CodexThreadHistoryRepairError::VerificationFailed)?;
    if verified != normalized.bytes {
        return match termloop_platform::atomic_replace_private_file(&rollout_path, &original) {
            Ok(()) => Err(CodexThreadHistoryRepairError::VerificationFailed),
            Err(_) => Err(CodexThreadHistoryRepairError::RecoveryAttention),
        };
    }
    Ok(CodexThreadHistoryRepair {
        repaired_records: normalized.repaired_records,
        duplicate_boundaries: normalized.duplicate_boundaries,
        backup_path,
    })
}

struct NormalizedRollout {
    bytes: Vec<u8>,
    repaired_records: u64,
    duplicate_boundaries: u64,
}

fn normalize_duplicate_ordinals(
    original: &[u8],
    native_thread_id: &str,
) -> Result<NormalizedRollout, CodexThreadHistoryRepairError> {
    if original.is_empty() || !original.ends_with(b"\n") {
        return Err(CodexThreadHistoryRepairError::DamageUnrecognized);
    }
    let mut replacement = Vec::with_capacity(original.len());
    let mut previous: Option<u64> = None;
    let mut base_ordinal: Option<u64> = None;
    let mut repaired_records = 0u64;
    let mut duplicate_boundaries = 0u64;
    let mut record_count = 0usize;
    for (index, record) in original.split_inclusive(|byte| *byte == b'\n').enumerate() {
        if index >= MAX_ROLLOUT_RECORDS || record.len() <= 1 || record[record.len() - 2] == b'\r' {
            return Err(CodexThreadHistoryRepairError::DamageUnrecognized);
        }
        let line = &record[..record.len() - 1];
        let value: serde_json::Value = serde_json::from_slice(line)
            .map_err(|_| CodexThreadHistoryRepairError::DamageUnrecognized)?;
        let object = value
            .as_object()
            .ok_or(CodexThreadHistoryRepairError::DamageUnrecognized)?;
        let current = object
            .get("ordinal")
            .and_then(serde_json::Value::as_u64)
            .ok_or(CodexThreadHistoryRepairError::DamageUnrecognized)?;
        if object
            .iter()
            .filter(|(key, _)| key.as_str() != "ordinal")
            .any(|(_, value)| contains_ordinal_key(value))
        {
            return Err(CodexThreadHistoryRepairError::DamageUnrecognized);
        }
        if index == 0
            && (object.get("type").and_then(serde_json::Value::as_str) != Some("session_meta")
                || value
                    .pointer("/payload/id")
                    .and_then(serde_json::Value::as_str)
                    != Some(native_thread_id))
        {
            return Err(CodexThreadHistoryRepairError::DamageUnrecognized);
        }
        if index == 0 {
            base_ordinal = Some(current);
        }
        if let Some(previous) = previous {
            if current == previous {
                if object.get("type").and_then(serde_json::Value::as_str) != Some("event_msg")
                    || value
                        .pointer("/payload/type")
                        .and_then(serde_json::Value::as_str)
                        != Some("thread_settings_applied")
                {
                    return Err(CodexThreadHistoryRepairError::DamageUnrecognized);
                }
                duplicate_boundaries += 1;
                if duplicate_boundaries > MAX_DUPLICATE_BOUNDARIES {
                    return Err(CodexThreadHistoryRepairError::DamageUnrecognized);
                }
            } else if previous.checked_add(1) != Some(current) {
                return Err(CodexThreadHistoryRepairError::DamageUnrecognized);
            }
        }
        // Codex may retain a compacted rollout segment whose session_meta
        // record starts at the original thread ordinal rather than zero. Keep
        // that observed base and repair only the known duplicate offsets that
        // follow it.
        let expected = base_ordinal
            .and_then(|base| base.checked_add(index as u64))
            .ok_or(CodexThreadHistoryRepairError::DamageUnrecognized)?;
        if expected.checked_sub(current) != Some(duplicate_boundaries) {
            return Err(CodexThreadHistoryRepairError::DamageUnrecognized);
        }
        if current == expected {
            replacement.extend_from_slice(record);
        } else {
            let (start, end) = ordinal_digits(line, current)?;
            let expected = expected.to_string();
            replacement.extend_from_slice(&line[..start]);
            replacement.extend_from_slice(expected.as_bytes());
            replacement.extend_from_slice(&line[end..]);
            replacement.push(b'\n');
            repaired_records += 1;
        }
        previous = Some(current);
        record_count += 1;
    }
    if record_count == 0 || duplicate_boundaries == 0 || repaired_records == 0 {
        return Err(CodexThreadHistoryRepairError::DamageUnrecognized);
    }
    Ok(NormalizedRollout {
        bytes: replacement,
        repaired_records,
        duplicate_boundaries,
    })
}

fn contains_ordinal_key(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(object) => object
            .iter()
            .any(|(key, value)| key == "ordinal" || contains_ordinal_key(value)),
        serde_json::Value::Array(values) => values.iter().any(contains_ordinal_key),
        _ => false,
    }
}

fn ordinal_digits(
    line: &[u8],
    parsed_ordinal: u64,
) -> Result<(usize, usize), CodexThreadHistoryRepairError> {
    const MIDDLE: &[u8] = b",\"ordinal\":";
    const FIRST: &[u8] = b"{\"ordinal\":";
    let matches = line
        .windows(MIDDLE.len())
        .enumerate()
        .filter_map(|(index, value)| (value == MIDDLE).then_some(index + MIDDLE.len()))
        .chain(line.starts_with(FIRST).then_some(FIRST.len()))
        .collect::<Vec<_>>();
    let [start] = matches.as_slice() else {
        return Err(CodexThreadHistoryRepairError::DamageUnrecognized);
    };
    let mut end = *start;
    while end < line.len() && line[end].is_ascii_digit() {
        end += 1;
    }
    if end == *start || !matches!(line.get(end), Some(b',') | Some(b'}')) {
        return Err(CodexThreadHistoryRepairError::DamageUnrecognized);
    }
    let textual = std::str::from_utf8(&line[*start..end])
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or(CodexThreadHistoryRepairError::DamageUnrecognized)?;
    if textual != parsed_ordinal {
        return Err(CodexThreadHistoryRepairError::DamageUnrecognized);
    }
    Ok((*start, end))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::{Message, accept};

    fn serve_probe(response: &'static str) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("ws://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            serve_probe_stream(stream, response);
        });
        (endpoint, server)
    }

    fn serve_probe_stream(stream: std::net::TcpStream, response: &'static str) {
        let mut socket = accept(stream).unwrap();
        let initialize: serde_json::Value =
            serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(
            initialize.get("method").and_then(serde_json::Value::as_str),
            Some("initialize")
        );
        socket
            .send(Message::Text(
                r#"{"id":"termloop-history-initialize","result":{"userAgent":"test","platformFamily":"unix","platformOs":"linux","codexHome":"/tmp"}}"#
                    .into(),
            ))
            .unwrap();
        let initialized: serde_json::Value =
            serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(
            initialized
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("initialized")
        );
        let read: serde_json::Value =
            serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(
            read.get("method").and_then(serde_json::Value::as_str),
            Some("thread/read")
        );
        assert_eq!(
            read.pointer("/params/threadId")
                .and_then(serde_json::Value::as_str),
            Some("native-thread")
        );
        assert_eq!(
            read.pointer("/params/includeTurns")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        socket
            .send(Message::Text(
                r#"{"id":"termloop-history-read","result":{"thread":{"path":"/tmp/rollout.jsonl"}}}"#
                    .into(),
            ))
            .unwrap();
        let fork: serde_json::Value =
            serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(
            fork.get("method").and_then(serde_json::Value::as_str),
            Some("thread/fork")
        );
        assert_eq!(
            fork.pointer("/params/threadId")
                .and_then(serde_json::Value::as_str),
            Some("native-thread")
        );
        assert_eq!(
            fork.pointer("/params/ephemeral")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        socket.send(Message::Text(response.into())).unwrap();
        let _ = socket.close(None);
    }

    #[test]
    fn projects_the_exact_thread_before_resume() {
        let (endpoint, server) = serve_probe(
            r#"{"id":"termloop-history-fork","result":{"thread":{"id":"ephemeral-probe"}}}"#,
        );
        assert_eq!(
            probe_codex_thread_history(&endpoint, "native-thread"),
            Ok(())
        );
        server.join().unwrap();
    }

    #[test]
    fn waits_for_the_new_app_server_to_begin_listening() {
        let port = termloop_platform::reserve_loopback_port().unwrap();
        let endpoint = format!("ws://127.0.0.1:{port}");
        let server = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            let listener = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
            let (stream, _) = listener.accept().unwrap();
            serve_probe_stream(
                stream,
                r#"{"id":"termloop-history-fork","result":{"thread":{"id":"ephemeral-probe"}}}"#,
            );
        });
        assert_eq!(
            probe_codex_thread_history(&endpoint, "native-thread"),
            Ok(())
        );
        server.join().unwrap();
    }

    #[test]
    fn classifies_duplicate_ordinal_projection_damage() {
        let (endpoint, server) = serve_probe(
            r#"{"id":"termloop-history-fork","error":{"code":-32603,"message":"failed to prepare paginated fork: thread-store internal error: thread history projection for native-thread expected ordinal 11775, got 11774"}}"#,
        );
        assert_eq!(
            probe_codex_thread_history(&endpoint, "native-thread"),
            Err(CodexThreadHistoryProbeError::Damaged)
        );
        server.join().unwrap();
    }

    #[test]
    fn inspection_returns_the_private_rollout_locator_only_for_internal_repair() {
        let (endpoint, server) = serve_probe(
            r#"{"id":"termloop-history-fork","error":{"code":-32603,"message":"thread-store internal error: thread history projection expected ordinal 12, got 11"}}"#,
        );
        assert_eq!(
            inspect_codex_thread_history(&endpoint, "native-thread"),
            Ok(CodexThreadHistoryInspection::Damaged {
                codex_home: PathBuf::from("/tmp"),
                rollout_path: Some(PathBuf::from("/tmp/rollout.jsonl")),
            })
        );
        server.join().unwrap();
    }

    #[test]
    fn repairs_only_known_restart_duplicates_and_retains_the_exact_backup() {
        let root = std::env::temp_dir().join(format!(
            "termloop-codex-history-repair-{}-{}",
            std::process::id(),
            termloop_platform::current_epoch_ms()
        ));
        let sessions = root.join("sessions/2026/08/23");
        std::fs::create_dir_all(&sessions).unwrap();
        let path = sessions.join("rollout.jsonl");
        let original = concat!(
            r#"{"type":"session_meta","payload":{"id":"native-thread"},"ordinal":0}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"user_message"},"ordinal":1}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"thread_settings_applied"},"ordinal":1}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"agent_message"},"ordinal":2}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"agent_message"},"ordinal":3}"#,
            "\n",
        )
        .as_bytes();
        std::fs::write(&path, original).unwrap();

        let repaired = repair_codex_thread_history(&root, &path, "native-thread").unwrap();

        assert_eq!(repaired.duplicate_boundaries, 1);
        assert_eq!(repaired.repaired_records, 3);
        assert_eq!(std::fs::read(&repaired.backup_path).unwrap(), original);
        let current = std::fs::read_to_string(&path).unwrap();
        let ordinals = current
            .lines()
            .map(|line| {
                serde_json::from_str::<serde_json::Value>(line).unwrap()["ordinal"]
                    .as_u64()
                    .unwrap()
            })
            .collect::<Vec<_>>();
        assert_eq!(ordinals, vec![0, 1, 2, 3, 4]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn repairs_ordinals_across_a_decimal_width_boundary() {
        let mut original =
            String::from(r#"{"type":"session_meta","payload":{"id":"native-thread"},"ordinal":0}"#);
        original.push('\n');
        for ordinal in 1..=8 {
            original.push_str(&format!(
                r#"{{"type":"event_msg","payload":{{"type":"agent_message"}},"ordinal":{ordinal}}}"#
            ));
            original.push('\n');
        }
        original.push_str(
            r#"{"type":"event_msg","payload":{"type":"thread_settings_applied"},"ordinal":8}
"#,
        );
        for ordinal in 9..=10 {
            original.push_str(&format!(
                r#"{{"type":"event_msg","payload":{{"type":"agent_message"}},"ordinal":{ordinal}}}"#
            ));
            original.push('\n');
        }

        let normalized =
            normalize_duplicate_ordinals(original.as_bytes(), "native-thread").unwrap();
        let ordinals = std::str::from_utf8(&normalized.bytes)
            .unwrap()
            .lines()
            .map(|line| {
                serde_json::from_str::<serde_json::Value>(line).unwrap()["ordinal"]
                    .as_u64()
                    .unwrap()
            })
            .collect::<Vec<_>>();

        assert_eq!(ordinals, (0..=11).collect::<Vec<_>>());
        assert!(normalized.bytes.len() > original.len());
    }

    #[test]
    fn repairs_duplicate_ordinals_in_a_nonzero_rollout_segment() {
        let original = concat!(
            r#"{"type":"session_meta","payload":{"id":"native-thread"},"ordinal":1297}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"agent_message"},"ordinal":1298}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"thread_settings_applied"},"ordinal":1298}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"agent_message"},"ordinal":1299}"#,
            "\n",
        )
        .as_bytes();

        let normalized = normalize_duplicate_ordinals(original, "native-thread").unwrap();
        let ordinals = std::str::from_utf8(&normalized.bytes)
            .unwrap()
            .lines()
            .map(|line| {
                serde_json::from_str::<serde_json::Value>(line).unwrap()["ordinal"]
                    .as_u64()
                    .unwrap()
            })
            .collect::<Vec<_>>();

        assert_eq!(ordinals, vec![1297, 1298, 1299, 1300]);
        assert_eq!(normalized.duplicate_boundaries, 1);
        assert_eq!(normalized.repaired_records, 2);
    }

    #[test]
    fn refuses_an_unknown_duplicate_without_mutating_the_rollout() {
        let original = concat!(
            r#"{"type":"session_meta","payload":{"id":"native-thread"},"ordinal":0}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"user_message"},"ordinal":0}"#,
            "\n",
        )
        .as_bytes();
        assert_eq!(
            normalize_duplicate_ordinals(original, "native-thread")
                .err()
                .unwrap(),
            CodexThreadHistoryRepairError::DamageUnrecognized
        );
    }
}
