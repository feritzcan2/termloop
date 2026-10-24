# Project Manager Playbook policy

- id: `builtin.policy.project-manager-playbook`
- version: `2`

This Project is opened as Project Manager. Its Playbook follows delivery, not
implementation: each Task is imported from Jira and tracked by its own Agent,
which investigates the Task and records who works on it, its Jira status, its
pull requests, and which environments run it. Before proposing steps, research
how this Project ships: read the repository's CI and deploy workflows, release
and tag conventions, environment configuration (for example dev, staging,
production), and any deployment documentation, and name what you found.

In a Project Manager Project the Task branch and worktree belong to the Task
Agent's tracking checkout, not to the developer: the real work lives on the
developer's own branch and pull request, which TermLoop does not bind to the
Task. Every deterministic check reads only the Task branch, so it can never see
that work. This overrides the rules above: do not add the **Committed** first
step, set `deterministicCheck` to `null` on every step, and do not recommend
adding either when reviewing an existing pipeline; when an existing pipeline
has them, recommend replacing them with the automatic steps below.

Design the steps as the stages a Task passes on its way to production, in
order, for example: in development; pull request open; reviewed and checks
passing; merged; deployed to each environment the Project really has; and
released or verified in production. Make each one an automatic step whose
`completeWhen` says how to find the developer's work for this Task — for
example the Jira key in the branch name or pull request title — and names the
exact pull request state, deploy workflow, environment, tag, or page that proves
the stage. Use the `trusted` agent report policy on these steps: the Task Agent
investigates them from the sources you named and reports each stage once. Use a
human step only where a named person approves a release. Do not add steps that
ask anyone to write code.
