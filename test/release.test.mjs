import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
	appendGithubReleaseSections,
	buildChangelogFromCommits,
	bumpRepoVersionFiles,
	detectRepoVersion,
	extractGithubReleaseSections,
	extractReleaseNotes,
	formatBullet,
	isValidSemverStep,
	main,
	parseSemver,
	prepareRelease,
	readCommitsInRange,
	resolveTargetVersion,
	todayIsoDate,
	validateCommitSubject,
	validateReleaseState,
} from "../release.mjs";

function withTempDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), "release-test-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
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
		const res0x = buildChangelogFromCommits("0.3.0", [
			{ subject: "refactor!: drop legacy configuration format" },
			{
				subject: "fix: tighten path check",
				body: "BREAKING CHANGE: reject relative paths outside workspace",
			},
			{ subject: "fix: resolve generic type linking" },
			{ subject: "security: escape shell metacharacters" },
			{ subject: "perf: cache regex compilation" },
			{ subject: "docs: tighten guides" },
			{ subject: 'Revert "feat: experimental flag"' },
			{ subject: "chore: release 0.3.0 (#42)" },
		]);
		assert.equal(res0x.bump, "patch");
		assert.equal(
			res0x.markdown,
			[
				"### Changed",
				"",
				"- Drop legacy configuration format.",
				"- Reject relative paths outside workspace.",
				"- Cache regex compilation.",
				"",
				"### Fixed",
				"",
				"- Resolve generic type linking.",
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
			[{ subject: "Merge branch main" }, { subject: "fix: handle edge case" }],
			{ strict: false },
		);
		assert.equal(nonStrict.bump, "patch");
		assert.match(nonStrict.markdown, /- Handle edge case\./);
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
		assert.equal(formatBullet("pkg.scope cleanup"), "pkg.scope cleanup.");
		assert.equal(formatBullet("already punctuated!"), "Already punctuated!");
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
			assert.deepEqual(commits, [{ subject: "feat: add new widget", body: "" }]);

			const prevEnv = { ...process.env };
			try {
				process.env.INPUT_WORKING_DIRECTORY = dir;
				process.env.INPUT_REPO_URL = "https://github.com/owner/pkg";
				process.env.PR_TITLE = 'Revert "feat: add new widget"';
				main(["--check"]);

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
				assert.ok(notesText.includes("### Added\n\n- Add new widget."));
				assert.ok(
					notesText.includes(
						"**Full Changelog**: https://github.com/owner/pkg/compare/v0.1.0...v0.2.0",
					),
				);
			} finally {
				process.env = prevEnv;
			}
		});
	});

	test("extracts and appends GitHub New Contributors and Full Changelog sections", () => {
		const ghGenerated = [
			"## What's Changed",
			"* feat: add new widget by @alice in https://github.com/owner/pkg/pull/7",
			"",
			"## New Contributors",
			"* @alice made their first contribution in https://github.com/owner/pkg/pull/7",
			"",
			"**Full Changelog**: https://github.com/owner/pkg/compare/v0.1.0...v0.2.0",
		].join("\n");

		const extracted = extractGithubReleaseSections(ghGenerated);
		assert.deepEqual(extracted, {
			newContributors:
				"## New Contributors\n* @alice made their first contribution in https://github.com/owner/pkg/pull/7",
			fullChangelog: "**Full Changelog**: https://github.com/owner/pkg/compare/v0.1.0...v0.2.0",
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
				"## New Contributors",
				"* @alice made their first contribution in https://github.com/owner/pkg/pull/7",
				"",
				"**Full Changelog**: https://github.com/owner/pkg/compare/v0.1.0...v0.2.0",
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
				"**Full Changelog**: https://github.com/owner/pkg/compare/v0.1.0...v0.1.1",
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
				"**Full Changelog**: https://github.com/owner/pkg/commits/v0.1.0",
				"",
			].join("\n"),
		);
	});
});
