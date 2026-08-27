# Quick Action free prompt

- id: `builtin.quick-action.free-prompt`
- version: `2`
- binding: `prompt`
- binding: `imageAttachments`
- delivery: `terminalInput`

Without image attachments, the authored `prompt` binding is delivered unchanged
as initial PTY input after the provider starts. It never enters process
arguments.

For Codex, each image attachment is delivered through the provider's native
`--image <path>` launch argument and the prompt remains unchanged. For Claude,
TermLoop grants access only to the attachment's unique containing directory and
appends the following visible block to the prompt:

```text

TermLoop Quick Action image attachment: inspect `image.png` in the additional directory supplied for this launch.
```

The attachment order, media type, byte length, dimensions, digest, provider
delivery, and any provider-visible path are projections of the same resolved
launch manifest.
