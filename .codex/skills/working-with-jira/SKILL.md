---
name: working-with-jira
description: Project-specific Jira workflow for TermLoop (termloop.atlassian.net, project KAN)
type: project
---

## Project context

- **Site:** termloop.atlassian.net
- **Project:** KAN ("My Team") — sole project, single developer (Ferit özcan)
- **Issue types:** Feature, Task, Subtask
- **CLI access:** `acli jira` (authenticated via OAuth)

## Ticket identification

Jira keys follow the pattern `KAN-<number>`. No historical commit references exist yet — this is a new convention being established.

Look up issues with:
```
acli jira workitem view KAN-<number>
acli jira workitem search --jql "project=KAN ORDER BY created DESC" --limit 10
```

## Branch naming

Always include the ticket key as the branch prefix:
```
KAN-42/short-description
```

## Pre-transition checks

Before moving a ticket forward, verify:
- The ticket key matches the branch you are on
- For subtasks, check the parent task status

## Transition rules

| Event | Target status | Command |
|---|---|---|
| Start working | In Progress | `acli jira workitem transition --key KAN-<n> --status "In Progress"` |
| PR opened | In Review | `acli jira workitem transition --key KAN-<n> --status "In Review"` |
| PR merged | Done | `acli jira workitem transition --key KAN-<n> --status "Done"` |

## PR ↔ ticket linking

- One PR per ticket (one KAN key per branch).
- Include the ticket key in the PR title: `KAN-42: short description`.
- No required fields before closing as Done.

## Common pitfalls

- Commits in this repo have historically been freeform (`ads`, `dsa`, etc.) — make sure new Jira-linked work uses the `KAN-42: description` format in meaningful commits.
- TermLoop worktrees are created at `.termloop-worktrees/<branch>/` — branch name (and embedded KAN key) flows through to the worktree path automatically.
- Subtask status is independent of parent; transition both when wrapping up work.
