# Vendored Upstreams

This repo tracks upstream source code as normal directories, not git submodules.

## Sources

| Path | Source repo | Tracking branch | Pinned commit |
|---|---|---|---|
| `termloop/` | `https://github.com/feritzcan2/cmux-fork.git` | `master` | `b80c94300fd4f1e661c96fb1b9c0c66ee3d9630a` |
| `termloop/ghostty/` | `https://github.com/feritzcan2/ghostty.git` | `main` | `08187ef82fa7f5b877f0468257eeabdac8aec74d` |
| `termloop/homebrew-cmux/` | `https://github.com/manaflow-ai/homebrew-cmux.git` | `main` | `a5f372ecfa5ee3903af6e1faba0eda096b4f5746` |
| `termloop/vendor/bonsplit/` | `https://github.com/feritzcan2/bonsplit.git` | `main` | `ce2fc16e0ca6b0c4b977456b453b11a3e99efdc0` |

`upstreams.lock` is the machine-readable source of truth. Keep this document aligned when changing upstream sources or paths.

## Refresh Workflow

1. Run `./scripts/sync-upstreams.sh` from the repo root.
2. Review the resulting diff carefully, especially `termloop/` files that are covered by TermLoop K/Y discipline.
3. Run the relevant build/test commands.
4. Commit the vendored update and the `upstreams.lock` changes together.

## Notes

- `termloop/` sync comes from the integration fork (`feritzcan2/cmux-fork`). Pull `manaflow-ai/cmux` into that fork first if you want new upstream termloop changes here.
- `termloop/` sync excludes `.gitmodules` and the nested vendored directories, because those are managed separately in the parent repo.
- `ghostty`, `homebrew-cmux`, and `bonsplit` are synced independently so upstream changes do not overwrite local vendored state accidentally.
