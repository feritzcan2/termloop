# Providers agent rules

## Ownership

- Own Git-host pull-request discovery and optional issue-provider adapters.
- Normalize external responses into provider DTOs and disposable cache entries.

## Dependencies

- Allowed internal dependency: `platform` only.
- No domain/core/store/gitio/terminal/client dependency.

## Invariants

- All provider-authored model instructions are written in English; input text
  remains user-owned and may use any language.
- Providers hold no authoritative Task state and do not add provider fields to
  Task records. Durable `IssueLink` state is written by `core` through `store`.
- Jira normalization accepts only an exact secret-free HTTPS browse URL; fuzzy
  issue titles or keys do not identify a durable link.
- Offline, unauthorized, rate-limited, and unsupported are typed degraded states,
  never silently converted to "no PR".
- Multiple matching PRs remain a list. Do not choose one without explicit policy.
- Provider credentials never cross into clients, evidence, or durable caches.

## Verification

- Run `cargo test -p termloop-providers`.
- Use recorded/fake adapter fixtures for offline, auth, multiple-match, and
  host-specific remote parsing cases.
