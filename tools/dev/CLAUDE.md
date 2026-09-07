# Development launcher agent rules

## Usage

- Start one persistent feature profile with
  `tools/dev/termloop-dev start --checkout <absolute-checkout> --tag <feature>`.
- After source changes, use the same command with `restart`; never start the
  daemon, supervisor, `pnpm exec electron`, or Electron binary separately.
- A successful macOS start means the exact profile LaunchAgent is loaded,
  daemon discovery and lease identities agree, the desktop identity is owned,
  Electron published its PID-bound ready marker after loading the real window,
  and both processes survived the stability gate. Confirm a later independent
  `status` reports `Supervisor: ready` and `Build: current`. Window activation
  is best effort because macOS Accessibility permission may be unavailable.
- `--main` is human-only. Agents must never start, restart, or stop it, even when
  the user asks for validation intended for `main`. Never substitute it for a
  missing feature tag.
- Stop only with the same checkout and tag. Never use global `pkill`, basename
  matching, repository-prefix scans, or signals based on an unverified PID.
- Multiple feature tags may intentionally run against one checkout; each has
  isolated state/runtime/desktop/logs and an exact LaunchAgent. When a checkout
  no longer exists, discover its recorded profile with `list` and unload it
  using `stop-profile --profile <exact-profile>`.
- Reclaim finished feature profiles with
  `prune [--profile <exact-profile>] [--older-than DAYS] [--keep COUNT]
  [--legacy-builds] [--apply]`. Without `--apply` it only previews. It never
  considers `main`, never removes a profile whose supervisor is running, and
  routes every removal through `stop-profile` first.

## Invariants

- On macOS the profile-scoped user LaunchAgent owns the repo supervisor. The
  invoking terminal or agent exec environment must not own the persistent
  daemon/desktop process tree.
- The supervisor accepts configuration only through exact launcher-generated
  absolute paths and bounded profile environment. It exposes no generic command
  execution surface.
- Process records require PID plus OS start identity. Stale records authorize no
  signal. Direct PID teardown exists only to migrate revision-2 legacy profiles
  with no loaded LaunchAgent.
- LaunchAgent stop preserves the daemon's bounded graceful shutdown window;
  force termination may target only descendants proven beneath the exact owned
  PID after that window.
- Profile state/runtime/desktop/log paths remain isolated and outside the repo.
  Do not delete or prune them implicitly. `prune --apply` is the only sanctioned
  removal path, and it deletes only a validated non-symlinked leaf directly under
  the profiles root that still carries launcher profile leaves.
- Tagged profiles of one checkout share `<checkout>/target/dev-profiles` as their
  Cargo target directory, because they build byte-identical binaries. It stays
  separate from the primary `target/debug` so profile builds never invalidate the
  developer's warm artifacts. Do not reintroduce a per-profile build directory;
  concurrent tag builds are expected to queue on Cargo's directory lock.
- The invoking shell's PATH and UTF-8 locale are snapshotted into the private
  plist and verified by the supervisor before children launch. Do not replace
  them with launchd's minimal defaults.
- Automatic launchd restart is deliberately disabled. A stopped/crashed
  supervisor remains visibly `exited`; `start` recovers that loaded-dead job.
  `status` exposes `Build: drifted` if on-disk launch artifacts changed.
- Persistent start is supervised on macOS (profile LaunchAgent) and Linux
  (systemd user unit); Windows and any Linux session without user systemd
  fail closed. No unsupervised `nohup` fallback is permitted.

## Verification

- Run `bash -n tools/dev/termloop-dev tools/dev/termloop-dev-supervisor`.
- Run `tools/dev/test-termloop-dev` with its selected linked profile stopped.
- On macOS, exercise a disposable tag through `start`, a later independent
  `status`, clean desktop exit/recovery, and `stop-profile`; verify readiness
  survives the start command's process exit and stop leaves both owned PIDs
  stopped. This behavior fixture is wired into root `pnpm test`.
