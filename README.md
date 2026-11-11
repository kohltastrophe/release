# release

[![CI](https://img.shields.io/github/actions/workflow/status/kohltastrophe/release/release.yml?style=for-the-badge)](https://github.com/kohltastrophe/release/actions/workflows/release.yml) [![License](https://img.shields.io/github/license/kohltastrophe/release?style=for-the-badge)](LICENSE.md) [![GitHub Release](https://img.shields.io/github/v/release/kohltastrophe/release?style=for-the-badge)](https://github.com/kohltastrophe/release/releases)

Zero-dependency `node24` GitHub Action and CLI that validates Conventional Commits, maintains a standing `chore: release X.Y.Z` pull request, formats [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) release notes, and publishes GitHub Releases. It detects and bumps version files across ecosystems (`package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, `pyproject.toml`, `wally.toml`, `pesde.toml`, `rotriever.toml`, `VERSION.txt`, and custom `[release]` TOML patterns).

- **Zero setup boilerplate:** Runs natively on GitHub's `node24` runtime with no `setup-node` step, unshallows default `actions/checkout` clones automatically, and reads `workflow_dispatch` `inputs.dry_run` without YAML expressions.
- **With or without `CHANGELOG.md`:** Stamps and validates `CHANGELOG.md` when present, or renders Keep a Changelog sections (`### Added`, `### Changed`, `### Fixed`) directly into the Release PR body and `release-notes.md`.
- **Linked notes & contributors:** Links bullets to pull requests (`([#123](.../pull/123))`) or commits (`([a1b2c3d](.../commit/...))`), prefixes breaking changes with `**Breaking:**`, and appends GitHub's `### New Contributors` and `**Full Changelog**` footer.
- **Built-in asset & checksum publishing:** Expands `{version}` / `{tag}` placeholders and globs in `files`, generates or verifies `SHA256SUMS` (`checksums: true`), writes a release summary to `$GITHUB_STEP_SUMMARY`, and maintains floating `vN` major tags (`major-tag: true`).

## Quick Start

### Single-job workflow (PR check + Release PR + GitHub Release)

```yaml
name: Release

on:
  push:
    branches: [main]
  pull_request:
    types: [opened, edited, synchronize, reopened]
  workflow_dispatch:
    inputs:
      dry_run:
        description: Validate state and preview release notes only
        type: boolean
        default: true

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.sha }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

permissions:
  contents: write
  pull-requests: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: kohltastrophe/release@v1
        with:
          publish: true
          major-tag: true
```

### Building assets & waiting on `ci.yml`

When a separate `ci.yml` workflow validates PRs (`mode: check`) and tests pushes to `main`, gate the release job on `wait-for-ci: ci.yml`. Build artifacts whenever `should_build == 'true'` (which covers both real releases and `workflow_dispatch` dry runs), then publish with `mode: publish`.

```yaml
# In ci.yml — key concurrency by PR number or commit SHA so pushes to main never cancel each other:
# concurrency:
#   group: ci-${{ github.event.pull_request.number || github.sha }}
#   cancel-in-progress: true

steps:
  - uses: actions/checkout@v6

  - id: release
    uses: kohltastrophe/release@v1
    with:
      wait-for-ci: ci.yml

  - name: Build release assets
    if: steps.release.outputs.should_build == 'true'
    run: ./scripts/build-dist.sh "${{ steps.release.outputs.version }}"

  - name: Publish GitHub Release
    if: steps.release.outputs.should_build == 'true'
    uses: kohltastrophe/release@v1
    with:
      mode: publish
      title: My Package {version}
      checksums: true
      files: |
        dist/my-package-{version}-*
```

When `mode: publish` runs during a dry run, it verifies that every path or glob in `files` resolves, writes and verifies `SHA256SUMS`, and previews the release notes and digests in `$GITHUB_STEP_SUMMARY` without creating a tag or GitHub Release.

## Conventional Commit Mapping

| Commit Header | Section | Bump (`0.y.z`) | Bump (`>=1.0.0`) |
| :--- | :--- | :--- | :--- |
| `feat: <subject>` | `### Added` | `minor` | `minor` |
| `feat!: <subject>` | `### Changed` | `minor` | `major` |
| `perf: <subject>` | `### Changed` | `patch` | `patch` |
| `refactor!: <subject>` | `### Changed` | `patch` | `major` |
| `fix!: <subject>` | `### Changed` | `patch` | `major` |
| `fix: <subject>` | `### Fixed` | `patch` | `patch` |
| `security: <subject>` | `### Fixed` | `patch` | `patch` |
| `refactor:`, `docs:`, `test:`, `build:`, `ci:`, `chore:`, `revert:` | *(Unlisted)* | None | None |

Commits carrying a `BREAKING CHANGE: <description>` footer map to `### Changed` and follow the same SemVer bump rules as `!:` headers (`minor` for `feat` in `0.y.z`, `patch` for other types in `0.y.z`, and `major` in `>=1.0.0`).

## Action Reference

### Inputs

| Input | Default | Description |
| :--- | :--- | :--- |
| `mode` | `auto` | Operation mode: `auto` (`check` on PRs, Release PR or Release on `push`/`workflow_dispatch`), `check`, `pr`, `release`, or `publish`. |
| `token` | `${{ github.token }}` | GitHub token for opening Release PRs and publishing releases. |
| `working-directory` | `.` | Repository root directory. |
| `pr-title` | `${{ github.event.pull_request.title }}` | Pull request title to validate in `check` mode. |
| `repo-url` | `""` | Repository URL override for `CHANGELOG.md` release tag links. |
| `version-files` | `""` | Additional version files (`path` or `path:pattern` per line) to validate and bump. |
| `tag-prefix` | `""` | Git tag prefix before SemVer versions (overrides `[release].prefix`; defaults to `"v"`). |
| `dry-run` | `""` | Validate state and preview release notes without pushing branches, opening PRs, or publishing. Auto-reads `workflow_dispatch` `inputs.dry_run` when omitted. |
| `wait-for-ci` | `""` | Comma or newline-separated CI workflow filenames (e.g. `ci.yml`) to wait for on `$GITHUB_SHA` before releasing (`success`, `neutral`, and `skipped` pass). |
| `wait-timeout` | `"30"` | Maximum minutes to wait for CI workflows to complete. |
| `publish` | `"false"` | Create or update the GitHub Release when releasing (implied in `mode: publish`). |
| `title` | `{tag}` | GitHub Release title template (`{version}` and `{tag}` are interpolated). |
| `files` | `""` | Newline or comma-separated asset paths, `*` / `**` globs, or directories to attach (`{version}` and `{tag}` are interpolated; any `SHA256SUMS` file is verified before upload). |
| `checksums` | `""` | Generate and attach `SHA256SUMS` from `files` (`"true"` writes to the common asset directory or repo root; pass a path like `dist/SHA256SUMS` for an explicit location). |
| `major-tag` | `"false"` | Update and push the floating major tag (`vN`) on stable releases when no newer stable `N.x.y` tag exists. |

### Outputs

| Output | Description |
| :--- | :--- |
| `should_release` | `"true"` when the current commit or tag should publish a release. |
| `should_build` | `"true"` when release artifacts should be built (`should_release == 'true' \|\| dry_run == 'true'`). |
| `dry_run` | `"true"` when running in dry-run mode. |
| `version` | Resolved SemVer version without the tag prefix. |
| `tag` | Resolved Git tag (e.g. `v1.2.0`). |
| `prerelease` | `"true"` when `version` carries a SemVer prerelease suffix. |
| `notes_file` | Path to the generated `release-notes.md` file when release notes are written. |
| `release_url` | HTML URL of the created or updated GitHub Release when published. |
| `pr_url` | HTML URL of the created or updated Release PR when opened or edited. |
| `pr_number` | Pull request number of the created or updated Release PR. |

## `[release]` TOML Configuration

Add a `[release]` table to any root `*.toml` file (such as `sert.toml`, `Cargo.toml`, or `pyproject.toml`) to configure tag prefixes, sync secondary manifests or source constants, or block prerelease dependency pins:

```toml
[release]
prefix = "v"
versions = [
  { file = "src/init.luau", pattern = 'VERSION = "([^"]+)"' },
  { file = "compiler/Cargo.lock", key = "package", where = { name = "my-cli" }, field = "version" },
]
released = [
  { file = "wally.toml", key = "dependencies.Flux", pattern = "^kohltastrophe/flux@(.+)$" },
]
```

- `prefix`: Git tag prefix before SemVer versions (defaults to `"v"`).
- `versions`: Validated against the primary manifest version in `--check` and updated on version bumps (capture group `1` in `pattern` is replaced in-place). Root `package-lock.json` and root `Cargo.lock` local package entries sync automatically when paired with a versioned root `package.json` or `Cargo.toml`.
- `released`: Verified to be non-prerelease SemVer strings in `--check` without being modified on version bumps.

## CLI Usage

```bash
release [patch|minor|major|x.y.z]           # Bump manifest files (and CHANGELOG.md if present)
release --check [range]                     # Validate Conventional Commits and manifest/changelog state
release --notes [x.y.z]                     # Print Keep a Changelog release notes to stdout
release --pr [--dry-run]                    # Open or update the standing `chore: release X.Y.Z` PR
release --publish [x.y.z] [--checksums]     # Create or update the GitHub Release
```

## Sponsors

`release` is free and MIT-licensed. If `release` is useful to you or your team, you can support its development through [GitHub Sponsors](https://github.com/sponsors/kohltastrophe) or [Ko-fi](https://ko-fi.com/kohltastrophe).

<p align="center">
  <a href="https://github.com/sponsors/kohltastrophe"><img src="https://raw.githubusercontent.com/kohltastrophe/kohltastrophe/badges/sponsor-github.svg" alt="GitHub Sponsors" /></a>&nbsp;&nbsp;<a href="https://ko-fi.com/kohltastrophe"><img src="https://raw.githubusercontent.com/kohltastrophe/kohltastrophe/badges/sponsor-kofi.svg" alt="Ko-fi" /></a>
  <a href="https://github.com/sponsors/kohltastrophe"><img src="https://raw.githubusercontent.com/kohltastrophe/kohltastrophe/badges/sponsors.svg" alt="Sponsors" /></a>
</p>
