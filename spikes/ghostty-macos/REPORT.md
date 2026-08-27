# Spike: native Ghostty surfaces in Electron with external-fd IO (macOS)

## Risk question

Can libghostty render terminal surfaces as native NSViews inside the
TermLoop Next Electron window while the desktop stays a pure byte
renderer — no Ghostty-spawned process, no Ghostty-owned pty, bytes fed
in/out over an embedder-supplied fd — with resize, occlusion, and clean
teardown working?

## Answer

Yes. All measured automated exit criteria pass (`evidence.json`, 10
PASS and 1 explicitly neutral/unmeasured check). The external termio
backend uses a pinned patch series on Ghostty v1.3.1
(vendored at `vendor/ghostty`, branch `termloop-external-io`).

## Environment

- macOS 26.5.2 (Darwin 25.5.0), arm64 (Apple Silicon), shown window (not headless)
- Electron 43.3.0, Node 20.x (Electron runtime), node-addon-api 8.x
- Zig 0.15.2 (exactly what Ghostty v1.3.1 pins), Xcode 26.6 / SDK 26.5
- Ghostty v1.3.1 (332b2ae) + branch `termloop-external-io`:
  - `fab4753` termio: add external backend for embedder-supplied IO fd
  - `80e7eef` build: install libghostty.dylib on macOS
  - `bb85153` termio: harden external fd lifecycle
  - `d68e877` termio: notify embedders when external IO closes
  - `9c518a5` termio: scope external initialization ownership
  - `36e8e16` termio: report external output consumption
- Addon: `src/ghostty_host.mm` (N-API, Objective-C++), links
  `vendor/ghostty/zig-out/lib/libghostty.dylib`

## Method

`pnpm evidence` launches an Electron BrowserWindow, attaches two
`TLGhosttyView` NSView children to the content view, creates one
Ghostty surface per view with `external_io_fd` = one end of a
socketpair, and wraps the host end in a `net.Socket` echo pump. Checks
run against `ghostty_surface_size`/`ghostty_surface_read_text`
diagnostics and the raw fd byte streams.

## Results (evidence.json)

| Check | Result | Measurement |
|---|---|---|
| surfacesCreated | PASS | 2 surfaces, 40 rows × 71 cols, 16×34 px cells @2x |
| outputPath | PASS | marker written to host fd appears in VT screen text |
| inputPath | PASS | AppKit marked-text + commit path sends multilingual UTF-8 verbatim to the host fd |
| echoRoundTrip | PASS | echoed input renders back on screen |
| kittyKeyboardInput | PASS | child-NSView NSEvent with empty `characters` still emits Kitty report-all bytes through explicit AppKit translation |
| resizePropagation | PASS | frame 578→300 DIP wide: grid 40×71 → 12×37 |
| consumedCredit | PASS | exact marker byte count reported only after `Termio.processOutput` returns |
| noChildProcess | PASS | zero new Electron children after 2 surfaces + IO |
| overlayHideShow | PASS | native view hidden under DOM overlay, reshown, content retained |
| visualCapture | SKIPPED | `desktopCapturer`/`screencapture` lack screen-recording permission; verify pixels via `pnpm start` |
| teardown | PASS | `ghostty_surface_free` × 2, surfaceCount 0, clean exit |

## Reproduce

```
cd vendor/ghostty && zig build -Demit-xcframework -Demit-macos-app=false -Dxcframework-target=native -Doptimize=ReleaseFast
cd spikes/ghostty-macos && pnpm install && pnpm build && pnpm evidence   # or pnpm start (interactive)
```

## Known limitations and proxy caveats

- **Rendered pixels were not machine-verified** (permission-gated); VT
  state was verified via `ghostty_surface_read_text`. Interactive run
  shows both surfaces rendering with JetBrains Mono.
- Keyboard input uses AppKit `NSTextInputClient`, including marked-text
  preedit, committed-text accumulation, and left/right modifier events.
  Full parity with every shortcut and input-method edge case in Ghostty's
  `SurfaceView_AppKit` remains a production validation item.
- Xcode 26 `libtool` silently drops non-8-byte-aligned archive members
  from Zig-produced archives, so the stock `GhosttyKit.xcframework`
  static path is unusable with this toolchain; the dylib install patch
  is the workaround (also why the addon links a dylib, not the fat .a).
- `-Wl,-no_fixup_chains` and no C++ globals with dynamic constructors
  are required for the addon bundle to link under Xcode 26.
- Output credit is acknowledged from Ghostty's reader thread only after
  the exact byte count returns from `Termio.processOutput`; socketpair
  buffering no longer acts as the consumed cue.
- x86_64 (Intel) build and packaged/signed distribution untested.
- Surface count 2 only; warm-pool-scale (24) GPU/memory unmeasured.
