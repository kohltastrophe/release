import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	appendGithubReleaseSections,
	buildChangelogFromCommits,
	extractGithubReleaseSections,
	extractReleaseNotes,
	formatBullet,
	formatCommitRef,
	prepareRelease,
	splitTrailingPrRef,
	todayIsoDate,
	validateCommitSubject,
	validateReleaseState,
} from "../src/changelog.mjs";

describe("changelog & conventional commits", () => {
	test("maps feat, fix, perf, security, and breaking commits to Keep a Changelog sections and 0.x/1.x bumps", () => {
		const res0x = buildChangelogFromCommits(
			"0.3.0",
			[
				{ subject: "refactor!: drop legacy configuration format (#41)" },
				{
					subject: "fix: tighten path check (#40)",
					body: "BREAKING CHANGE: reject relative paths outside workspace",
				},
				{
					subject: "fix: stop hat texture leaking into cache (#579)5",
					sha: "1f6936eabd7f74f83011178e1ea2392cb68358cc",
				},
				{
					subject: "fix: resolve generic type linking",
					sha: "dd0f73d111111111111111111111111111111111",
				},
				{ subject: "security: escape shell metacharacters" },
				{ subject: "perf: cache regex compilation" },
				{ subject: "docs: tighten guides" },
				{ subject: 'Revert "feat: experimental flag"' },
				{ subject: "chore: release 0.3.0 (#42)" },
			],
			{ repoUrl: "https://github.com/owner/pkg" },
		);
		assert.equal(res0x.bump, "patch");
		assert.equal(
			res0x.markdown,
			[
				"### Changed",
				"",
				"- **Breaking:** Drop legacy configuration format. ([#41](https://github.com/owner/pkg/pull/41))",
				"- **Breaking:** Reject relative paths outside workspace. ([#40](https://github.com/owner/pkg/pull/40))",
				"- Cache regex compilation.",
				"",
				"### Fixed",
				"",
				"- Stop hat texture leaking into cache. ([#579](https://github.com/owner/pkg/pull/579))",
				"- Resolve generic type linking. ([dd0f73d](https://github.com/owner/pkg/commit/dd0f73d111111111111111111111111111111111))",
				"- Escape shell metacharacters.",
			].join("\n"),
		);

		const feat0x = buildChangelogFromCommits("0.2.0", [
			{ subject: "feat: add automatic release note extraction" },
			{ subject: "refactor!: tighten config validation" },
			{ subject: "fix: resolve markdown escaping" },
		]);
		assert.equal(feat0x.bump, "minor");

		const breaking1x = buildChangelogFromCommits("1.0.0", [
			{ subject: "refactor!: drop deprecated API" },
		]);
		assert.equal(breaking1x.bump, "major");

		// Deduplicates identical bullets and upgrades SHA link when later duplicate carries a PR ref
		const nonStrict = buildChangelogFromCommits(
			"1.0.0",
			[
				{ subject: "Merge branch main" },
				{ subject: "fix: handle edge case", sha: "11111112222222" },
				{ subject: "fix: handle edge case", sha: "33333334444444" },
			],
			{ strict: false },
		);
		assert.equal(nonStrict.bump, "patch");
		assert.equal(nonStrict.markdown, "### Fixed\n\n- Handle edge case. (1111111)");

		const upgradedPr = buildChangelogFromCommits(
			"1.0.0",
			[
				{ subject: "fix: handle edge case", sha: "11111112222222" },
				{ subject: "fix: handle edge case (#99)", sha: "33333334444444" },
			],
			{ repoUrl: "https://github.com/owner/pkg" },
		);
		assert.equal(
			upgradedPr.markdown,
			"### Fixed\n\n- Handle edge case. ([#99](https://github.com/owner/pkg/pull/99))",
		);
	});

	test("validates commit subjects and bullet formatting", () => {
		assert.deepEqual(validateCommitSubject("feat: add new feature"), {
			type: "feat",
			breaking: false,
			description: "add new feature",
		});
		assert.deepEqual(validateCommitSubject("fix(parser)!: reject malformed tokens"), {
			type: "fix",
			breaking: true,
			description: "reject malformed tokens",
		});
		assert.throws(
			() => validateCommitSubject("Update README.md"),
			/invalid Conventional Commit subject/,
		);
		assert.deepEqual(splitTrailingPrRef("stop hat cache leak (#579)5"), {
			text: "stop hat cache leak",
			pr: "579",
		});
		assert.equal(
			formatCommitRef({ pr: "579", repoUrl: "https://github.com/owner/pkg/" }),
			"([#579](https://github.com/owner/pkg/pull/579))",
		);
		assert.equal(formatBullet("pkg.scope cleanup"), "pkg.scope cleanup.");
		assert.equal(formatBullet("already punctuated!"), "Already punctuated!");
		assert.equal(
			formatBullet("stop hat texture leak (#579)5", {
				repoUrl: "https://github.com/owner/pkg",
			}),
			"Stop hat texture leak. ([#579](https://github.com/owner/pkg/pkg/pull/579))".replace(
				"/pkg/pkg/",
				"/pkg/",
			),
		);
		assert.match(todayIsoDate(), /^\d{4}-\d{2}-\d{2}$/);
	});

	test("prepares and validates CHANGELOG.md, $ replacement safety, Unreleased notes, and explicit historical lookups", () => {
		const changelog = [
			"# Changelog",
			"",
			"## [0.1.0] - 2026-08-28",
			"",
			"### Added",
			"",
			"- Initial release.",
			"",
			"[0.1.0]: https://github.com/owner/repo/releases/tag/v0.1.0",
			"",
		].join("\n");

		const prepared = prepareRelease({
			changelogText: changelog,
			baseVersion: "0.1.0",
			date: "2026-09-01",
			commits: [
				{ subject: "feat: support _category_ sidecars and $' / $& tokens" },
				{ subject: "fix: prevent empty YAML frontmatter keys from consuming the next line" },
			],
		});

		assert.equal(prepared.version, "0.2.0");
		assert.deepEqual(validateReleaseState("0.2.0", prepared.changelogText).versions, [
			"0.2.0",
			"0.1.0",
		]);
		assert.ok(
			extractReleaseNotes("0.2.0", prepared.changelogText).includes(
				"- Support _category_ sidecars and $' / $& tokens.",
			),
		);

		const withUnreleased = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Added",
			"",
			"- Hand-crafted unreleased feature.",
			"",
			"## [1.0.0] - 2026-08-01",
			"",
			"### Added",
			"",
			"- First stable release.",
			"",
			"[Unreleased]: https://github.com/acme/widget/compare/v1.0.0...HEAD",
			"[1.0.0]: https://github.com/acme/widget/releases/tag/v1.0.0",
			"",
		].join("\n");

		// Omitted version with allowUnreleased returns Unreleased notes
		assert.equal(
			extractReleaseNotes("1.0.0", withUnreleased, undefined, undefined, {
				allowUnreleased: true,
			}),
			"### Added\n\n- Hand-crafted unreleased feature.\n",
		);
		// Explicit version lookup returns that historical version's section (not Unreleased!)
		assert.equal(
			extractReleaseNotes("1.0.0", withUnreleased, "1.0.0", undefined, {
				allowUnreleased: true,
			}),
			"### Added\n\n- First stable release.\n",
		);
		// Missing explicit version throws even when Unreleased notes exist
		assert.throws(
			() =>
				extractReleaseNotes("1.0.0", withUnreleased, "9.9.9", undefined, {
					allowUnreleased: true,
				}),
			/no "## \[9\.9\.9\]" section/,
		);

		const stamped = prepareRelease({
			changelogText: withUnreleased,
			baseVersion: "1.0.0",
			target: "minor",
			date: "2026-09-01",
			commits: [{ subject: "feat: commit message that should not overwrite Unreleased" }],
		});
		assert.equal(stamped.version, "1.1.0");
		assert.ok(stamped.notes.includes("- Hand-crafted unreleased feature."));
		assert.ok(
			stamped.changelogText.includes(
				"[1.1.0]: https://github.com/acme/widget/releases/tag/v1.1.0",
			),
		);
	});

	test("accepts skipped changelog version steps bridged by known git tags at any position and supports custom tagPrefix", () => {
		// 0.19.0 -> (rolled-back tag 0.19.1) -> 0.19.2 -> 0.19.3
		const bridgedChangelog = [
			"# Changelog",
			"",
			"## [0.19.3] - 2026-09-03",
			"",
			"- Third patch.",
			"",
			"## [0.19.2] - 2026-09-02",
			"",
			"- Second patch after rolled-back 0.19.1.",
			"",
			"## [0.19.0] - 2026-09-01",
			"",
			"- Base minor.",
			"",
			"[0.19.3]: https://github.com/owner/repo/releases/tag/pkg-v0.19.3",
			"[0.19.2]: https://github.com/owner/repo/releases/tag/pkg-v0.19.2",
			"[0.19.0]: https://github.com/owner/repo/releases/tag/pkg-v0.19.0",
			"",
		].join("\n");

		// Fails when 0.19.1 is not in knownVersions
		assert.throws(
			() =>
				validateReleaseState("0.19.3", bridgedChangelog, "https://github.com/owner/repo", {
					tagPrefix: "pkg-v",
				}),
			/not a valid semver step/,
		);

		// Succeeds at index i = 1 when 0.19.1 is in knownVersions
		const state = validateReleaseState(
			"0.19.3",
			bridgedChangelog,
			"https://github.com/owner/repo",
			{
				tagPrefix: "pkg-v",
				knownVersions: new Set(["0.19.0", "0.19.1", "0.19.2", "0.19.3"]),
			},
		);
		assert.deepEqual(state.versions, ["0.19.3", "0.19.2", "0.19.0"]);
	});

	test("enforces all validateReleaseState invariants", () => {
		assert.throws(() => validateReleaseState("bad", "# Changelog"), /not valid semver/);
		assert.throws(
			() => validateReleaseState("0.1.0", "# Changelog\n"),
			/no `## \[x\.y\.z\]/,
		);
		assert.throws(
			() =>
				validateReleaseState(
					"0.1.0",
					"## [0.1.0] - 2026-08-01\n\n- Note.\n\n## [Unreleased]\n\n[0.1.0]: https://github.com/owner/repo/releases/tag/v0.1.0\n",
				),
			/Unreleased.*must appear before/,
		);
		assert.throws(
			() =>
				validateReleaseState(
					"0.1.0",
					"## [Unreleased]\n\n- Pending note.\n\n## [0.1.0] - 2026-08-01\n\n- Note.\n\n[0.1.0]: https://github.com/owner/repo/releases/tag/v0.1.0\n",
				),
			/unreleased notes under/,
		);
		assert.throws(
			() =>
				validateReleaseState(
					"0.1.0",
					"## [0.1.0] - 2026-02-30\n\n- Invalid calendar date.\n",
				),
			/valid YYYY-MM-DD date/,
		);
		assert.throws(
			() =>
				validateReleaseState(
					"0.1.0",
					"## [0.1.0] - 2026-08-01\n\n## [0.0.9] - 2026-07-01\n\n- Note.\n",
				),
			/has no release notes/,
		);
		assert.throws(
			() =>
				validateReleaseState(
					"0.1.0",
					"## [0.1.0] - 2026-08-02\n\n- A.\n\n## [0.1.0] - 2026-08-01\n\n- B.\n",
				),
			/duplicate/,
		);
		assert.throws(
			() =>
				validateReleaseState(
					"0.3.0",
					"## [0.3.0] - 2026-08-02\n\n- A.\n\n## [0.1.0] - 2026-08-01\n\n- B.\n",
				),
			/not a valid semver step/,
		);
	});

	test("extracts and appends GitHub New Contributors and Full Changelog sections", () => {
		const ghGenerated = [
			"## What's Changed",
			"* feat: add new widget by @alice in https://github.com/owner/pkg/pull/7",
			"",
			"## New Contributors",
			"* @github-actions[bot] made their first contribution in https://github.com/owner/pkg/pull/1",
			"* @alice made their first contribution in https://github.com/owner/pkg/pull/7",
			"",
			"**Full Changelog**: https://github.com/owner/pkg/compare/v0.1.0...v0.2.0",
		].join("\n");

		const extracted = extractGithubReleaseSections(ghGenerated);
		assert.deepEqual(extracted, {
			newContributors:
				"### New Contributors\n\n- @alice made their first contribution in [#7](https://github.com/owner/pkg/pull/7).",
			fullChangelog:
				"**Full Changelog**: [v0.1.0...v0.2.0](https://github.com/owner/pkg/compare/v0.1.0...v0.2.0)",
		});

		const combined = appendGithubReleaseSections("### Added\n\n- Add new widget.\n", {
			repoUrl: "https://github.com/owner/pkg",
			prevTag: "v0.1.0",
			version: "0.2.0",
			generatedBody: ghGenerated,
		});
		assert.equal(
			combined,
			[
				"### Added",
				"",
				"- Add new widget.",
				"",
				"### New Contributors",
				"",
				"- @alice made their first contribution in [#7](https://github.com/owner/pkg/pull/7).",
				"",
				"**Full Changelog**: [v0.1.0...v0.2.0](https://github.com/owner/pkg/compare/v0.1.0...v0.2.0)",
				"",
			].join("\n"),
		);

		const customPrefixFooter = appendGithubReleaseSections("### Added\n\n- Initial.\n", {
			repoUrl: "https://github.com/owner/pkg",
			version: "0.1.0",
			tagPrefix: "pkg-v",
		});
		assert.ok(
			customPrefixFooter.includes(
				"**Full Changelog**: [pkg-v0.1.0](https://github.com/owner/pkg/commits/pkg-v0.1.0)",
			),
		);
	});
});
