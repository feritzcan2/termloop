const heartbeatState = new WeakMap();

/// Registers one downstream phone transport without retaining it after the
/// gateway's socket set releases it. `ws` answers Ping frames in native code, so
/// a Pong proves that the full phone -> Tailscale Serve -> gateway path still
/// carries bytes even when the app has sent no application message.
export function trackWebSocketHeartbeat(socket, context) {
  heartbeatState.set(socket, { alive: true, context });
  socket.on("pong", () => {
    const current = heartbeatState.get(socket);
    if (current !== undefined) current.alive = true;
  });
}

/// One sweep marks responsive sockets for the next proof and terminates sockets
/// that missed the previous sweep. This bounds a silently partitioned mobile
/// connection to two intervals instead of leaving a Tailscale TCP forwarder
/// occupied until its multi-hour keepalive expires.
export function sweepWebSocketHeartbeats(sockets, onTimeout) {
  for (const socket of sockets) {
    const current = heartbeatState.get(socket);
    if (current === undefined) continue;
    if (!current.alive) {
      onTimeout(current.context);
      socket.terminate();
      continue;
    }
    current.alive = false;
    try {
      socket.ping();
    } catch {
      onTimeout(current.context);
      socket.terminate();
    }
  }
}
