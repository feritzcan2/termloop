use std::collections::{HashMap, VecDeque};
use std::sync::{
    Arc, Mutex as StdMutex,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use termloop_terminal::{FrameKind, TerminalEvent};
use tokio::sync::{Notify, broadcast};
use uuid::Uuid;

use super::AppState;
use super::control::constant_time_equal;

const TERMINAL_HEADER_LEN: usize = 41;
const MAX_TERMINAL_PAYLOAD: usize = termloop_terminal::MAX_IO_CHUNK_BYTES;
const MAX_ATTACHMENT_FRAMES: usize = 256;
const TERMINAL_INPUT_RECEIPT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub(super) struct TerminalResizeRegistry {
    inner: Arc<TerminalResizeRegistryInner>,
}

struct TerminalResizeRegistryInner {
    next_connection_id: AtomicU64,
    owners: StdMutex<HashMap<Uuid, u64>>,
    changes: broadcast::Sender<ResizeOwnershipChange>,
}

#[derive(Clone)]
struct ResizeOwnershipChange {
    session_id: Uuid,
    owner: Option<u64>,
}

impl Default for TerminalResizeRegistry {
    fn default() -> Self {
        let (changes, _) = broadcast::channel(128);
        Self {
            inner: Arc::new(TerminalResizeRegistryInner {
                next_connection_id: AtomicU64::new(1),
                owners: StdMutex::new(HashMap::new()),
                changes,
            }),
        }
    }
}

impl TerminalResizeRegistry {
    fn next_connection_id(&self) -> u64 {
        self.inner
            .next_connection_id
            .fetch_add(1, Ordering::Relaxed)
    }

    fn subscribe(&self) -> broadcast::Receiver<ResizeOwnershipChange> {
        self.inner.changes.subscribe()
    }

    fn claim_if_unowned(&self, session_id: Uuid, connection_id: u64) -> bool {
        let mut owners = self
            .inner
            .owners
            .lock()
            .expect("terminal resize ownership poisoned");
        if owners.contains_key(&session_id) {
            return false;
        }
        owners.insert(session_id, connection_id);
        drop(owners);
        let _ = self.inner.changes.send(ResizeOwnershipChange {
            session_id,
            owner: Some(connection_id),
        });
        true
    }

    fn focus(&self, session_id: Uuid, connection_id: u64) {
        let mut owners = self
            .inner
            .owners
            .lock()
            .expect("terminal resize ownership poisoned");
        if owners.insert(session_id, connection_id) == Some(connection_id) {
            return;
        }
        drop(owners);
        let _ = self.inner.changes.send(ResizeOwnershipChange {
            session_id,
            owner: Some(connection_id),
        });
    }

    fn is_owner(&self, session_id: Uuid, connection_id: u64) -> bool {
        self.inner
            .owners
            .lock()
            .expect("terminal resize ownership poisoned")
            .get(&session_id)
            .copied()
            == Some(connection_id)
    }

    fn release_connection(&self, connection_id: u64) {
        let released = {
            let mut owners = self
                .inner
                .owners
                .lock()
                .expect("terminal resize ownership poisoned");
            let released = owners
                .iter()
                .filter_map(|(session_id, owner)| (*owner == connection_id).then_some(*session_id))
                .collect::<Vec<_>>();
            owners.retain(|_, owner| *owner != connection_id);
            released
        };
        for session_id in released {
            let _ = self.inner.changes.send(ResizeOwnershipChange {
                session_id,
                owner: None,
            });
        }
    }

    fn release_session(&self, session_id: Uuid, connection_id: u64) {
        let released = {
            let mut owners = self
                .inner
                .owners
                .lock()
                .expect("terminal resize ownership poisoned");
            if owners.get(&session_id).copied() == Some(connection_id) {
                owners.remove(&session_id);
                true
            } else {
                false
            }
        };
        if released {
            let _ = self.inner.changes.send(ResizeOwnershipChange {
                session_id,
                owner: None,
            });
        }
    }
}

#[derive(Clone)]
struct TerminalFrame {
    session_id: Uuid,
    epoch: u64,
    sequence: u64,
    kind: u8,
    payload: Vec<u8>,
}

#[derive(Default)]
struct AttachmentQueue {
    frames: VecDeque<TerminalFrame>,
    dropped: u64,
    input_ack: Option<TerminalFrame>,
}

#[derive(Default)]
struct OutboundBuffer {
    attachments: HashMap<Uuid, AttachmentQueue>,
    round_robin: VecDeque<Uuid>,
}

impl OutboundBuffer {
    fn enqueue(&mut self, frame: TerminalFrame) {
        if let std::collections::hash_map::Entry::Vacant(entry) =
            self.attachments.entry(frame.session_id)
        {
            entry.insert(AttachmentQueue::default());
            self.round_robin.push_back(frame.session_id);
        }
        let queue = self
            .attachments
            .get_mut(&frame.session_id)
            .expect("inserted");
        if frame.kind == FrameKind::InputAck as u8 {
            if queue.input_ack.as_ref().is_none_or(|pending| {
                pending.epoch == frame.epoch && pending.sequence < frame.sequence
            }) {
                queue.input_ack = Some(frame);
            }
            return;
        }
        if queue.frames.len() == MAX_ATTACHMENT_FRAMES {
            queue.frames.pop_front();
            queue.dropped = queue.dropped.saturating_add(1);
        }
        queue.frames.push_back(frame);
    }

    fn pop_fair(&mut self) -> Option<TerminalFrame> {
        for _ in 0..self.round_robin.len() {
            let id = self.round_robin.pop_front()?;
            self.round_robin.push_back(id);
            let queue = self.attachments.get_mut(&id)?;
            if queue.dropped > 0 {
                let dropped = std::mem::take(&mut queue.dropped);
                let next = queue.frames.front()?;
                return Some(TerminalFrame {
                    session_id: id,
                    epoch: next.epoch,
                    sequence: next.sequence.saturating_sub(1),
                    kind: FrameKind::Gap as u8,
                    payload: dropped.to_be_bytes().to_vec(),
                });
            }
            if let Some(frame) = queue.input_ack.take() {
                return Some(frame);
            }
            if let Some(frame) = queue.frames.pop_front() {
                return Some(frame);
            }
        }
        None
    }

    fn detach(&mut self, session_id: Uuid) {
        self.attachments.remove(&session_id);
        self.round_robin
            .retain(|candidate| *candidate != session_id);
    }
}

pub(super) async fn terminal_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.max_message_size(8 * 1024 * 1024)
        .on_upgrade(move |socket| {
            let token = state.terminal_token.clone();
            terminal_socket(socket, state, token, true, None)
        })
}

pub(in crate::app) async fn terminal_socket_remote(
    socket: WebSocket,
    state: AppState,
    token: String,
    allow_input: bool,
    revocation: super::access_plane::RemoteRevocation,
) {
    terminal_socket(
        socket,
        state,
        Arc::from(token),
        allow_input,
        Some(revocation),
    )
    .await;
}

async fn terminal_socket(
    socket: WebSocket,
    state: AppState,
    expected_token: Arc<str>,
    allow_input: bool,
    mut revocation: Option<super::access_plane::RemoteRevocation>,
) {
    let connection_id = state.terminal_resizes.next_connection_id();
    let mut resize_changes = state.terminal_resizes.subscribe();
    let (mut sink, mut stream) = socket.split();
    let first = tokio::select! {
        _ = wait_for_remote_revocation(&mut revocation) => None,
        message = stream.next() => message,
    };
    let authenticated = match first {
        Some(Ok(Message::Binary(bytes))) => {
            bytes.starts_with(termloop_terminal::TERMINAL_FRAME_MAGIC)
                && bytes
                    .get(4..)
                    .is_some_and(|token| constant_time_equal(token, expected_token.as_bytes()))
        }
        _ => false,
    };
    if !authenticated {
        let _ = sink.send(Message::Binary(b"TLAUTH".to_vec().into())).await;
        return;
    }
    if sink
        .send(Message::Binary(b"TLOK".to_vec().into()))
        .await
        .is_err()
    {
        return;
    }
    // Each attached Session owns a fair 256 × 16 KiB queue (4 MiB). A flood
    // can evict only its own old output and the scheduler reports that gap.
    let outbound = Arc::new(StdMutex::new(OutboundBuffer::default()));
    let outbound_notify = Arc::new(Notify::new());
    let writer_buffer = outbound.clone();
    let writer_notify = outbound_notify.clone();
    let writer = tokio::spawn(async move {
        loop {
            let frame = writer_buffer
                .lock()
                .expect("outbound queue poisoned")
                .pop_fair();
            let Some(frame) = frame else {
                writer_notify.notified().await;
                continue;
            };
            if sink
                .send(Message::Binary(encode_terminal_frame(&frame).into()))
                .await
                .is_err()
            {
                break;
            }
        }
    });

    let mut attachment_tasks: HashMap<Uuid, tokio::task::JoinHandle<()>> = HashMap::new();
    let mut attached_epochs: HashMap<Uuid, u64> = HashMap::new();
    let mut input_ack_enabled = false;
    loop {
        let incoming = tokio::select! {
            _ = wait_for_remote_revocation(&mut revocation) => break,
            change = resize_changes.recv() => {
                if let Ok(change) = change
                    && let Some(epoch) = attached_epochs.get(&change.session_id).copied()
                {
                    enqueue_outbound(
                        &outbound,
                        &outbound_notify,
                        TerminalFrame {
                            session_id: change.session_id,
                            epoch,
                            sequence: 0,
                            kind: FrameKind::ResizeOwnership as u8,
                            payload: vec![u8::from(change.owner == Some(connection_id))],
                        },
                    );
                }
                continue;
            },
            message = stream.next() => message,
        };
        let Some(Ok(message)) = incoming else { break };
        let Message::Binary(bytes) = message else {
            continue;
        };
        let Ok(frame) = decode_terminal_frame(&bytes) else {
            continue;
        };
        let session = frame.session_id.to_string();
        match frame.kind {
            value
                if value == FrameKind::EnableInputAck as u8
                    && allow_input
                    && frame.session_id.is_nil()
                    && frame.epoch == 0
                    && frame.sequence == 0
                    && frame.payload.is_empty() =>
            {
                input_ack_enabled = true;
            }
            value if value == FrameKind::Attach as u8 => {
                match state.terminal.subscribe(&session, frame.epoch) {
                    Ok(mut receiver) => {
                        attached_epochs.insert(frame.session_id, frame.epoch);
                        let claimed = allow_input
                            && state
                                .terminal_resizes
                                .claim_if_unowned(frame.session_id, connection_id);
                        if !claimed {
                            let active = allow_input
                                && state
                                    .terminal_resizes
                                    .is_owner(frame.session_id, connection_id);
                            enqueue_outbound(
                                &outbound,
                                &outbound_notify,
                                TerminalFrame {
                                    session_id: frame.session_id,
                                    epoch: frame.epoch,
                                    sequence: 0,
                                    kind: FrameKind::ResizeOwnership as u8,
                                    payload: vec![u8::from(active)],
                                },
                            );
                        }
                        if let Some(mut previous) = attachment_tasks.remove(&frame.session_id) {
                            previous.abort();
                            let _ = (&mut previous).await;
                        }
                        let queue = outbound.clone();
                        let notify = outbound_notify.clone();
                        let id = frame.session_id;
                        let epoch = frame.epoch;
                        let sequence = Arc::new(AtomicU64::new(1));
                        let task = tokio::spawn(async move {
                            loop {
                                let (kind, payload) = match receiver.recv_delivery().await {
                                    Ok(delivery) => match delivery.event {
                                        TerminalEvent::Output(bytes) => (
                                            if delivery.recent_replay {
                                                FrameKind::ReplayOutput as u8
                                            } else {
                                                FrameKind::Output as u8
                                            },
                                            bytes,
                                        ),
                                        TerminalEvent::Gap(count) => {
                                            (FrameKind::Gap as u8, count.to_be_bytes().to_vec())
                                        }
                                        TerminalEvent::Eof => (FrameKind::Eof as u8, vec![]),
                                    },
                                    Err(tokio::sync::broadcast::error::RecvError::Lagged(
                                        count,
                                    )) => (FrameKind::Gap as u8, count.to_be_bytes().to_vec()),
                                    Err(_) => break,
                                };
                                let outgoing = TerminalFrame {
                                    session_id: id,
                                    epoch,
                                    sequence: sequence.fetch_add(1, Ordering::Relaxed),
                                    kind,
                                    payload,
                                };
                                queue
                                    .lock()
                                    .expect("outbound queue poisoned")
                                    .enqueue(outgoing);
                                notify.notify_one();
                                if kind == FrameKind::Eof as u8 {
                                    break;
                                }
                            }
                        });
                        attachment_tasks.insert(id, task);
                        enqueue_outbound(
                            &outbound,
                            &outbound_notify,
                            TerminalFrame {
                                kind: FrameKind::Ack as u8,
                                ..frame
                            },
                        );
                    }
                    Err(error) => {
                        enqueue_outbound(
                            &outbound,
                            &outbound_notify,
                            TerminalFrame {
                                kind: FrameKind::Error as u8,
                                payload: error.to_string().into_bytes(),
                                ..frame
                            },
                        );
                    }
                }
            }
            value if value == FrameKind::Input as u8 => {
                if !allow_input {
                    enqueue_outbound(
                        &outbound,
                        &outbound_notify,
                        TerminalFrame {
                            kind: FrameKind::Error as u8,
                            payload: b"credential does not allow terminal input".to_vec(),
                            ..frame
                        },
                    );
                    continue;
                }
                if input_ack_enabled {
                    let pending = match state.terminal.input_user_receipted(
                        &session,
                        frame.epoch,
                        &frame.payload,
                    ) {
                        Ok(pending) => pending,
                        Err(error) => {
                            enqueue_outbound(
                                &outbound,
                                &outbound_notify,
                                TerminalFrame {
                                    kind: FrameKind::Error as u8,
                                    payload: error.to_string().into_bytes(),
                                    ..frame
                                },
                            );
                            continue;
                        }
                    };
                    let receipt = tokio::task::spawn_blocking(move || {
                        pending.wait(TERMINAL_INPUT_RECEIPT_TIMEOUT)
                    })
                    .await;
                    match receipt {
                        Ok(Ok(_)) => enqueue_outbound(
                            &outbound,
                            &outbound_notify,
                            TerminalFrame {
                                kind: FrameKind::InputAck as u8,
                                payload: Vec::new(),
                                ..frame
                            },
                        ),
                        Ok(Err(error)) => enqueue_outbound(
                            &outbound,
                            &outbound_notify,
                            TerminalFrame {
                                kind: FrameKind::Error as u8,
                                payload: error.to_string().into_bytes(),
                                ..frame
                            },
                        ),
                        Err(_) => enqueue_outbound(
                            &outbound,
                            &outbound_notify,
                            TerminalFrame {
                                kind: FrameKind::Error as u8,
                                payload: b"terminal input receipt task failed".to_vec(),
                                ..frame
                            },
                        ),
                    }
                    continue;
                }
                if let Err(error) = state
                    .terminal
                    .input_user(&session, frame.epoch, &frame.payload)
                {
                    enqueue_outbound(
                        &outbound,
                        &outbound_notify,
                        TerminalFrame {
                            kind: FrameKind::Error as u8,
                            payload: error.to_string().into_bytes(),
                            ..frame
                        },
                    );
                }
            }
            value if value == FrameKind::Resize as u8 && frame.payload.len() == 4 => {
                if !allow_input
                    || !state
                        .terminal_resizes
                        .is_owner(frame.session_id, connection_id)
                {
                    continue;
                }
                let rows = u16::from_be_bytes([frame.payload[0], frame.payload[1]]);
                let cols = u16::from_be_bytes([frame.payload[2], frame.payload[3]]);
                if state.terminal.resize(&session, rows, cols).is_ok() {
                    state.terminal_grids.record_change();
                }
            }
            value if value == FrameKind::Focus as u8 => {
                if allow_input && attached_epochs.contains_key(&frame.session_id) {
                    state
                        .terminal_resizes
                        .focus(frame.session_id, connection_id);
                }
            }
            value if value == FrameKind::Detach as u8 && frame.payload.is_empty() => {
                if attached_epochs.get(&frame.session_id).copied() != Some(frame.epoch) {
                    continue;
                }
                attached_epochs.remove(&frame.session_id);
                if let Some(mut task) = attachment_tasks.remove(&frame.session_id) {
                    task.abort();
                    let _ = (&mut task).await;
                }
                outbound
                    .lock()
                    .expect("outbound queue poisoned")
                    .detach(frame.session_id);
                state
                    .terminal_resizes
                    .release_session(frame.session_id, connection_id);
            }
            _ => {}
        }
    }
    for (_, task) in attachment_tasks {
        task.abort();
    }
    writer.abort();
    state.terminal_resizes.release_connection(connection_id);
}

async fn wait_for_remote_revocation(
    revocation: &mut Option<super::access_plane::RemoteRevocation>,
) {
    match revocation {
        Some(revocation) => revocation.wait().await,
        None => std::future::pending::<()>().await,
    }
}

fn enqueue_outbound(buffer: &StdMutex<OutboundBuffer>, notify: &Notify, frame: TerminalFrame) {
    buffer
        .lock()
        .expect("outbound queue poisoned")
        .enqueue(frame);
    notify.notify_one();
}

fn encode_terminal_frame(frame: &TerminalFrame) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(TERMINAL_HEADER_LEN + frame.payload.len());
    bytes.extend_from_slice(b"TL01");
    bytes.extend_from_slice(frame.session_id.as_bytes());
    bytes.extend_from_slice(&frame.epoch.to_be_bytes());
    bytes.extend_from_slice(&frame.sequence.to_be_bytes());
    bytes.push(frame.kind);
    bytes.extend_from_slice(&(frame.payload.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&frame.payload);
    bytes
}

fn decode_terminal_frame(bytes: &[u8]) -> Result<TerminalFrame, ()> {
    if bytes.len() < TERMINAL_HEADER_LEN || &bytes[..4] != b"TL01" {
        return Err(());
    }
    let session_id = Uuid::from_slice(&bytes[4..20]).map_err(|_| ())?;
    let epoch = u64::from_be_bytes(bytes[20..28].try_into().map_err(|_| ())?);
    let sequence = u64::from_be_bytes(bytes[28..36].try_into().map_err(|_| ())?);
    let kind = bytes[36];
    let length = u32::from_be_bytes(bytes[37..41].try_into().map_err(|_| ())?) as usize;
    if length > MAX_TERMINAL_PAYLOAD || bytes.len() != TERMINAL_HEADER_LEN + length {
        return Err(());
    }
    Ok(TerminalFrame {
        session_id,
        epoch,
        sequence,
        kind,
        payload: bytes[41..].to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(payload: Vec<u8>) -> TerminalFrame {
        TerminalFrame {
            session_id: Uuid::nil(),
            epoch: 42,
            sequence: 9,
            kind: FrameKind::Input as u8,
            payload,
        }
    }

    #[test]
    fn terminal_frame_round_trips_and_enforces_payload_bound() {
        let original = frame(vec![7; MAX_TERMINAL_PAYLOAD]);
        let decoded = decode_terminal_frame(&encode_terminal_frame(&original)).unwrap();
        assert_eq!(decoded.session_id, original.session_id);
        assert_eq!(decoded.epoch, original.epoch);
        assert_eq!(decoded.sequence, original.sequence);
        assert_eq!(decoded.kind, original.kind);
        assert_eq!(decoded.payload, original.payload);
        assert!(
            decode_terminal_frame(&encode_terminal_frame(&frame(vec![
                0;
                MAX_TERMINAL_PAYLOAD + 1
            ])))
            .is_err()
        );
    }

    #[test]
    fn flooded_attachment_is_bounded_and_cannot_starve_its_peer() {
        let flooded = Uuid::new_v4();
        let interactive = Uuid::new_v4();
        let mut buffer = OutboundBuffer::default();
        for sequence in 0..(MAX_ATTACHMENT_FRAMES as u64 + 44) {
            buffer.enqueue(TerminalFrame {
                session_id: flooded,
                epoch: 1,
                sequence,
                kind: FrameKind::Output as u8,
                payload: vec![1; MAX_TERMINAL_PAYLOAD],
            });
        }
        buffer.enqueue(TerminalFrame {
            session_id: interactive,
            epoch: 1,
            sequence: 1,
            kind: FrameKind::Output as u8,
            payload: b"interactive".to_vec(),
        });

        let gap = buffer.pop_fair().unwrap();
        assert_eq!(gap.session_id, flooded);
        assert_eq!(gap.kind, FrameKind::Gap as u8);
        assert_eq!(u64::from_be_bytes(gap.payload.try_into().unwrap()), 44);
        let peer = buffer.pop_fair().unwrap();
        assert_eq!(peer.session_id, interactive);
        assert_eq!(peer.payload, b"interactive");
        assert_eq!(
            buffer.attachments[&flooded].frames.len(),
            MAX_ATTACHMENT_FRAMES
        );

        buffer.detach(flooded);
        assert!(!buffer.attachments.contains_key(&flooded));
        assert!(!buffer.round_robin.contains(&flooded));
    }

    #[test]
    fn input_ack_is_cumulative_and_does_not_evict_terminal_output() {
        let session_id = Uuid::new_v4();
        let mut buffer = OutboundBuffer::default();
        buffer.enqueue(TerminalFrame {
            session_id,
            epoch: 1,
            sequence: 1,
            kind: FrameKind::Output as u8,
            payload: b"output".to_vec(),
        });
        for sequence in 2..=4 {
            buffer.enqueue(TerminalFrame {
                session_id,
                epoch: 1,
                sequence,
                kind: FrameKind::InputAck as u8,
                payload: Vec::new(),
            });
        }

        let ack = buffer.pop_fair().unwrap();
        assert_eq!(ack.kind, FrameKind::InputAck as u8);
        assert_eq!(ack.sequence, 4);
        let output = buffer.pop_fair().unwrap();
        assert_eq!(output.kind, FrameKind::Output as u8);
        assert_eq!(output.payload, b"output");
    }

    #[test]
    fn resize_ownership_follows_focus_and_is_released_with_the_connection() {
        let registry = TerminalResizeRegistry::default();
        let session_id = Uuid::new_v4();
        let first = registry.next_connection_id();
        let second = registry.next_connection_id();
        let mut changes = registry.subscribe();

        registry.claim_if_unowned(session_id, first);
        assert!(registry.is_owner(session_id, first));
        assert_eq!(changes.try_recv().unwrap().owner, Some(first));
        assert!(!registry.claim_if_unowned(session_id, first));
        assert!(registry.is_owner(session_id, first));

        registry.claim_if_unowned(session_id, second);
        assert!(!registry.is_owner(session_id, second));
        assert!(changes.try_recv().is_err());

        registry.focus(session_id, second);
        assert!(registry.is_owner(session_id, second));
        assert_eq!(changes.try_recv().unwrap().owner, Some(second));

        registry.release_session(session_id, second);
        assert!(!registry.is_owner(session_id, second));
        assert_eq!(changes.try_recv().unwrap().owner, None);

        registry.focus(session_id, second);
        assert!(registry.is_owner(session_id, second));
        assert_eq!(changes.try_recv().unwrap().owner, Some(second));

        registry.release_connection(second);
        assert!(!registry.is_owner(session_id, second));
        assert_eq!(changes.try_recv().unwrap().owner, None);
    }
}
