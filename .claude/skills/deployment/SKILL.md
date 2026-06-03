---
name: deployment
description: Use when the user asks to deploy or release TermLoop, publish a TermLoop Mobile OTA update, upload TermLoop Mobile to TestFlight/App Store Connect, or rebuild/reload the dev-tagged TermLoop app.
---

# Deployment

In this codebase, deployment requests are delegated to the local Raycast scripts in `/Users/felixzcan/RaycastScripts/Termloop` because they encode the current merge, version-bump, EAS, Sparkle, and GitHub Actions workflow. Run them from `/Users/felixzcan/Projects/termloop`; do not reimplement release steps by hand.

## When this triggers

Positive examples:
- “mobile OTA release yap”
- “mobil TestFlight’a yükle”
- “termloop release çıkar”
- “rebuild et termloopu”
- “termloop dev dev’i rebuild et”

Negative examples:
- “mobile app’te release notes ekranını düzelt”
- “TermLoop reload bug’ını kodda fixle”
- “deployment docs’unu oku ama release çalıştırma”
- “TermLoop build settings bug’ını düzelt”

## Commands

Use `/bin/bash` for Raycast scripts. Verify with `bash --version`; if missing, stop because macOS shell execution is required.

- Mobile OTA / over-the-air release: run `bash /Users/felixzcan/RaycastScripts/Termloop/release-termloop-mobile-ota.sh "<update message>"` because this publishes EAS Update from local `terminal-app/` files without merge, commit, or push. If the user did not give a message, use a short factual message from the task.
- Mobile TestFlight / mobile App Store Connect release: run `bash /Users/felixzcan/RaycastScripts/Termloop/release-termloop-mobile-locally.sh` because this is the preferred local IPA build + submit path. Do this even when the user does not say “locally”. Leave the default `production` profile unless the user explicitly asks for `staging`.
- TermLoop stable desktop release: run `bash /Users/felixzcan/RaycastScripts/Termloop/release-termloop.sh` because it merges `origin/dev` into `master`, bumps the Sparkle app version, pushes `master`, creates the next `v1.0.x` tag, and triggers `.github/workflows/release-termloop.yml`.
- TermLoop dev rebuild/reload: when the user says “rebuild TermLoop”, “reload TermLoop”, “termloop dev”, or “dev’i rebuild et”, reload the `dev` tag, not a random tag, because the user’s active dev build is `TermLoop DEV dev.app`.

## Safe dev reload

Never run `reload-termloop.sh dev` in the foreground from inside a TermLoop agent session, because `--launch` kills and relaunches the same dev app and can terminate the agent mid-command. Prefer a detached `launchctl` job:

```bash
log="/tmp/termloop-reload-dev-$(date +%Y%m%d-%H%M%S).log"
launchctl submit -l "termloop.reload.dev.$(date +%s)" -- /bin/bash -lc 'bash /Users/felixzcan/RaycastScripts/Termloop/reload-termloop.sh dev >"$0" 2>&1' "$log"
echo "Detached TermLoop dev reload started. Log: $log"
```

Verify `launchctl help` first. If `launchctl submit` is unavailable, use `nohup bash /Users/felixzcan/RaycastScripts/Termloop/reload-termloop.sh dev >"$log" 2>&1 & disown` and warn that the job may be less isolated.

## Guardrails

Before any release script, say exactly which script and arguments you will run; these scripts can push branches/tags or submit builds. Do not run release scripts for doc-only or code-fix requests that merely mention deployment. If a script fails, report the failing command, last relevant log lines, and the script’s own remediation hint; do not retry with changed release semantics unless the user asks.
