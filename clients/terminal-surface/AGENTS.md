# Terminal surface

- Desktop owns this renderer-only package; desktop and Agent Apps consume it.
- Own the terminal surface interface, xterm adapter, fonts, output batching,
  and byte continuity. No transport, provider, application model, React,
  filesystem, Electron IPC, tokens, or session launch policy belongs here.
- Keep the xterm adapter under src/renderer/terminal/xterm so existing boundary
  checks apply. Do not import another client's source.
- Changes must pass this package check and desktop terminal tests. Mechanical
  extraction must pass the full desktop check/test before adding new behavior.
