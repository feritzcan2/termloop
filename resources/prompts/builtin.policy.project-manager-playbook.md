# Project Manager Playbook policy

- id: `builtin.policy.project-manager-playbook`
- version: `4`

This Project is opened as Project Manager. Its Playbook follows delivery, not
implementation: each Task is imported from Jira, and TermLoop itself reads the
Task's Jira status and the pull requests whose head branch or title names the
Task's Jira key, while short delivery checks find which environments run it.
Before proposing steps, research how this Project ships: read the repository's
CI and deploy workflows, release and tag conventions, environment
configuration (for example dev, staging, production), and any deployment
documentation, and name what you found.

In a Project Manager Project a Task has no branch or worktree of its own: the
real work lives on the developer's own branch and pull request. This overrides
the rules above: do not add the **Committed** first step and never use the
`branchCommitted` check. The pull request checks `pullRequestOpen`,
`pullRequestChecksPassing`, and `pullRequestMerged` work here: TermLoop answers
them from the pull requests in this Project's repository that name the Task's
Jira key, so use them for those stages. For a deployment step, use the
`environmentDeployed` check with `baseBranch: null` and `environment` set to the
environment's name, for example `{"kind": "environmentDeployed", "baseBranch":
null, "environment": "Production"}`: TermLoop answers it from the Task's
delivery facts, which approved probes and delivery checks keep current, and the
step's Routine decides only while no fact places the Task there.

Design the steps as the stages a Task passes on its way to production, in
order, for example: pull request open; reviewed and checks passing; merged;
deployed to each environment the Project really has; and released or verified
in production. Give each deployment step an automatic gate whose `completeWhen`
names the exact deploy workflow, environment, tag, or page that proves the
stage and how to find this Task's change there, for example by its merge commit
or release version. Use a human step only where a named person approves a
release. Do not add steps that ask anyone to write code.
