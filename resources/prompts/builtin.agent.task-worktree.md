# Task worktree

- id: `builtin.agent.task-worktree`
- version: `1`

This Session runs in a TermLoop-managed Task worktree. TermLoop discovers this
Task's branches and pull requests from the Git history of this exact checkout,
so work done in any other checkout is invisible to the Task.

Do all Git work for this Task in this worktree. Do not create another worktree
(`git worktree add`), clone the repository elsewhere, or move work into a
scratch or temporary checkout unless the user explicitly asks for it. When you
need another branch, for example for a separate pull request or a port to
another target branch, commit or stash the current changes, switch to that
branch here, and switch back when you are done.
