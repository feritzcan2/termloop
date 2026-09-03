const heartbeatState = new WeakMap();

/// Registers one downstream phone transport without retaining it after the
/// gateway's socket set releases it. React Native does not expose protocol Ping
/// frames to JavaScript, so the unified mobile transport supplies an application
/// probe while legacy `ws` clients can keep using protocol Ping/Pong.
export function trackWebSocketHeartbeat(socket, context, options = {}) {
  heartbeatState.set(socket, {
    alive: true,
    context,
    probe: options.probe,
    enforceTimeout: options.enforceTimeout ?? true,
  });
  const acknowledge = () => {
    const current = heartbeatState.get(socket);
    if (current !== undefined) current.alive = true;
  };
  socket.on("pong", acknowledge);
  /// Any inbound byte is also proof of the complete return path. This avoids
  /// killing a busy phone merely because an intermediary did not surface Pong.
  socket.on("message", acknowledge);
}

/// Enables a stronger strategy after application authentication negotiates it.
/// Older mobile v2 clients remain usable: their React Native runtime may not
/// expose protocol Pong, so absence of that frame alone is not a disconnect.
export function configureWebSocketHeartbeat(socket, options) {
  const current = heartbeatState.get(socket);
  if (current === undefined) return;
  current.probe = options.probe;
  current.enforceTimeout = options.enforceTimeout ?? current.enforceTimeout;
  current.alive = true;
}

/// One sweep marks responsive sockets for the next proof and terminates sockets
/// that missed the previous sweep. This bounds a silently partitioned mobile
/// connection to two intervals instead of leaving a Tailscale TCP forwarder
/// occupied until its multi-hour keepalive expires.
export function sweepWebSocketHeartbeats(sockets, onTimeout) {
  for (const socket of sockets) {
    const current = heartbeatState.get(socket);
    if (current === undefined) continue;
    if (!current.alive && current.enforceTimeout) {
      onTimeout(current.context);
      socket.terminate();
      continue;
    }
    current.alive = false;
    try {
      if (current.probe === undefined) socket.ping();
      else current.probe();
    } catch {
      onTimeout(current.context);
      socket.terminate();
    }
  }
}
