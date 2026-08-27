# Repository integration and CI agent rules

## Ownership

- This boundary owns GitHub Actions, native verification, release gating,
  release packaging, and the repository workflow for integrating completed work
  into `main`.

## Main integration

- When the user asks to merge a branch or completed work into `main`, locate the
  designated local `main` checkout with `git worktree list`. Do not assume the
  current feature worktree owns `main`.
- Fetch the remote, merge the completed feature branch and current `origin/main`
  into local `main`, resolve conflicts there, and run proportionate verification
  from the integrated state before pushing that exact local `main` commit to
  `origin/main`.
- Never substitute a direct refspec push such as `HEAD:main` or
  `<feature>:main`. Do not report success while the designated local `main`
  remains divergent.
- If the designated checkout is on any branch and contains uncommitted tracked
  or untracked work, stage and commit all of it directly to its current branch
  with a change-describing message, without asking. Do not create an artificial
  preservation commit on `main`; never stash, discard, overwrite, or omit those
  changes. Then switch the checkout to `main` and continue.
- Complete an in-progress Git operation when its intent is clear. Stop for
  direction only when resolution would risk local work.
- After pushing, fetch if necessary and verify that local `main` and
  `origin/main` resolve to the same commit and that the local `main` checkout is
  clean.

## Native verification

- Treat GitHub Actions as native verification, not as a lint or type-check
  iteration loop.
- macOS, Linux, and Windows are release gates. Local builds and cross-compiles
  are preflight evidence only; PTY, path, process, packaging, and other native
  changes need runtime evidence on every affected host.
- Preserve `.github/workflows/ci.yml`'s cost gate: self-hosted macOS preflight
  runs static validation plus Linux and Windows cross-target clippy. Hosted
  native jobs depend on preflight and must not duplicate its static checks.
- Keep the native matrix `fail-fast: false` so one failure does not discard
  already-paid sibling evidence.
- Before dispatching manual release CI after a code change, exhaust the required
  local checks and installed affected Rust cross-target clippy checks. A code
  fix requires a new immutable commit and a new exact-SHA run; never rewrite
  `main` to reuse old CI evidence.
- Use `.github/workflows/native-diagnostic.yml` for iteration on native-only
  failures. Select only the affected OS and use the default `tests` scope unless
  diagnosing acceptance, smoke, packaging, or bundle assembly.
- A partial diagnostic success is not release evidence. After affected native
  diagnostics pass, dispatch one full `ci.yml` gate for the exact candidate SHA.
- Fix and exhaust local verification before starting another exact-SHA run.
- Use `gh run rerun --failed` only for a transient failure when the candidate SHA
  and code are unchanged.
- If an Actions budget prevents a hosted job from starting, do not retry or
  dispatch another hosted workflow until the budget resets or is increased. A
  budget-rejected job contributes no native evidence.
- The full suite is CI's responsibility before merge or release. State when it
  was not run locally and list the narrower checks that were run.

## Release

- Build and publish from one immutable commit or tag only after the exact
  candidate has a successful full native CI run.
- macOS release apps are universal: build both Rust targets, combine native
  binaries with `lipo`, build universal Ghostty, package with
  `electron-builder --universal`, and verify the final bundle with `codesign`.
- Keep CI evidence and unsigned intermediates short-lived. Durable downloadable
  binaries belong to the GitHub Release rather than Actions artifact storage.
