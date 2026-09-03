# Contract agent rules

## Ownership

- Own the single current control schema, role-profiled MCP-only schemas, binary
  data-plane framing, capability and error vocabulary, code generators,
  generated client types, the Ask-To source Session projection,
  and contract tests.
- The Project checkout summary and bounded change-content methods are strict
  full-control-only generated reads; do not add them to read-only or Companion
  capability scopes implicitly.
- Keep product policy and domain aggregates out of transport DTOs.
- Files under `generated/*/src/` are generated output. Edit the schema or
  generator, then regenerate; never patch generated source directly.

## Dependencies

- Internal dependencies: none.
- Contract changes must not import `domain`, runtime modules, apps, or clients.
- Wire strategy, identity, framing, contract selection, fallback decoding,
  capability/authority, or other security-boundary changes must be explicit in
  the user request. No proposal artifact is required.
- Additive methods, DTO/projection fields, typed errors, enum values, validation
  constraints, and fixes remain schema-first and must update generated peers and
  behavior tests in the same bounded change.

## Invariants

- All schema-authored MCP descriptions and other model-facing copy are written
  in English, including illustrative user-intent examples.
- PTY output/input is binary framed data, never JSON or base64.
- Steward presence carries only nullable byte-activity time and active command
  label fields. Companion semantics use a closed kind enum and bounded refs,
  never natural-language inference.
- Control methods and MCP-only tools, parameters, results, errors, capability
  scopes, advertised input schemas, and contract identity have one schema-first
  source of truth. MCP-only tools never enter the control method enum.
- MCP settings DTOs expose a closed tool identity and description-only mutation;
  they never accept arbitrary definitions, roles, schemas, annotations, or dispatch.
- Unknown or unauthorized methods fail with typed protocol errors.
- Generated SDK drift is a build failure. Hand-authored conformance tests may
  live beside generated packages but must exercise the generated public API.
- Provider conversation identity is never a public result; the sole wire input
  exception is the bounded hook-only Claude identity field.
- Private Ask-To continuation IDs never enter the Session DTO; clients receive
  only the existing nullable source ID needed for presentation.
- Task `jira_url` is a nullable sidecar projection. The Steward setter accepts
  only the exact schema-bounded Jira browse URL and never becomes a control
  method or a Worker/helper tool.
- Task archive contracts keep `status` at `open | closed`, use required nullable
  `archived_at_epoch_ms`, require explicit list scope, and expose no Task parent
  on Session DTOs.
- Steward self-prompt editing uses generated MCP-only read and update tools with
  no Project or Session selector. Update requires the exact user-message ID,
  the exact complete editable value previously read, and the bounded complete
  modified value; the built-in runtime layer is launch composition, not caller
  input. Both tools are absent from Interactive, Worker, and helper roles.

## Verification

- Run `pnpm codegen` after an authorized schema/generator change.
- Run `pnpm contract:drift`.
- Run `cargo test -p termloop-contract`.
- Run `pnpm --filter @termloop/contract test`.
