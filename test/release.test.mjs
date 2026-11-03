import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, test } from "node:test";
import {
	appendGithubReleaseSections,
	buildChangelogFromCommits,
	bumpRepoVersionFiles,
	compareSemver,
	detectReleaseCommit,
	detectRepoVersion,
	extractGithubReleaseSections,
	extractReleaseNotes,
	formatBullet,
	formatCommitRef,
	isValidSemverStep,
	main,
	parseSemver,
	parseWorkflowRunsResponse,
	prepareRelease,
	readCommitsInRange,
	resolvePreviousReleaseTag,
	resolveTargetVersion,
	splitTrailingPrRef,
	todayIsoDate,
	validateCommitSubject,
	validateReleaseState,
	waitForCiWorkflows,
} from "../release.mjs";

function withTempDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), "release-test-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function restoreEnv(prevEnv) {
	for (const key of Object.keys(process.env)) {
		if (!(key in prevEnv)) delete process.env[key];
	}
	for (const [key, val] of Object.entries(prevEnv)) {
		process.env[key] = val;
	}
}

function initGitRepo(dir) {
	execFileSync("git", ["init", "-b", "main"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
	execFileSync("git", ["config", "tag.gpgSign", "false"], { cwd: dir });
}

function gitCommit(dir, message, file = "README.md", content = message) {
	writeFileSync(join(dir, file), `${content}\n`);
	execFileSync("git", ["add", "--", file], { cwd: dir });
	execFileSync("git", ["commit", "--no-gpg-sign", "-m", message], { cwd: dir });
}

describe("semver & conventional commits", () => {
	test("parses strict semver and prereleases", () => {
		assert.deepEqual(parseSemver("0.3.1"), { major: 0, minor: 3, patch: 1 });
		assert.deepEqual(parseSemver("1.2.3-beta.1"), {
			major: 1,
			minor: 2,
			patch: 3,
			prerelease: "beta.1",
		});
		assert.equal(parseSemver("v0.3.1"), undefined);
		assert.equal(parseSemver("01.2.3"), undefined);
	});

	test("validates semver steps, prerelease progressions, and target resolution", () => {
		assert.equal(isValidSemverStep("0.3.0", "0.3.1"), true);
		assert.equal(isValidSemverStep("0.3.1", "0.4.0"), true);
		assert.equal(isValidSemverStep("0.3.1", "1.0.0"), true);
		assert.equal(isValidSemverStep("0.3.0", "0.3.2"), false);
		assert.equal(isValidSemverStep("1.0.0-alpha.1", "1.0.0-alpha.2"), true);
		assert.equal(isValidSemverStep("1.0.0-alpha.2", "1.0.0-beta.1"), true);
		assert.equal(isValidSemverStep("1.0.0-beta.1", "1.0.0"), true);
		assert.equal(isValidSemverStep("1.0.0", "1.0.0-alpha.1"), false);
		assert.equal(isValidSemverStep("1.0.0-alpha.2", "1.0.0-alpha.1"), false);

		assert.equal(resolveTargetVersion("0.3.1", "patch"), "0.3.2");
		assert.equal(resolveTargetVersion("0.3.1", "minor"), "0.4.0");
		assert.equal(resolveTargetVersion("0.3.1", "major"), "1.0.0");
		assert.equal(resolveTargetVersion("1.0.0-beta.1", "1.0.0"), "1.0.0");
		assert.throws(() => resolveTargetVersion("bad", "patch"), /not valid semver/);
		assert.throws(() => resolveTargetVersion("0.3.1", "invalid"), /invalid release target/);
		assert.throws(() => resolveTargetVersion("0.3.0", "0.3.2"), /not a valid semver increment/);
	});

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
			"Stop hat texture leak. ([#579](https://github.com/owner/pkg/pull/579))",
		);
		assert.match(todayIsoDate(), /^\d{4}-\d{2}-\d{2}$/);
	});

	test("prepares and validates CHANGELOG.md, $ replacement safety, Unreleased notes, and repoUrl inference", () => {
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

		const customChangelog = [
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
			"[1.0.0]: https://github.com/acme/widget/releases/tag/v1.0.0",
			"",
		].join("\n");

		const stamped = prepareRelease({
			changelogText: customChangelog,
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
		assert.deepEqual(validateReleaseState("1.1.0", stamped.changelogText).versions, [
			"1.1.0",
			"1.0.0",
		]);

		const emptyUnreleased = prepareRelease({
			changelogText: "# Changelog\n\n## [Unreleased]\n",
			baseVersion: "0.1.0",
			target: "0.1.0",
			date: "2026-09-01",
			commits: [{ subject: "feat: initial release" }],
			repoUrl: "https://github.com/owner/repo",
		});
		assert.deepEqual(
			validateReleaseState("0.1.0", emptyUnreleased.changelogText).versions,
			["0.1.0"],
		);

		const emptyUnreleasedAboveExisting = prepareRelease({
			changelogText:
				"# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-08-01\n\n### Added\n\n- Initial.\n\n[1.0.0]: https://github.com/owner/repo/releases/tag/v1.0.0\n",
			baseVersion: "1.0.0",
			date: "2026-09-01",
			commits: [{ subject: "feat: add second release" }],
		});
		assert.deepEqual(
			validateReleaseState("1.1.0", emptyUnreleasedAboveExisting.changelogText).versions,
			["1.1.0", "1.0.0"],
		);
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

	test("detects and bumps multi-manifest repositories including scoped TOML, Cargo.lock, and [release] TOML entries", () => {
		withTempDir((dir) => {
			mkdirSync(join(dir, "python", "pkg"), { recursive: true });
			writeFileSync(
				join(dir, "Cargo.toml"),
				'[workspace]\nresolver = "2"\n\n[dependencies.foo]\nversion = "9.9.9"\n\n[package]\nname = "demo"\nversion = "0.2.0"\n',
			);
			writeFileSync(
				join(dir, "Cargo.lock"),
				'[[package]]\nname = "other"\nversion = "9.9.9"\n\n[[package]]\nname = "demo-cli"\nversion = "0.2.0"\n',
			);
			writeFileSync(
				join(dir, "wally.toml"),
				'[package]\nname = "owner/demo"\nversion = "0.2.0"\n',
			);
			writeFileSync(join(dir, "VERSION.txt"), "0.2.0\n");
			writeFileSync(join(dir, "python", "pkg", "__init__.py"), 'VERSION = "0.2.0"\n');
			writeFileSync(join(dir, "init.luau"), 'return { VERSION = "0.2.0" }\n');
			writeFileSync(
				join(dir, "release.toml"),
				[
					"[release]",
					"versions = [",
					'  # { file = "../ignored.toml" }',
					'  { file = "python/pkg/__init__.py", pattern = \'^VERSION = "([^"]*)"\' },',
					'  { file = "Cargo.lock", key = "package", where = { name = "demo-cli" }, field = "version" },',
					'  { file = "init.luau", pattern = \'VERSION = "([^"]+)"\' },',
					"]",
				].join("\n"),
			);

			const detected = detectRepoVersion(dir);
			assert.equal(detected.version, "0.2.0");
			assert.deepEqual(detected.files, [
				"VERSION.txt",
				"wally.toml",
				"Cargo.toml",
				"python/pkg/__init__.py",
				"Cargo.lock",
				"init.luau",
			]);

			const modified = bumpRepoVersionFiles(dir, "0.3.0", detected.files);
			assert.deepEqual(modified, [
				"VERSION.txt",
				"wally.toml",
				"Cargo.toml",
				"python/pkg/__init__.py",
				"Cargo.lock",
				"init.luau",
			]);
			assert.ok(
				readFileSync(join(dir, "Cargo.toml"), "utf8").includes(
					'[dependencies.foo]\nversion = "9.9.9"\n\n[package]\nname = "demo"\nversion = "0.3.0"',
				),
			);
			assert.ok(
				readFileSync(join(dir, "Cargo.lock"), "utf8").includes(
					'[[package]]\nname = "demo-cli"\nversion = "0.3.0"',
				),
			);
			assert.equal(
				readFileSync(join(dir, "python", "pkg", "__init__.py"), "utf8"),
				'VERSION = "0.3.0"\n',
			);
			assert.equal(
				readFileSync(join(dir, "init.luau"), "utf8"),
				'return { VERSION = "0.3.0" }\n',
			);

			writeFileSync(
				join(dir, "release.toml"),
				'[release]\nversions = [{ file = "../escape.toml" }]\n',
			);
			assert.throws(() => bumpRepoVersionFiles(dir, "0.4.0"), /unsafe release file path/);
		});
	});

	test("runs git commit range, CLI bump, check, dry-run, and release modes in a git repository", () => {
		withTempDir((dir) => {
			initGitRepo(dir);
			writeFileSync(
				join(dir, "wally.toml"),
				'[package]\nname = "owner/pkg"\nversion = "0.1.0"\n',
			);
			writeFileSync(
				join(dir, "CHANGELOG.md"),
				[
					"# Changelog",
					"",
					"## [0.1.0] - 2026-08-01",
					"",
					"### Added",
					"",
					"- Initial release.",
					"",
					"[0.1.0]: https://github.com/owner/pkg/releases/tag/v0.1.0",
					"",
				].join("\n"),
			);
			gitCommit(
				dir,
				"feat: initial release",
				"wally.toml",
				readFileSync(join(dir, "wally.toml"), "utf8"),
			);
			execFileSync("git", ["tag", "v0.1.0"], { cwd: dir });
			execFileSync("git", ["tag", "-a", "v0", "-m", "v0"], { cwd: dir });
			gitCommit(dir, "feat: add new widget");

			assert.throws(() => readCommitsInRange(dir, "--output=/tmp/bad"), /invalid git range/);
			const commits = readCommitsInRange(dir, "v0.1.0..HEAD");
			assert.equal(commits.length, 1);
			assert.equal(commits[0].subject, "feat: add new widget");
			assert.equal(commits[0].body, "");
			assert.match(commits[0].sha, /^[0-9a-f]{40}$/);

			const prevEnv = { ...process.env };
			try {
				process.env.INPUT_WORKING_DIRECTORY = dir;
				process.env.INPUT_REPO_URL = "https://github.com/owner/pkg";
				process.env.PR_TITLE = 'Revert "feat: add new widget"';
				main(["--check"]);

				rmSync(join(dir, "CHANGELOG.md"));
				gitCommit(dir, "Merge 1111111 into 2222222");
				process.env.PR_TITLE = "feat: valid pr title";
				main(["--check"]);
				delete process.env.PR_TITLE;
				main(["--check"]);
				writeFileSync(
					join(dir, "CHANGELOG.md"),
					[
						"# Changelog",
						"",
						"## [0.1.0] - 2026-08-01",
						"",
						"### Added",
						"",
						"- Initial release.",
						"",
						"[0.1.0]: https://github.com/owner/pkg/releases/tag/v0.1.0",
						"",
					].join("\n"),
				);
				gitCommit(dir, "docs: restore changelog");

				main(["minor"]);
				assert.equal(detectRepoVersion(dir).version, "0.2.0");
				assert.ok(readFileSync(join(dir, "CHANGELOG.md"), "utf8").includes("## [0.2.0]"));

				const dryOutFile = join(dir, "gh-dry-output.txt");
				process.env.GITHUB_OUTPUT = dryOutFile;
				process.env.INPUT_MODE = "auto";
				process.env.INPUT_DRY_RUN = "true";
				main(["--ci"]);
				const dryOut = readFileSync(dryOutFile, "utf8");
				assert.ok(dryOut.includes("should_release=false"));
				assert.ok(dryOut.includes("version=0.2.0"));
				delete process.env.INPUT_DRY_RUN;

				const dispatchOutFile = join(dir, "gh-dispatch-output.txt");
				process.env.GITHUB_OUTPUT = dispatchOutFile;
				process.env.INPUT_MODE = "auto";
				process.env.GITHUB_EVENT_NAME = "workflow_dispatch";
				main(["--ci"]);
				const dispatchOut = readFileSync(dispatchOutFile, "utf8");
				assert.ok(dispatchOut.includes("should_release=true"));
				assert.ok(dispatchOut.includes("version=0.2.0"));
				delete process.env.GITHUB_EVENT_NAME;

				gitCommit(dir, "docs: polish release notes");
				execFileSync("git", ["tag", "v0.2.0"], { cwd: dir });
				const taggedHeadOutFile = join(dir, "gh-tagged-head-output.txt");
				process.env.GITHUB_OUTPUT = taggedHeadOutFile;
				process.env.INPUT_MODE = "auto";
				main(["--ci"]);
				const taggedHeadOut = readFileSync(taggedHeadOutFile, "utf8");
				assert.ok(taggedHeadOut.includes("should_release=true"));
				assert.ok(taggedHeadOut.includes("version=0.2.0"));
				assert.ok(taggedHeadOut.includes("tag=v0.2.0"));
				execFileSync("git", ["tag", "-d", "v0.2.0"], { cwd: dir });

				gitCommit(dir, "chore: release 0.2.0 (#7)");
				const outFile = join(dir, "gh-output.txt");
				process.env.GITHUB_OUTPUT = outFile;
				process.env.INPUT_MODE = "auto";
				delete process.env.GITHUB_EVENT_NAME;
				main(["--ci"]);
				const ghOut = readFileSync(outFile, "utf8");
				assert.ok(ghOut.includes("should_release=true"));
				assert.ok(ghOut.includes("version=0.2.0"));
				assert.ok(ghOut.includes("tag=v0.2.0"));
				const notesText = readFileSync(join(dir, "release-notes.md"), "utf8");
				assert.match(
					notesText,
					/### Added\n\n- Add new widget\. \(\[[0-9a-f]{7}\]\(https:\/\/github\.com\/owner\/pkg\/commit\/[0-9a-f]{40}\)\)/,
				);
				assert.ok(
					notesText.includes(
						"**Full Changelog**: [v0.1.0...v0.2.0](https://github.com/owner/pkg/compare/v0.1.0...v0.2.0)",
					),
				);
			} finally {
				restoreEnv(prevEnv);
			}
		});
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

		const fallbackCompare = appendGithubReleaseSections("### Fixed\n\n- Fix edge case.\n", {
			repoUrl: "https://github.com/owner/pkg/",
			prevTag: "0.1.0",
			version: "0.1.1",
		});
		assert.equal(
			fallbackCompare,
			[
				"### Fixed",
				"",
				"- Fix edge case.",
				"",
				"**Full Changelog**: [v0.1.0...v0.1.1](https://github.com/owner/pkg/compare/v0.1.0...v0.1.1)",
				"",
			].join("\n"),
		);

		const fallbackInitial = appendGithubReleaseSections("### Added\n\n- Initial release.\n", {
			repoUrl: "https://github.com/owner/pkg",
			version: "0.1.0",
		});
		assert.equal(
			fallbackInitial,
			[
				"### Added",
				"",
				"- Initial release.",
				"",
				"**Full Changelog**: [v0.1.0](https://github.com/owner/pkg/commits/v0.1.0)",
				"",
			].join("\n"),
		);
	});

	test("compares semver versions and resolves previous release tags and tagged ranges without CHANGELOG.md", () => {
		assert.equal(compareSemver("0.1.0", "0.2.0"), -1);
		assert.equal(compareSemver("0.2.0", "0.2.0"), 0);
		assert.equal(compareSemver("1.0.0", "1.0.0-alpha.1"), 1);
		assert.equal(compareSemver("1.0.0-alpha.1", "1.0.0"), -1);

		withTempDir((dir) => {
			initGitRepo(dir);
			writeFileSync(
				join(dir, "wally.toml"),
				'[package]\nname = "owner/pkg"\nversion = "0.2.0"\n',
			);
			gitCommit(dir, "feat: v0.1.0");
			execFileSync("git", ["tag", "v0.1.0"], { cwd: dir });
			gitCommit(dir, "feat: add network-synchronized signals (#16)");
			execFileSync("git", ["tag", "v0.2.0"], { cwd: dir });
			gitCommit(dir, "docs: link release badge in README");

			const changelog = [
				"# Changelog",
				"",
				"## [0.2.0] - 2026-08-02",
				"",
				"- Second.",
				"",
				"[0.2.0]: https://github.com/owner/pkg/releases/tag/v0.2.0",
				"",
			].join("\n");

			// Target 0.3.0 is newer than versions[0] (0.2.0) -> uses versions[0]
			assert.equal(resolvePreviousReleaseTag(dir, "0.3.0", changelog), "v0.2.0");
			// Target 0.2.0 is at versions[0] with no versions[1] -> falls back to git tag before v0.2.0
			assert.equal(resolvePreviousReleaseTag(dir, "0.2.0", changelog), "v0.1.0");
			// Target 0.1.5 is older than versions[0] (0.2.0) and missing from changelog -> falls back to git tag
			assert.equal(resolvePreviousReleaseTag(dir, "0.1.5", changelog), "v0.1.0");

			// Without CHANGELOG.md, resolving notes for already-tagged v0.2.0 even after later docs commits on HEAD uses v0.1.0..v0.2.0
			const prevEnv = { ...process.env };
			try {
				const outFile = join(dir, "tagged-notes-out.txt");
				process.env.INPUT_WORKING_DIRECTORY = dir;
				process.env.INPUT_REPO_URL = "https://github.com/owner/pkg";
				process.env.GITHUB_OUTPUT = outFile;
				process.env.INPUT_MODE = "release";
				main(["--ci"]);
				const notes = readFileSync(join(dir, "release-notes.md"), "utf8");
				assert.ok(
					notes.includes(
						"- Add network-synchronized signals. ([#16](https://github.com/owner/pkg/pull/16))",
					),
					`expected v0.1.0..v0.2.0 notes, got:\n${notes}`,
				);
				assert.ok(
					notes.includes(
						"**Full Changelog**: [v0.1.0...v0.2.0](https://github.com/owner/pkg/compare/v0.1.0...v0.2.0)",
					),
				);
			} finally {
				restoreEnv(prevEnv);
			}
		});
	});

	test("detects release commits across direct commits, merge commits (HEAD^2), and stamped untagged changelogs", () => {
		withTempDir((dir) => {
			initGitRepo(dir);
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ name: "pkg", version: "0.1.0" }, null, 2),
			);
			writeFileSync(
				join(dir, "CHANGELOG.md"),
				[
					"# Changelog",
					"",
					"## [0.1.0] - 2026-08-01",
					"",
					"### Added",
					"",
					"- Initial release.",
					"",
					"[0.1.0]: https://github.com/owner/pkg/releases/tag/v0.1.0",
					"",
				].join("\n"),
			);
			gitCommit(
				dir,
				"feat: initial release",
				"package.json",
				readFileSync(join(dir, "package.json"), "utf8"),
			);
			execFileSync("git", ["add", "CHANGELOG.md"], { cwd: dir });
			execFileSync("git", ["commit", "--amend", "--no-edit", "--no-gpg-sign"], { cwd: dir });
			// Before v0.1.0 is tagged, a stamped 0.1.0 CHANGELOG.md is detected as an untagged initial release
			assert.deepEqual(detectReleaseCommit(dir, "0.1.0"), {
				isRelease: true,
				version: "0.1.0",
			});
			execFileSync("git", ["tag", "v0.1.0"], { cwd: dir });

			gitCommit(dir, "feat: add feature on main");
			assert.deepEqual(detectReleaseCommit(dir, "0.1.0"), {
				isRelease: false,
				version: undefined,
			});

			// Create release/main branch with `chore: release 0.2.0` and merge with a non-conventional merge commit
			execFileSync("git", ["checkout", "-b", "release/main"], { cwd: dir });
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ name: "pkg", version: "0.2.0" }, null, 2),
			);
			writeFileSync(
				join(dir, "CHANGELOG.md"),
				[
					"# Changelog",
					"",
					"## [0.2.0] - 2026-08-02",
					"",
					"### Added",
					"",
					"- Add feature on main.",
					"",
					"## [0.1.0] - 2026-08-01",
					"",
					"### Added",
					"",
					"- Initial release.",
					"",
					"[0.2.0]: https://github.com/owner/pkg/releases/tag/v0.2.0",
					"[0.1.0]: https://github.com/owner/pkg/releases/tag/v0.1.0",
					"",
				].join("\n"),
			);
			execFileSync("git", ["add", "package.json", "CHANGELOG.md"], { cwd: dir });
			execFileSync("git", ["commit", "--no-gpg-sign", "-m", "chore: release 0.2.0"], {
				cwd: dir,
			});

			execFileSync("git", ["checkout", "main"], { cwd: dir });
			execFileSync(
				"git",
				[
					"merge",
					"--no-ff",
					"--no-gpg-sign",
					"-m",
					"Merge pull request #12 from owner/release/main",
					"release/main",
				],
				{ cwd: dir },
			);

			assert.deepEqual(detectReleaseCommit(dir, "0.2.0"), {
				isRelease: true,
				version: "0.2.0",
			});

			const prevEnv = { ...process.env };
			try {
				const outFile = join(dir, "merge-release-out.txt");
				process.env.INPUT_WORKING_DIRECTORY = dir;
				process.env.INPUT_REPO_URL = "https://github.com/owner/pkg";
				process.env.GITHUB_OUTPUT = outFile;
				process.env.INPUT_MODE = "auto";
				main(["--ci"]);
				const out = readFileSync(outFile, "utf8");
				assert.ok(out.includes("should_release=true"));
				assert.ok(out.includes("version=0.2.0"));

				// Also verify --pr skips opening another PR on the merge commit
				const prOutFile = join(dir, "merge-pr-out.txt");
				process.env.GITHUB_OUTPUT = prOutFile;
				main(["--pr"]);
				assert.ok(readFileSync(prOutFile, "utf8").includes("should_release=false"));
			} finally {
				restoreEnv(prevEnv);
			}
		});
	});

	test("validates PR title in check mode without failing on non-conventional intermediate branch commits", () => {
		withTempDir((dir) => {
			initGitRepo(dir);
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ name: "pkg", version: "0.1.0" }, null, 2),
			);
			writeFileSync(
				join(dir, "CHANGELOG.md"),
				[
					"# Changelog",
					"",
					"## [0.1.0] - 2026-08-01",
					"",
					"### Added",
					"",
					"- Initial release.",
					"",
					"[0.1.0]: https://github.com/owner/pkg/releases/tag/v0.1.0",
					"",
				].join("\n"),
			);
			execFileSync("git", ["add", "package.json", "CHANGELOG.md"], { cwd: dir });
			execFileSync("git", ["commit", "--no-gpg-sign", "-m", "feat: initial release"], {
				cwd: dir,
			});
			execFileSync("git", ["tag", "v0.1.0"], { cwd: dir });

			// Add non-conventional WIP commits on a PR branch
			gitCommit(dir, "wip: half baked");
			gitCommit(dir, "fixup typo in docs");

			const prevEnv = { ...process.env };
			try {
				process.env.INPUT_WORKING_DIRECTORY = dir;
				process.env.INPUT_REPO_URL = "https://github.com/owner/pkg";

				// With a valid PR_TITLE, check mode succeeds despite non-conventional intermediate commits
				process.env.PR_TITLE = "feat: add new feature via squash PR";
				main(["--check"]);

				// With an invalid PR_TITLE, check mode fails
				process.env.PR_TITLE = "Not a conventional title";
				assert.throws(() => main(["--check"]), /invalid Conventional Commit subject/);

				// Without PR_TITLE (e.g. push to main), check mode validates the commit range and fails on WIP commits
				delete process.env.PR_TITLE;
				assert.throws(() => main(["--check"]), /invalid Conventional Commit subject/);
			} finally {
				restoreEnv(prevEnv);
			}
		});
	});

	test("preserves ## [Unreleased] notes in the Release PR body when opening a Release PR", () => {
		withTempDir((dir) => {
			const remoteDir = join(dir, "remote.git");
			const repoDir = join(dir, "repo");
			const binDir = join(dir, "bin");
			mkdirSync(remoteDir, { recursive: true });
			mkdirSync(repoDir, { recursive: true });
			mkdirSync(binDir, { recursive: true });

			execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: remoteDir });
			initGitRepo(repoDir);
			execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });

			writeFileSync(
				join(repoDir, "package.json"),
				JSON.stringify({ name: "pkg", version: "0.1.0" }, null, 2),
			);
			writeFileSync(
				join(repoDir, "CHANGELOG.md"),
				[
					"# Changelog",
					"",
					"## [0.1.0] - 2026-08-01",
					"",
					"### Added",
					"",
					"- Initial release.",
					"",
					"[0.1.0]: https://github.com/owner/pkg/releases/tag/v0.1.0",
					"",
				].join("\n"),
			);
			execFileSync("git", ["add", "package.json", "CHANGELOG.md"], { cwd: repoDir });
			execFileSync("git", ["commit", "--no-gpg-sign", "-m", "feat: initial release"], {
				cwd: repoDir,
			});
			execFileSync("git", ["tag", "v0.1.0"], { cwd: repoDir });
			execFileSync("git", ["push", "-u", "origin", "main", "--tags"], { cwd: repoDir });

			// Add hand-crafted ## [Unreleased] notes and a feat commit
			writeFileSync(
				join(repoDir, "CHANGELOG.md"),
				[
					"# Changelog",
					"",
					"## [Unreleased]",
					"",
					"### Added",
					"",
					"- Hand-written curated changelog entry that must appear in the PR body.",
					"",
					"## [0.1.0] - 2026-08-01",
					"",
					"### Added",
					"",
					"- Initial release.",
					"",
					"[0.1.0]: https://github.com/owner/pkg/releases/tag/v0.1.0",
					"",
				].join("\n"),
			);
			execFileSync("git", ["add", "CHANGELOG.md"], { cwd: repoDir });
			execFileSync("git", ["commit", "--no-gpg-sign", "-m", "feat: raw commit subject"], {
				cwd: repoDir,
			});

			const ghCaptureFile = join(dir, "gh-args.json");
			const fakeGhScript = join(binDir, "fake-gh.mjs");
			const fakeGhPath = join(binDir, "gh");
			writeFileSync(
				fakeGhScript,
				[
					"import { appendFileSync } from 'node:fs';",
					"const args = process.argv.slice(2);",
					`appendFileSync(${JSON.stringify(ghCaptureFile)}, JSON.stringify(args) + "\\n");`,
					"if (args[0] === 'pr' && args[1] === 'list') process.stdout.write('');",
				].join("\n"),
			);
			writeFileSync(
				fakeGhPath,
				`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeGhScript)} "$@"\n`,
			);
			chmodSync(fakeGhPath, 0o755);

			const prevEnv = { ...process.env };
			try {
				process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
				process.env.INPUT_WORKING_DIRECTORY = repoDir;
				process.env.INPUT_REPO_URL = "https://github.com/owner/pkg";
				main(["--pr"]);

				const calls = readFileSync(ghCaptureFile, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				const prCreateCall = calls.find((c) => c[0] === "pr" && c[1] === "create");
				assert.ok(prCreateCall, "expected gh pr create to be called");
				const bodyIdx = prCreateCall.indexOf("--body");
				const prBody = prCreateCall[bodyIdx + 1];
				assert.ok(
					prBody.includes(
						"- Hand-written curated changelog entry that must appear in the PR body.",
					),
					`expected curated Unreleased notes in PR body, got:\n${prBody}`,
				);
				assert.ok(!prBody.includes("- Raw commit subject."));
			} finally {
				restoreEnv(prevEnv);
			}
		});
	});

	test("polls CI workflows via waitForCiWorkflows with retries, fallbacks, and failure handling", () => {
		assert.deepEqual(parseWorkflowRunsResponse(""), { status: "none", conclusion: "none" });
		assert.deepEqual(parseWorkflowRunsResponse(JSON.stringify({ workflow_runs: [] })), {
			status: "none",
			conclusion: "none",
		});
		assert.deepEqual(
			parseWorkflowRunsResponse(
				JSON.stringify({
					workflow_runs: [
						{ run_number: 10, status: "completed", conclusion: "failure" },
						{ run_number: 11, status: "completed", conclusion: "success" },
					],
				}),
			),
			{ status: "completed", conclusion: "success" },
		);

		withTempDir((dir) => {
			initGitRepo(dir);
			gitCommit(dir, "feat: initial");
			const sha = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: dir,
				encoding: "utf8",
			}).trim();

			const prevEnv = { ...process.env };
			try {
				delete process.env.GITHUB_REPOSITORY;
				delete process.env.GITHUB_SHA;
				delete process.env.GITHUB_EVENT_NAME;

				// Empty input is a no-op
				waitForCiWorkflows(dir, "https://github.com/owner/pkg", "  , \n ");

				// Missing slug throws
				assert.throws(
					() =>
						waitForCiWorkflows(dir, "", "ci.yml", 5, {
							execGh: () => undefined,
							sleepSync: () => {},
						}),
					/cannot wait for CI without repository slug and HEAD SHA/,
				);

				// Polls until completed success, using non-push fallback after 2 empty checks
				const queries = [];
				const responses = [
					JSON.stringify({ workflow_runs: [] }),
					JSON.stringify({ workflow_runs: [] }),
					JSON.stringify({ workflow_runs: [] }), // 3rd check triggers fallback query without &event=push
					JSON.stringify({
						workflow_runs: [{ run_number: 1, status: "in_progress", conclusion: null }],
					}), // returned by fallback query
					JSON.stringify({
						workflow_runs: [
							{ run_number: 1, status: "completed", conclusion: "success" },
						],
					}),
				];
				let sleepCount = 0;
				waitForCiWorkflows(dir, "https://github.com/owner/pkg", "ci.yml", 5, {
					execGh: (args) => {
						assert.ok(!args.includes("--jq"), "must not pass --jq to gh api");
						queries.push(args[1]);
						return (
							responses.shift() ??
							JSON.stringify({
								workflow_runs: [
									{ run_number: 1, status: "completed", conclusion: "success" },
								],
							})
						);
					},
					sleepSync: () => {
						sleepCount += 1;
					},
				});
				assert.equal(sleepCount, 3);
				assert.ok(queries[0].endsWith(`runs?head_sha=${sha}&event=push`));
				assert.ok(queries.some((q) => q.endsWith(`runs?head_sha=${sha}`)));

				// Retries transient API errors (< 8) and fails at 8 consecutive errors
				let attempts = 0;
				waitForCiWorkflows(dir, "https://github.com/owner/pkg", "ci.yml", 5, {
					execGh: () => {
						attempts += 1;
						return attempts < 4
							? undefined
							: JSON.stringify({
									workflow_runs: [
										{
											run_number: 1,
											status: "completed",
											conclusion: "success",
										},
									],
								});
					},
					sleepSync: () => {},
				});
				assert.equal(attempts, 4);

				assert.throws(
					() =>
						waitForCiWorkflows(dir, "https://github.com/owner/pkg", "ci.yml", 5, {
							execGh: () => undefined,
							sleepSync: () => {},
						}),
					/after 8 consecutive gh api errors/,
				);

				// Fails after 20 empty responses
				assert.throws(
					() =>
						waitForCiWorkflows(dir, "https://github.com/owner/pkg", "ci.yml", 5, {
							execGh: () => JSON.stringify({ workflow_runs: [] }),
							sleepSync: () => {},
						}),
					/no CI workflow run found for "ci\.yml".*after 5 minutes/,
				);

				// Fails immediately on non-success conclusion
				assert.throws(
					() =>
						waitForCiWorkflows(dir, "https://github.com/owner/pkg", "ci.yml", 5, {
							execGh: () =>
								JSON.stringify({
									workflow_runs: [
										{
											run_number: 1,
											status: "completed",
											conclusion: "failure",
										},
									],
								}),
							sleepSync: () => {},
						}),
					/CI workflow "ci\.yml" concluded "failure"/,
				);
			} finally {
				restoreEnv(prevEnv);
			}
		});
	});

	test("cleans up remote release/main branch on release, non-releasable commits, and failed PR creation", () => {
		withTempDir((dir) => {
			const remoteDir = join(dir, "remote.git");
			const repoDir = join(dir, "repo");
			const binDir = join(dir, "bin");
			mkdirSync(remoteDir, { recursive: true });
			mkdirSync(repoDir, { recursive: true });
			mkdirSync(binDir, { recursive: true });

			execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: remoteDir });
			initGitRepo(repoDir);
			execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });

			writeFileSync(
				join(repoDir, "package.json"),
				JSON.stringify({ name: "pkg", version: "0.1.0" }, null, 2),
			);
			execFileSync("git", ["add", "package.json"], { cwd: repoDir });
			execFileSync("git", ["commit", "--no-gpg-sign", "-m", "feat: initial release"], {
				cwd: repoDir,
			});
			execFileSync("git", ["tag", "v0.1.0"], { cwd: repoDir });
			execFileSync("git", ["push", "-u", "origin", "main", "--tags"], { cwd: repoDir });

			// Add a releasable commit so --pr attempts to push release/main and open a PR
			gitCommit(repoDir, "feat: add feature");

			// 1. If gh pr create fails (with no existing PR), release/main is rolled back from origin
			const failingGhScript = join(binDir, "fail-gh.mjs");
			const fakeGhPath = join(binDir, "gh");
			writeFileSync(
				failingGhScript,
				[
					"const args = process.argv.slice(2);",
					"if (args[0] === 'pr' && args[1] === 'list') { process.stdout.write('[]'); process.exit(0); }",
					"if (args[0] === 'pr' && args[1] === 'create') { process.stderr.write('createPullRequest forbidden\\n'); process.exit(1); }",
					"process.exit(1);",
				].join("\n"),
			);
			writeFileSync(
				fakeGhPath,
				`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(failingGhScript)} "$@"\n`,
			);
			chmodSync(fakeGhPath, 0o755);

			const hasRemoteReleaseBranch = () => {
				const out = execFileSync(
					"git",
					["ls-remote", "--heads", remoteDir, "refs/heads/release/main"],
					{ encoding: "utf8" },
				).trim();
				return out.length > 0;
			};

			const prevEnv = { ...process.env };
			try {
				process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
				process.env.INPUT_WORKING_DIRECTORY = repoDir;
				process.env.INPUT_REPO_URL = "https://github.com/owner/pkg";
				process.env.GH_TOKEN = "test-token";

				assert.throws(() => main(["--pr"]), /Command failed: gh pr create/);
				assert.equal(
					hasRemoteReleaseBranch(),
					false,
					"expected release/main to be deleted from origin when gh pr create fails",
				);

				// Switch back to main and make gh succeed so release/main is created on origin
				execFileSync("git", ["checkout", "main"], { cwd: repoDir });
				writeFileSync(
					failingGhScript,
					[
						"const args = process.argv.slice(2);",
						"if (args[0] === 'pr' && args[1] === 'list') { process.stdout.write('[]'); process.exit(0); }",
						"if (args[0] === 'pr' && args[1] === 'create') { process.exit(0); }",
						"process.exit(1);",
					].join("\n"),
				);
				main(["--pr"]);
				assert.equal(
					hasRemoteReleaseBranch(),
					true,
					"expected release/main to exist on origin while Release PR is open",
				);

				// 2. Simulate squash-merging the release commit onto main without GitHub auto-deleting release/main
				execFileSync("git", ["checkout", "main"], { cwd: repoDir });
				writeFileSync(
					join(repoDir, "package.json"),
					JSON.stringify({ name: "pkg", version: "0.2.0" }, null, 2),
				);
				execFileSync("git", ["add", "package.json"], { cwd: repoDir });
				execFileSync(
					"git",
					["commit", "--no-gpg-sign", "-m", "chore: release 0.2.0 (#1)"],
					{ cwd: repoDir },
				);
				process.env.INPUT_MODE = "auto";
				main(["--ci"]);
				assert.equal(
					hasRemoteReleaseBranch(),
					false,
					"expected runReleaseMode to delete stale release/main branch from origin",
				);

				// 3. If release/main is left over when there are no releasable commits, --pr cleans it up
				execFileSync("git", ["tag", "v0.2.0"], { cwd: repoDir });
				execFileSync("git", ["push", "origin", "HEAD:refs/heads/release/main"], {
					cwd: repoDir,
				});
				assert.equal(hasRemoteReleaseBranch(), true);
				gitCommit(repoDir, "docs: update readme");
				main(["--pr"]);
				assert.equal(
					hasRemoteReleaseBranch(),
					false,
					"expected runPullRequestFlow to delete stale release/main when no releasable commits exist",
				);
			} finally {
				restoreEnv(prevEnv);
			}
		});
	});
});
