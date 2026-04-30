# TermLoop Workspace

This repository contains the TermLoop macOS app, a companion Expo/React Native mobile terminal app, landing pages, and vendored upstream dependencies used to build the product.

## Layout

- `termloop/` - TermLoop macOS application and CLI, built on the cmux codebase.
- `terminal-app/` - Expo/React Native mobile SSH and TermLoop client.
- `landing/` - Static landing page assets.
- `docs/` and `System/` - Public architecture and product documentation.
- `scripts/` - Repository maintenance and release helper scripts.

Vendored dependencies are tracked as normal directories, not submodules. See `upstreams.lock` and `docs/UPSTREAMS.md` for provenance.

## Development

Read `AGENTS.md` before making substantial changes. It documents the repository layout, upstream sync model, and TermLoop-specific implementation contracts.

## License

TermLoop is available under GPL-3.0-or-later for open source use, with commercial licensing available for TermLoop additions. See `LICENSE` and `NOTICE`.
