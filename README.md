# release

Zero-dependency GitHub Action and CLI for validating Conventional Commits, opening automated `chore: release X.Y.Z` pull requests, and formatting [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) release notes. It bumps version manifests across ecosystems (`package.json`, `wally.toml`, `pesde.toml`, `rotriever.toml`, `Cargo.toml`, `pyproject.toml`, `VERSION.txt`, plus any `[release]` `versions` entries in root `*.toml` configs).

- **With `CHANGELOG.md`:** Stamps and validates `CHANGELOG.md` alongside version manifests in the Release PR.
- **Without `CHANGELOG.md`:** Renders Keep a Changelog notes (`### Added`, `### Changed`, `### Fixed`) directly into the Release PR body and `release-notes.md` without creating a `CHANGELOG.md` file in the repository.
- **GitHub Release Sections:** Automatically appends GitHub's `## New Contributors` section (when present via `releases/generate-notes`) and the `**Full Changelog**` comparison link to `release-notes.md` and the Release PR body while keeping `CHANGELOG.md` purely Keep a Changelog.

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

Commits with a `BREAKING CHANGE: <description>` footer map to `### Changed` and follow the same version bump rules as `!:` headers (`minor` for `feat` in `0.y.z`, `patch` for other types in `0.y.z`, and `major` in `>=1.0.0`).

## GitHub Action Usage

```yaml
- uses: kohltastrophe/release@v1
  id: release
  with:
    mode: auto # auto | check | pr | release
    token: ${{ secrets.GITHUB_TOKEN }}
```

### Inputs

| Input | Default | Description |
| :--- | :--- | :--- |
| `mode` | `auto` | Operation mode: `auto`, `check`, `pr`, or `release`. |
| `token` | `${{ github.token }}` | GitHub token for opening Release PRs and preparing releases. |
| `working-directory` | `.` | Repository root directory. |
| `pr-title` | `""` | Pull request title to validate in `check` mode. |
| `repo-url` | `""` | Repository URL override for `CHANGELOG.md` release tag links. |
| `version-files` | `""` | Additional version files (`path` or `path:pattern` per line) to validate and bump. |
| `dry-run` | `"false"` | Validate state and resolve version/release notes without opening a PR or setting `should_release=true`. |

### Outputs

| Output | Description |
| :--- | :--- |
| `should_release` | `"true"` when the current commit or tag should publish a release. |
| `version` | Resolved SemVer version without a leading `v`. |
| `tag` | Resolved Git tag (`vX.Y.Z`). |
| `prerelease` | `"true"` when `version` carries a SemVer prerelease suffix. |
| `notes_file` | Path to the generated `release-notes.md` file when release notes are written. |

## CLI Usage

```bash
release [patch|minor|major|x.y.z]   # Bump manifest files (and CHANGELOG.md if present)
release --check [range]             # Validate Conventional Commits and manifest/changelog state
release --notes [x.y.z]             # Print Keep a Changelog release notes to stdout
release --pr                        # Open or update the standing `chore: release X.Y.Z` PR
```
