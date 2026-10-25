//! The binary terminal data plane for PM agent PTYs, framed with
//! `termloop-terminal-wire` exactly as the developer daemon's plane. The
//! PM daemon is single-user, so every authenticated connection owns resize.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, PoisonError};
use std::time::Duration;

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use termloop_terminal::{FrameKind, TerminalEvent};
use termloop_terminal_wire::{TerminalFrame, decode_terminal_frame, encode_terminal_frame};
use tokio::sync::Notify;
use uuid::Uuid;

use crate::app::AppState;
use crate::app::control::constant_time_equal;

const MAX_TERMINAL_MESSAGE: usize = 8 * 1024 * 1024;
const MAX_ATTACHMENT_FRAMES: usize = 256;
const TERMINAL_INPUT_RECEIPT_TIMEOUT: Duration = Duration::from_secs(4);
const REPLAY_REQUEST_MAGIC: &[u8; 4] = b"TLRQ";
const REPLAY_REQUEST_BYTES: usize = 12;
const MAX_REPLAY_WIRE_CHUNK_BYTES: usize = 256 * 1024;
const REPLAY_MOUSE_MODES_FLAG: u32 = 1 << 31;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ReplayRequest {
    max_bytes: usize,
    max_chunk_bytes: usize,
    mouse_modes: bool,
}

#[derive(Default)]
struct AttachmentQueue {
    frames: VecDeque<TerminalFrame>,
    dropped: u64,
    attach_ack: Option<TerminalFrame>,
    input_ack: Option<TerminalFrame>,
}

/// Per-session bounded queues drained round-robin, so one flooding session
/// can drop only its own old output, reported as a gap.
#[derive(Default)]
struct OutboundBuffer {
    attachments: HashMap<Uuid, AttachmentQueue>,
    round_robin: VecDeque<Uuid>,
}

impl OutboundBuffer {
    fn enqueue(&mut self, frame: TerminalFrame) {
        let id = frame.session_id;
        let queue = match self.attachments.entry(id) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => {
                self.round_robin.push_back(id);
                entry.insert(AttachmentQueue::default())
            }
        };
        if frame.kind == FrameKind::Ack as u8 {
            queue.attach_ack = Some(frame);
            return;
        }
        if frame.kind == FrameKind::InputAck as u8 {
            if queue.input_ack.as_ref().is_none_or(|pending| {
                pending.epoch != frame.epoch || pending.sequence < frame.sequence
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
            if let Some(frame) = queue.attach_ack.take() {
                return Some(frame);
            }
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

#[derive(Clone, Default)]
struct Outbound {
    buffer: Arc<StdMutex<OutboundBuffer>>,
    notify: Arc<Notify>,
}

impl Outbound {
    fn lock(&self) -> MutexGuard<'_, OutboundBuffer> {
        self.buffer.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn send(&self, frame: TerminalFrame) {
        self.lock().enqueue(frame);
        self.notify.notify_one();
    }

    fn reply(&self, to: &TerminalFrame, kind: FrameKind, payload: Vec<u8>) {
        self.send(TerminalFrame {
            session_id: to.session_id,
            epoch: to.epoch,
            sequence: to.sequence,
            kind: kind as u8,
            payload,
        });
    }
}

pub(super) async fn terminal_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.max_message_size(MAX_TERMINAL_MESSAGE)
        .on_upgrade(move |socket| terminal_socket(socket, state))
}

async fn terminal_socket(socket: WebSocket, state: AppState) {
    let (mut sink, mut stream) = socket.split();
    let authenticated = match stream.next().await {
        Some(Ok(Message::Binary(bytes))) => {
            bytes.starts_with(termloop_terminal::TERMINAL_FRAME_MAGIC)
                && bytes
                    .get(4..)
                    .is_some_and(|token| constant_time_equal(token, state.token.as_bytes()))
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
    let outbound = Outbound::default();
    let writer_outbound = outbound.clone();
    let writer = tokio::spawn(async move {
        loop {
            let frame = writer_outbound.lock().pop_fair();
            let Some(frame) = frame else {
                writer_outbound.notify.notified().await;
                continue;
            };
            let bytes = encode_terminal_frame(&frame);
            if sink.send(Message::Binary(bytes.into())).await.is_err() {
                break;
            }
        }
    });

    let mut attachments: HashMap<Uuid, (u64, tokio::task::JoinHandle<()>)> = HashMap::new();
    let mut input_ack_enabled = false;
    while let Some(Ok(message)) = stream.next().await {
        let Message::Binary(bytes) = message else {
            continue;
        };
        let Ok(frame) = decode_terminal_frame(&bytes) else {
            continue;
        };
        let session = frame.session_id.to_string();
        match frame.kind {
            kind if kind == FrameKind::EnableInputAck as u8
                && frame.session_id.is_nil()
                && frame.epoch == 0
                && frame.sequence == 0
                && frame.payload.is_empty() =>
            {
                input_ack_enabled = true;
            }
            kind if kind == FrameKind::Attach as u8 => {
                if let Some((_, previous)) = attachments.remove(&frame.session_id) {
                    previous.abort();
                    let _ = previous.await;
                }
                if let Some(pump) = attach(&state, &outbound, &frame, &session) {
                    attachments.insert(frame.session_id, (frame.epoch, pump));
                }
            }
            kind if kind == FrameKind::Input as u8 => {
                if !input_ack_enabled {
                    if let Err(error) =
                        state
                            .terminal
                            .input_user(&session, frame.epoch, &frame.payload)
                    {
                        outbound.reply(&frame, FrameKind::Error, error.to_string().into_bytes());
                    }
                    continue;
                }
                let pending =
                    match state
                        .terminal
                        .input_user_receipted(&session, frame.epoch, &frame.payload)
                    {
                        Ok(pending) => pending,
                        Err(error) => {
                            outbound.reply(
                                &frame,
                                FrameKind::Error,
                                error.to_string().into_bytes(),
                            );
                            continue;
                        }
                    };
                let receipt = tokio::task::spawn_blocking(move || {
                    pending.wait(TERMINAL_INPUT_RECEIPT_TIMEOUT)
                })
                .await;
                match receipt {
                    Ok(Ok(_)) => outbound.reply(&frame, FrameKind::InputAck, Vec::new()),
                    Ok(Err(error)) => {
                        outbound.reply(&frame, FrameKind::Error, error.to_string().into_bytes());
                    }
                    Err(_) => outbound.reply(
                        &frame,
                        FrameKind::Error,
                        b"terminal input receipt task failed".to_vec(),
                    ),
                }
            }
            kind if kind == FrameKind::Resize as u8 && frame.payload.len() == 4 => {
                let rows = u16::from_be_bytes([frame.payload[0], frame.payload[1]]);
                let cols = u16::from_be_bytes([frame.payload[2], frame.payload[3]]);
                let _ = state.terminal.resize(&session, rows, cols);
            }
            kind if kind == FrameKind::Detach as u8 && frame.payload.is_empty() => {
                if attachments
                    .get(&frame.session_id)
                    .is_none_or(|(epoch, _)| *epoch != frame.epoch)
                {
                    continue;
                }
                if let Some((_, pump)) = attachments.remove(&frame.session_id) {
                    pump.abort();
                    let _ = pump.await;
                }
                outbound.lock().detach(frame.session_id);
            }
            // Focus only moves resize ownership, which every connection holds.
            _ => {}
        }
    }
    for (_, (_, pump)) in attachments {
        pump.abort();
    }
    writer.abort();
}

/// Subscribes to a session, queues its Ack before any output, and starts
/// the pump that forwards output, gaps, and EOF.
fn attach(
    state: &AppState,
    outbound: &Outbound,
    frame: &TerminalFrame,
    session: &str,
) -> Option<tokio::task::JoinHandle<()>> {
    let replay = requested_replay_options(&frame.payload);
    let subscription = match replay {
        Some(request) => state.terminal.subscribe_with_replay_options(
            session,
            frame.epoch,
            request.max_bytes,
            request.max_chunk_bytes,
        ),
        None => state.terminal.subscribe(session, frame.epoch),
    };
    let mut receiver = match subscription {
        Ok(receiver) => receiver,
        Err(error) => {
            outbound.reply(frame, FrameKind::Error, error.to_string().into_bytes());
            return None;
        }
    };
    let ack = match replay {
        Some(request) => {
            let mut ack = termloop_terminal_wire::replay_ack_payload(
                receiver.replay_event_count(),
                receiver.replay_output_bytes(),
            );
            if request.mouse_modes {
                ack.extend_from_slice(&receiver.replay_mouse_modes().to_be_bytes());
            }
            ack
        }
        None => frame.payload.clone(),
    };
    outbound.reply(frame, FrameKind::ResizeOwnership, vec![1]);
    outbound.reply(frame, FrameKind::Ack, ack);
    let outbound = outbound.clone();
    let id = frame.session_id;
    let epoch = frame.epoch;
    let sequence = AtomicU64::new(1);
    Some(tokio::spawn(async move {
        loop {
            let (kind, payload) = match receiver.recv_delivery().await {
                Ok(delivery) => match delivery.event {
                    TerminalEvent::Output(bytes) if delivery.recent_replay => {
                        (FrameKind::ReplayOutput, bytes)
                    }
                    TerminalEvent::Output(bytes) => (FrameKind::Output, bytes),
                    TerminalEvent::Gap(count) => (FrameKind::Gap, count.to_be_bytes().to_vec()),
                    TerminalEvent::Eof => (FrameKind::Eof, Vec::new()),
                },
                Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                    (FrameKind::Gap, count.to_be_bytes().to_vec())
                }
                Err(_) => break,
            };
            outbound.send(TerminalFrame {
                session_id: id,
                epoch,
                sequence: sequence.fetch_add(1, Ordering::Relaxed),
                kind: kind as u8,
                payload,
            });
            if kind == FrameKind::Eof {
                break;
            }
        }
    }))
}

fn requested_replay_options(payload: &[u8]) -> Option<ReplayRequest> {
    if payload.len() != REPLAY_REQUEST_BYTES || &payload[..4] != REPLAY_REQUEST_MAGIC {
        return None;
    }
    let requested_bytes = u32::from_be_bytes(payload[4..8].try_into().ok()?) as usize;
    let chunk_options = u32::from_be_bytes(payload[8..12].try_into().ok()?);
    let requested_chunk_bytes = (chunk_options & !REPLAY_MOUSE_MODES_FLAG) as usize;
    Some(ReplayRequest {
        max_bytes: requested_bytes.clamp(
            termloop_terminal::MAX_IO_CHUNK_BYTES,
            termloop_terminal::MAX_RECENT_REPLAY_BYTES,
        ),
        max_chunk_bytes: requested_chunk_bytes.clamp(
            termloop_terminal::MAX_IO_CHUNK_BYTES,
            MAX_REPLAY_WIRE_CHUNK_BYTES,
        ),
        mouse_modes: chunk_options & REPLAY_MOUSE_MODES_FLAG != 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_request_is_clamped_and_reads_the_mouse_flag() {
        let mut payload = REPLAY_REQUEST_MAGIC.to_vec();
        payload.extend_from_slice(&u32::MAX.to_be_bytes());
        payload.extend_from_slice(&(REPLAY_MOUSE_MODES_FLAG | 1).to_be_bytes());
        let request = requested_replay_options(&payload).unwrap();
        assert_eq!(
            request.max_bytes,
            termloop_terminal::MAX_RECENT_REPLAY_BYTES
        );
        assert_eq!(
            request.max_chunk_bytes,
            termloop_terminal::MAX_IO_CHUNK_BYTES
        );
        assert!(request.mouse_modes);
        assert_eq!(requested_replay_options(b"TLRQ"), None);
    }

    #[test]
    fn a_flooding_session_reports_a_gap_without_starving_another() {
        let frame = |session: Uuid, sequence: u64| TerminalFrame {
            session_id: session,
            epoch: 1,
            sequence,
            kind: FrameKind::Output as u8,
            payload: vec![0],
        };
        let (busy, quiet) = (Uuid::from_u128(1), Uuid::from_u128(2));
        let mut buffer = OutboundBuffer::default();
        for sequence in 1..=(MAX_ATTACHMENT_FRAMES as u64 + 3) {
            buffer.enqueue(frame(busy, sequence));
        }
        buffer.enqueue(frame(quiet, 1));
        let first = buffer.pop_fair().unwrap();
        assert_eq!(first.kind, FrameKind::Gap as u8);
        assert_eq!(first.payload, 3u64.to_be_bytes());
        assert_eq!(buffer.pop_fair().unwrap().session_id, quiet);
    }
}
