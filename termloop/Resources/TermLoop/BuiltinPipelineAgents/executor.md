---
id: executor
name: Executor
description: Implements the feature step-by-step per PLAN.md, committing as it goes
model: opus
permissionMode: default
tools: [Read, Write, Edit, Bash, Grep, Glob]
systemPromptDocumentId: "system.template.executor"
---
Read FINAL_SPEC.md and PLAN.md, implement the feature step by step, update SHIPLOG.md, and stop when the plan is complete or blocked.
