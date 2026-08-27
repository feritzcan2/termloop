# Git I/O agent rules

## Ownership

- Own Git discovery and typed repository, ref, worktree, mutation, status,
  cleanup-input, remote, and snapshot primitives.
- Return explicit facts and typed failures. Never decide Task binding,
  provisioning, cleanup safety, launch eligibility, or provider meaning.
- Keep no durable domain state, global runner, lazy singleton, Git mutex, or
  cross-repository serialization.

## Dependencies

- Allowed internal dependency: `platform` only. Do not import domain, core,
  store, providers, terminal, server, or clients.
- OS process/path/clock primitives and raw-byte `OsString`/`Path` conversion
  belong to `platform`; `gitio` owns Git-specific normalization.

## Invariants

- Execute Git only through the injected/discovered `GitRunner` and platform's
  argument-vector runner. Never compose a shell command or call Git elsewhere.
- Keep the API synchronous; async callers choose their own `spawn_blocking`
  boundary. Never hold a core/store lock around Git work.
- Every repository-scoped call has an explicit cwd, bounded stdout/stderr, and
  bounded timeout. Executable/version discovery is the sole cwd-independent
  exception. Preserve exit code, signal, timeout, and truncation as distinct facts.
- Read-only commands set Git-specific noninteractive policy, including
  `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `core.fsmonitor=false`, and
  deterministic locale. Clear ambient repository/index and `GIT_TRACE*`
  overrides. Platform remains policy-neutral.
- Never place secrets in argv, durable state, logs, evidence, Display, or Debug.
  Public errors contain stable allowlisted classification only, never raw Git
  stderr, URLs, environment values, or user-supplied path/ref excerpts.
- Discover the resolved executable and version explicitly. Gate every command
  on its real minimum capability; fake-Git boundary fixtures cover unavailable,
  xcrun-stub, old-version, timeout, signal, and output-limit cases.

## Repository and path facts

- Preserve requested path separately from canonical resolved paths. Repository
  identity uses canonical `common_dir`; non-bare `worktree_root` is optional.
- Represent bare/non-bare, main/linked worktree, `.git` file/directory, and
  attached, detached, and unborn HEAD honestly. Never invent a repository root.
- Preserve Git path/ref bytes. Use NUL-delimited plumbing when paths occur; do
  not parse quoted paths or perform lossy UTF-8 conversion.
- Worktree PR branch evidence reads only the exact worktree's current attached
  branch and bounded HEAD checkout reflog. Never substitute repository-wide
  branches, another worktree's reflog, commit text, or provider meaning.
- Validate exact ref names before use. Never accept revision expressions such as
  `~`, `^`, `..`, or `@{}` as refs; prefer exact-ref plumbing.
- Pre-image reads resolve an exact blob OID first (`ls-files --stage` for the
  index, `ls-tree` for HEAD) and then `cat-file` that OID. Never compose a
  `rev:path` string, so a path is never parsed as revision syntax. Only regular
  file modes are content; symlink, gitlink, and tree entries are absent. Size is
  checked before bytes are read.
- Parsers are command-local until multiple real consumers justify extraction.
  Contradictory or missing required fields fail closed. Unknown fields may be
  ignored only when the Git porcelain contract explicitly promises extension.
- Repository error classification distinguishes not-a-repository, missing
  registration, permission/safe-directory rejection, corrupt/unsupported
  metadata, command failure, parse failure, and unsupported Git.

## Observation and mutation

- Observation must not write the index, create `index.lock`, refresh worktree
  metadata, run hooks, prompt, fetch, or contact a provider/network implicitly.
- Facts expose unknown/truncated/unavailable states; never collapse uncertainty
  into `false`, `clean`, `safe`, or `can_cleanup`.
- Status facts keep tracked, staged, untracked, ignored, submodule, worktree-lock,
  index-lock, and upstream states separate. Core alone maps them to policy.
- Gitio's observation deadline aggregates its Git subprocesses. Filesystem and
  scheduler-level whole-job cancellation belong to platform/server; do not claim
  this local deadline alone bounds the complete scheduled job.
- Cleanup observation and explicit mutation use separate bounded deadlines so a
  large acknowledged checkout removal is not constrained by the interactive
  observation budget.
- Ref creation and worktree addition remain separate crash boundaries. Created
  refs carry a bounded operation reflog marker with reflog creation forced;
  recovery verifies exact ref/OID/marker ownership before mutation.
- Delete/remove primitives are exact and non-force unless an approved packet
  explicitly says otherwise. Never recursively delete, adopt, prune, repair,
  overwrite, or choose a branch/path on the caller's behalf.
- Safety Snapshot alternate-index/object/ref work requires its own approved
  packet and must never mutate the user's index or publish hidden project refs.

## Tests and evidence

- Use hermetic repositories: no system/global user config, explicit default
  branch, fixed identity/time, disabled hooks, and isolated HOME-like paths.
- For every read-only observation, assert the correct main/linked index bytes are
  unchanged and no `index.lock` remains.
- Cover real and fake Git: bare, unborn, detached, linked, missing/broken
  registration, malformed porcelain, exact-ref regressions, spaces/newlines/
  quotes/Unicode, and Unix non-UTF paths where supported.
- Add concurrency tests proving no global serialization and mutation tests for
  every reflog/add/rollback/recovery boundary changed.

## Verification

```text
cargo test -p termloop-gitio
pnpm ci:git-owner
```

`termloop-git-fixtures` remains an approval-gated external charter check until
that crate exists; do not create it as incidental scaffold.
