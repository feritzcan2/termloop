#![forbid(unsafe_code)]

use axum::extract::{
    State,
    ws::{Message, WebSocket, WebSocketUpgrade},
};
use axum::response::IntoResponse;
use axum::{Router, routing::get};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use rand::RngCore;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

const MAGIC: &[u8; 4] = b"TL01";
const HEADER_LEN: usize = 29;
const KIND_INPUT: u8 = 1;
const KIND_OUTPUT: u8 = 2;
const KIND_RESIZE: u8 = 3;
const KIND_EOF: u8 = 5;
const KIND_SPAWN: u8 = 10;
const KIND_ACK: u8 = 11;
const KIND_ERROR: u8 = 12;

#[derive(Clone)]
struct AppState {
    token: Arc<str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Discovery<'a> {
    terminal_url: String,
    token: &'a str,
    framing: &'a str,
}

struct Runtime {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    _child: Box<dyn Child + Send + Sync>,
}

#[derive(Debug, Clone)]
struct Frame {
    session: u32,
    epoch: u64,
    sequence: u64,
    kind: u8,
    payload: Vec<u8>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).await?;
    let address = listener.local_addr()?;
    let token = generate_token();
    let app = Router::new()
        .route("/terminal", get(upgrade))
        .with_state(AppState {
            token: Arc::from(token.as_str()),
        });
    let path = discovery_path();
    let discovery = Discovery {
        terminal_url: format!("ws://{address}/terminal"),
        token: &token,
        framing: "r0-v1",
    };
    termloop_platform::write_private_file(&path, &serde_json::to_vec_pretty(&discovery)?)?;
    println!("{}", path.display());
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

fn discovery_path() -> PathBuf {
    std::env::var_os("TERMLOOP_R0_DISCOVERY")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("artifacts/evidence/r0/runtime.json"))
}

fn generate_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

async fn upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.max_message_size(8 * 1024 * 1024)
        .on_upgrade(move |socket| run_socket(socket, state))
}

async fn run_socket(socket: WebSocket, state: AppState) {
    let (mut sink, mut stream) = socket.split();
    let authenticated = match stream.next().await {
        Some(Ok(Message::Binary(bytes))) => {
            bytes.starts_with(b"AUTH") && bytes.get(4..) == Some(state.token.as_bytes())
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

    let (output_tx, mut output_rx) = mpsc::unbounded_channel::<Frame>();
    let mut sessions: HashMap<u32, Runtime> = HashMap::new();

    loop {
        tokio::select! {
            incoming = stream.next() => {
                let Some(Ok(message)) = incoming else { break; };
                let Message::Binary(bytes) = message else {
                    let _ = sink.send(Message::Binary(encode(&Frame { session: 0, epoch: 0, sequence: 0, kind: KIND_ERROR, payload: b"binary-only".to_vec() }).into())).await;
                    continue;
                };
                let Ok(frame) = decode(&bytes) else { continue; };
                if let Err(error) = apply(frame.clone(), &mut sessions, output_tx.clone()) {
                    let response = Frame { session: frame.session, epoch: frame.epoch, sequence: frame.sequence, kind: KIND_ERROR, payload: error.into_bytes() };
                    let _ = sink.send(Message::Binary(encode(&response).into())).await;
                }
            }
            outgoing = output_rx.recv() => {
                let Some(frame) = outgoing else { break; };
                if sink.send(Message::Binary(encode(&frame).into())).await.is_err() { break; }
            }
        }
    }
}

fn apply(
    frame: Frame,
    sessions: &mut HashMap<u32, Runtime>,
    output_tx: mpsc::UnboundedSender<Frame>,
) -> Result<(), String> {
    match frame.kind {
        KIND_SPAWN => {
            if sessions.contains_key(&frame.session) {
                return Err("session-exists".into());
            }
            let runtime = spawn(frame.session, frame.epoch, output_tx)?;
            sessions.insert(frame.session, runtime);
            Ok(())
        }
        KIND_INPUT => {
            let runtime = sessions
                .get_mut(&frame.session)
                .ok_or("session-not-found")?;
            runtime
                .writer
                .write_all(&frame.payload)
                .map_err(|error| error.to_string())?;
            runtime.writer.flush().map_err(|error| error.to_string())
        }
        KIND_RESIZE => {
            if frame.payload.len() != 4 {
                return Err("invalid-resize".into());
            }
            let rows = u16::from_be_bytes([frame.payload[0], frame.payload[1]]);
            let cols = u16::from_be_bytes([frame.payload[2], frame.payload[3]]);
            sessions
                .get_mut(&frame.session)
                .ok_or("session-not-found")?
                .master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|error| error.to_string())?;
            output_tx
                .send(Frame {
                    session: frame.session,
                    epoch: frame.epoch,
                    sequence: frame.sequence,
                    kind: KIND_ACK,
                    payload: frame.payload,
                })
                .map_err(|error| error.to_string())
        }
        _ => Err("unsupported-frame-kind".into()),
    }
}

fn spawn(
    session: u32,
    epoch: u64,
    output_tx: mpsc::UnboundedSender<Frame>,
) -> Result<Runtime, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;
    let command = echo_command();
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    drop(pair.slave);
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| error.to_string())?;
    let sequence = Arc::new(AtomicU64::new(1));
    let reader_tx = output_tx.clone();
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 16 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    let _ = reader_tx.send(Frame {
                        session,
                        epoch,
                        sequence: sequence.fetch_add(1, Ordering::Relaxed),
                        kind: KIND_EOF,
                        payload: vec![],
                    });
                    break;
                }
                Ok(count) => {
                    let _ = reader_tx.send(Frame {
                        session,
                        epoch,
                        sequence: sequence.fetch_add(1, Ordering::Relaxed),
                        kind: KIND_OUTPUT,
                        payload: buffer[..count].to_vec(),
                    });
                }
                Err(_) => break,
            }
        }
    });
    let _ = output_tx.send(Frame {
        session,
        epoch,
        sequence: 0,
        kind: KIND_ACK,
        payload: b"spawned".to_vec(),
    });
    Ok(Runtime {
        writer,
        master: pair.master,
        _child: child,
    })
}

fn echo_command() -> CommandBuilder {
    #[cfg(windows)]
    {
        CommandBuilder::new("cmd.exe")
    }
    #[cfg(not(windows))]
    {
        let mut command = CommandBuilder::new("/bin/sh");
        command.arg("-c");
        command.arg("stty raw -echo; exec cat");
        command
    }
}

fn encode(frame: &Frame) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(HEADER_LEN + frame.payload.len());
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&frame.session.to_be_bytes());
    bytes.extend_from_slice(&frame.epoch.to_be_bytes());
    bytes.extend_from_slice(&frame.sequence.to_be_bytes());
    bytes.push(frame.kind);
    bytes.extend_from_slice(&(frame.payload.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&frame.payload);
    bytes
}

fn decode(bytes: &[u8]) -> Result<Frame, String> {
    if bytes.len() < HEADER_LEN || &bytes[..4] != MAGIC {
        return Err("invalid-header".into());
    }
    let session = u32::from_be_bytes(bytes[4..8].try_into().unwrap());
    let epoch = u64::from_be_bytes(bytes[8..16].try_into().unwrap());
    let sequence = u64::from_be_bytes(bytes[16..24].try_into().unwrap());
    let kind = bytes[24];
    let length = u32::from_be_bytes(bytes[25..29].try_into().unwrap()) as usize;
    if bytes.len() != HEADER_LEN + length {
        return Err("invalid-length".into());
    }
    Ok(Frame {
        session,
        epoch,
        sequence,
        kind,
        payload: bytes[HEADER_LEN..].to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_round_trip() {
        let frame = Frame {
            session: 7,
            epoch: 2,
            sequence: 9,
            kind: KIND_INPUT,
            payload: b"hello".to_vec(),
        };
        let decoded = decode(&encode(&frame)).unwrap();
        assert_eq!(decoded.session, 7);
        assert_eq!(decoded.epoch, 2);
        assert_eq!(decoded.sequence, 9);
        assert_eq!(decoded.payload, b"hello");
    }
}
