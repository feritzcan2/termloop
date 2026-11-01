# Quick Action free prompt

- id: `builtin.quick-action.free-prompt`
- version: `3`
- binding: `prompt`
- binding: `imageAttachments`
- delivery: `terminalInput`

Without image attachments, the authored `prompt` binding is delivered unchanged
as initial PTY input after the provider starts. It never enters process
arguments. A launch carries at most eight image attachments.

For Codex, each image attachment is delivered through the provider's native
`--image <path>` launch argument and the prompt remains unchanged.

For Claude on a host PTY with bracketed-paste framing, each image attachment is
pasted, in order, as its own JSON-quoted absolute path reference ahead of the
unchanged prompt, inside the same initial paste. Claude turns every reference
into a native image attachment before the single submit. No additional
directory is granted.

On a host PTY without bracketed-paste framing, TermLoop instead grants access
only to each attachment's unique containing directory and appends the following
visible block to the prompt:

```text

TermLoop Quick Action image attachments: inspect `image.png` in each additional directory supplied for this launch.
```

The attachment order, media type, byte length, dimensions, digest, provider
delivery, and any provider-visible path are projections of the same resolved
launch manifest.
