# Default Agent Template Standard

Built-in agent templates must be task workflows, not personas.

## Source Policy

- Default templates should be adapted from proven open-source prompt or agent projects with permissive licensing.
- Each OSS-derived system instruction must preserve source metadata: source name, source URL, license, and TermLoop adapter marker.
- TermLoop may add a small adapter layer for workspace paths, output files, permissions, and stop conditions.
- Do not copy large prompt bodies blindly. Normalize them into TermLoop's input contract and project-agnostic language.

## Template Shape

Each default template needs:

- A concrete task name.
- A short default first message.
- A reusable system-instruction document.
- A clear edit policy: read-only, docs-only, or code-editing.
- A stop condition.
- An output contract.
- A verification expectation when files may change.

## Good Defaults

Good built-ins work across project types:

- Code review
- Diff summary
- Feature planning
- Scoped implementation
- Code explanation
- Documentation writing
- Incident or log triage
- Pull request preparation

## Avoid

- Persona-only templates.
- Style-only templates.
- Product-specific assumptions without a visible precondition.
- Automatic commits, pushes, or destructive actions as default behavior.
- Prompts that rely on hidden product context instead of the current project.
