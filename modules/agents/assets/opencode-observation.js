// Loaded as a TUI plugin so the selected route, rather than a background
// session event, determines TermLoop's one current conversation pointer.
const hookExecutable = __TERMLOOP_HOOK_EXECUTABLE__;
const sessionIDPattern = /^ses_[a-zA-Z0-9_-]{1,252}$/;
const maxQueuedObservations = 128;

export const tui = async (api) => {
  let activeSessionID;
  let activation;
  let disposed = false;
  let delivering = false;
  const queued = [];
  const requests = new Set();

  const selectedID = () => {
    const current = api.route.current;
    const id = current.name === "session" ? current.params?.sessionID : undefined;
    return typeof id === "string" && sessionIDPattern.test(id) ? id : undefined;
  };

  const deliver = async () => {
    if (delivering) return;
    delivering = true;
    try {
      while (queued.length) {
        const observation = queued.shift();
        try {
          const child = Bun.spawn([hookExecutable, "hook"], {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          });
          child.stdin.write(JSON.stringify(observation));
          child.stdin.end();
          await child.exited;
        } catch {
          // Observation is best effort; OpenCode's own turn must continue.
        }
      }
    } finally {
      delivering = false;
    }
  };

  const emit = (hookEvent, sessionID) => {
    if (disposed) return;
    if (queued.length >= maxQueuedObservations) queued.shift();
    queued.push({ hook_event_name: hookEvent, session_id: sessionID });
    void deliver();
  };

  const activate = async (id) => {
    if (!id || selectedID() !== id) return false;
    if (activeSessionID === id) return true;
    if (activation?.id === id) return activation.promise;

    const promise = (async () => {
      try {
        // The route alone can briefly name a deleted or invalid session.
        // The provider's exact-session read makes startup readiness truthful.
        const result = await api.client.session.get({ sessionID: id });
        if (disposed || selectedID() !== id || result.error || result.data?.id !== id || result.data.parentID) {
          return false;
        }
        activeSessionID = id;
        requests.clear();
        emit("OpenCodeSessionStart", id);
        const pending = [
          ...(api.state.session.permission(id) ?? []),
          ...(api.state.session.question(id) ?? []),
        ];
        for (const item of pending) {
          if (typeof item.id === "string") requests.add(item.id);
        }
        if (requests.size) emit("OpenCodePermission", id);
        else if (api.state.session.status(id)?.type === "busy") emit("OpenCodeWorking", id);
        return true;
      } catch {
        return false;
      }
    })();
    activation = { id, promise };
    void promise.then(() => {
      if (activation?.promise === promise) activation = undefined;
    });
    return promise;
  };

  const foreground = async (event) => {
    const id = event?.properties?.sessionID ?? event?.properties?.info?.id;
    if (typeof id !== "string" || id !== selectedID()) return;
    if (!(await activate(id)) || id !== selectedID()) return;
    return id;
  };

  const status = (id, kind) => {
    if (requests.size) return;
    if (kind === "busy") emit("OpenCodeWorking", id);
    if (kind === "idle") emit("OpenCodeIdle", id);
  };

  const on = (type, handler) => api.event.on(type, (event) => {
    void foreground(event).then((id) => {
      if (id) handler(id, event.properties);
    });
  });
  on("session.status", (id, properties) => status(id, properties.status?.type));
  on("session.idle", (id) => status(id, "idle"));
  on("session.error", (id) => emit("OpenCodeError", id));
  on("session.deleted", (id) => emit("OpenCodeSessionEnd", id));
  for (const kind of ["permission", "question"]) {
    on(`${kind}.asked`, (id, properties) => {
      if (typeof properties.id === "string") requests.add(properties.id);
      emit("OpenCodePermission", id);
    });
    for (const outcome of ["replied", "rejected"]) {
      on(`${kind}.${outcome}`, (id, properties) => {
        if (typeof properties.requestID !== "string" || !requests.delete(properties.requestID)) return;
        if (!requests.size) status(id, api.state.session.status(id)?.type ?? "busy");
      });
    }
  }

  // v1.18.33 does not publish an event for its own in-TUI route navigation.
  // The route getter is authoritative for picker, new-session and fork changes.
  const poll = setInterval(() => { void activate(selectedID()); }, 100);
  void activate(selectedID());
  api.lifecycle.onDispose(() => {
    disposed = true;
    clearInterval(poll);
  });
};

export default { id: "termloop-observation", tui };
