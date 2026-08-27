use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures_util::SinkExt;
use termloop_contract::current::{
    ACCESS_PROTOCOL_IDENTITY, AccessChannel, AccessForwardOpen, AccessForwardOpened,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::{Duration, timeout};

use super::AppState;
use super::access_plane::{RemoteScope, send_protocol_error};

const FORWARD_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const FORWARD_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const FORWARD_BUFFER_BYTES: usize = 64 * 1024;

pub(in crate::app) async fn access_forward_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.max_message_size(FORWARD_BUFFER_BYTES * 2)
        .on_upgrade(move |socket| access_forward_socket(socket, state))
}

async fn access_forward_socket(mut socket: WebSocket, state: AppState) {
    let authenticated = match state
        .access_plane
        .authenticate_socket(&mut socket, AccessChannel::Forward)
        .await
    {
        Ok(authenticated) => authenticated,
        Err(message) => {
            let _ = send_protocol_error(&mut socket, "unauthenticated", &message).await;
            return;
        }
    };
    if authenticated.scope != RemoteScope::Full {
        let _ = send_protocol_error(
            &mut socket,
            "forwardDenied",
            "device scope does not allow TCP forwarding",
        )
        .await;
        return;
    }
    let request = match timeout(FORWARD_HANDSHAKE_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<AccessForwardOpen>(&text).ok(),
        _ => None,
    };
    let Some(request) = request else {
        let _ =
            send_protocol_error(&mut socket, "invalidMessage", "forward request is invalid").await;
        return;
    };
    if request.kind != "forwardOpen" || request.protocol_version != ACCESS_PROTOCOL_IDENTITY {
        let _ = send_protocol_error(
            &mut socket,
            "unsupportedVersion",
            "access protocol version is unsupported",
        )
        .await;
        return;
    }
    let allowed = state.core.lock().await.forwardable_run_ports();
    if !allowed.contains(&request.port) {
        let _ = send_protocol_error(
            &mut socket,
            "forwardDenied",
            "port is not advertised by a running TermLoop run",
        )
        .await;
        return;
    }
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), request.port);
    let stream = match timeout(FORWARD_CONNECT_TIMEOUT, TcpStream::connect(address)).await {
        Ok(Ok(stream)) => stream,
        _ => {
            let _ = send_protocol_error(
                &mut socket,
                "forwardDenied",
                "advertised run port is not accepting connections",
            )
            .await;
            return;
        }
    };
    let response = AccessForwardOpened {
        kind: "forwardOpened".to_owned(),
        protocol_version: ACCESS_PROTOCOL_IDENTITY.to_owned(),
        port: request.port,
    };
    let Ok(text) = serde_json::to_string(&response) else {
        return;
    };
    if socket.send(Message::Text(text.into())).await.is_err() {
        return;
    }
    bridge_forward(socket, stream, authenticated.revocation).await;
}

async fn bridge_forward(
    mut socket: WebSocket,
    stream: TcpStream,
    mut revocation: super::access_plane::RemoteRevocation,
) {
    let (mut tcp_read, mut tcp_write) = stream.into_split();
    let mut buffer = vec![0_u8; FORWARD_BUFFER_BYTES];
    loop {
        tokio::select! {
            read = tcp_read.read(&mut buffer) => {
                let Ok(read) = read else { break; };
                if read == 0 { break; }
                let sent = tokio::select! {
                    result = socket.send(Message::Binary(buffer[..read].to_vec().into())) => result.is_ok(),
                    () = revocation.wait() => false,
                };
                if !sent {
                    break;
                }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Binary(bytes))) if bytes.len() <= FORWARD_BUFFER_BYTES => {
                        let written = tokio::select! {
                            result = tcp_write.write_all(&bytes) => result.is_ok(),
                            () = revocation.wait() => false,
                        };
                        if !written { break; }
                    }
                    Some(Ok(Message::Ping(bytes))) => {
                        let sent = tokio::select! {
                            result = socket.send(Message::Pong(bytes)) => result.is_ok(),
                            () = revocation.wait() => false,
                        };
                        if !sent { break; }
                    }
                    Some(Ok(Message::Pong(_))) => continue,
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => break,
                }
            }
            () = revocation.wait() => break,
        }
    }
    let _ = tcp_write.shutdown().await;
    let _ = socket.close().await;
}
