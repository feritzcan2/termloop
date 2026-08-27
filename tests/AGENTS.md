# Test agent rules

## Ownership

- This boundary owns end-to-end acceptance tests, headless protocol fixtures,
  architecture-violation fixtures, and generated runtime evidence.

## Invariants

- Headless terminal fixtures emulate terminal protocols with bounded waits and
  answer `ESC[6n` with `ESC[1;1R`.
- Route generated paste bytes through the platform encoder. Windows ConPTY uses
  unframed content with settlement-aware Enter; Unix PTYs use
  `ESC[200~...ESC[201~` bracketed-paste framing. Never restore a fixed
  paste-to-Enter delay.
- Record skipped and unmeasured cases. Never infer cross-platform, latency,
  security, or recovery behavior from a type-check or hardcoded label.

## Verification

- Run only the directly affected acceptance or fixture command while iterating.
- `pnpm test` is the full repository suite and remains CI's responsibility
  before merge or release unless the root rules require a local broad run.
