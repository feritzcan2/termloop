# Release pipeline

This repo is a monorepo. GitHub Actions only executes workflows from the repository root, so workflows under `termloop/.github/workflows/` are reference material, not active automation for this repository.

The active release/deploy entry points now live in:

- `.github/workflows/release-termloop.yml`
- `.github/workflows/nightly-termloop.yml`
- `.github/workflows/deploy-landing-pages.yml`

## What ships

### `TermLoop` app release

Trigger: push a public semver tag like `v0.64.0` or run the workflow manually.

Flow:

1. Run the Sparkle monotonic build-number guard.
2. Build a universal macOS app from `termloop/`.
3. Build remote daemon release assets and inject the manifest into the app bundle.
4. Sign + notarize the app and DMG.
5. Publish immutable release assets to the GitHub Release for that tag.
6. Upload the stable Sparkle appcast to Cloudflare R2.

This keeps the public release story open-source friendly:

- releases are tied to immutable git tags
- binaries are attached to GitHub Releases
- appcast updates happen only after release assets exist
- no private package registry is required for end users

### `TermLoop` nightly

Trigger: push to `master` or run the workflow manually with `force=true`.

Flow:

1. Compare `master` HEAD with the `nightly` tag.
2. Build and notarize the nightly macOS app variant.
3. Publish or refresh the `nightly` prerelease on GitHub.
4. Upload the nightly Sparkle appcast to Cloudflare R2.

### Landing page deploy

Trigger:

- push to `master` touching `landing/**` deploys production
- PRs touching `landing/**` deploy preview builds

Cloudflare Pages project assumptions:

- project name: `termloop`
- production branch: `master`
- static output directory: `landing/`

## Required GitHub secrets

### `release-termloop.yml`

- `SPARKLE_PRIVATE_KEY`
- `APPLE_CERTIFICATE_BASE64`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`
- `CF_R2_ACCESS_KEY_ID`
- `CF_R2_SECRET_ACCESS_KEY`
- `CF_R2_ACCOUNT_ID`

Optional:

- `SENTRY_AUTH_TOKEN`

### `nightly-termloop.yml`

Uses the same secrets as `release-termloop.yml`.

### `deploy-landing-pages.yml`

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

## Bootstrap helper

You can upload all required GitHub Actions secrets with:

```bash
gh auth login -h github.com
cp docs/release-secrets.example.env ~/release-secrets.env
scripts/set-github-actions-secrets.sh --repo <owner/repo> --env-file ~/release-secrets.env
```

The env file should contain simple `KEY=value` lines for the required secrets.
The helper script will fail fast if any required values are missing.

## Release checklist

1. Prepare the app version inside `termloop/`.
2. Push the release commit to `master`.
3. Create and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. Confirm the GitHub Release contains the DMG, `appcast.xml`, and remote daemon artifacts.
5. Confirm `landing/` changes, if any, reached the Cloudflare Pages production deployment for `termloop`.
