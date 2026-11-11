import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, test } from "node:test";
import * as publicApi from "../release.mjs";
import { main } from "../src/cli.mjs";
import {
	buildGitEnv,
	detectReleaseCommit,
	execGitOrThrow,
	readCommitsInRange,
	resolvePreviousReleaseTag,
	sanitizeRemoteUrl,
} from "../src/git.mjs";
import { publishGithubRelease, verifySha256Sums } from "../src/github.mjs";
import { detectRepoVersion } from "../src/manifests.mjs";
import {
	captureStderr,
	captureStdout,
	gitCommit,
	initGitRepo,
	installFakeGh,
	makeRemotePair,
	parseGitHubOutputs,
	sha256Hex,
	withEnv,
	withTempDir,
} from "./helpers.mjs";

const silentLog = () => {};

describe("end-to-end CLI & GitHub Action workflows", () => {
	test("exposes exact intentional public library exports on release.mjs", () => {
		assert.deepEqual(Object.keys(publicApi).sort(), [
			"buildChangelogFromCommits",
			"bumpRepoVersionFiles",
			"compareSemver",
			"detectRepoVersion",
			"extractReleaseNotes",
			"isValidSemverStep",
			"parseSemver",
			"prepareRelease",
			"publishGithubRelease",
			"resolveTargetVersion",
			"validateCommitSubject",
			"validateReleaseState",
			"verifySha256Sums",
		]);
	});

	test("sanitizes remote URLs and passes Git HTTP credentials via env without leaking tokens in errors", () => {
		assert.equal(
			sanitizeRemoteUrl("https://x-access-token:ghs_SUPER_SECRET@github.com/owner/repo.git"),
			"https://github.com/owner/repo",
		);
		assert.equal(
			sanitizeRemoteUrl("ssh://git@github.com:2222/owner/repo.git/"),
			"https://github.com/owner/repo",
		);
		assert.equal(
			sanitizeRemoteUrl("git@github.com:owner/repo.git"),
			"https://github.com/owner/repo",
		);
		assert.equal(sanitizeRemoteUrl("/tmp/local-bare-remote.git"), undefined);
		assert.equal(sanitizeRemoteUrl("file:///tmp/local-bare-remote.git"), undefined);

		withTempDir((dir) => {
			initGitRepo(dir);
			gitCommit(dir, "feat: init");
			const env = buildGitEnv({ auth: true, token: "ghs_TOP_SECRET_TOKEN_999" });
			assert.equal(env.GIT_TERMINAL_PROMPT, "0");
			assert.ok(
				Object.values(env).some(
					(v) =>
						typeof v === "string" &&
						v.includes(
							Buffer.from("x-access-token:ghs_TOP_SECRET_TOKEN_999").toString("base64"),
						),
				),
			);

			// Pushing to a non-existent remote fails WITHOUT leaking token or base64 header in error.message!
			let caught;
			try {
				execGitOrThrow(dir, ["push", "nonexistent-origin", "HEAD"], {
					auth: true,
					token: "ghs_TOP_SECRET_TOKEN_999",
				});
			} catch (err) {
				caught = err;
			}
			assert.ok(caught);
			const b64 = Buffer.from("x-access-token:ghs_TOP_SECRET_TOKEN_999").toString("base64");
			assert.ok(!caught.message.includes("ghs_TOP_SECRET_TOKEN_999"));
			assert.ok(!caught.message.includes(b64));
		});
	});

	test("automatically unshallows shallow checkouts (fetch-depth: 1) and fetches tags", () => {
		withTempDir((dir) => {
			const { remoteDir, repoDir } = makeRemotePair(dir);
			writeFileSync(
				join(repoDir, "package.json"),
				JSON.stringify({ name: "pkg", version: "0.1.0" }, null, 2) + "\n",
			);
			execFileSync("git", ["add", "package.json"], { cwd: repoDir, stdio: "pipe" });
			execFileSync("git", ["commit", "--no-gpg-sign", "-m", "feat: initial release"], {
				cwd: repoDir,
				stdio: "pipe",
			});
			execFileSync("git", ["tag", "v0.1.0"], { cwd: repoDir, stdio: "pipe" });
			gitCommit(repoDir, "feat: second commit");
			gitCommit(repoDir, "fix: third commit");
			execFileSync("git", ["push", "-u", "origin", "main", "--tags"], {
				cwd: repoDir,
				stdio: "pipe",
			});

			// Clone with --depth 1 --no-tags (exact default behavior of actions/checkout!)
			const shallowDir = join(dir, "shallow");
			execFileSync(
				"git",
				["clone", "--depth", "1", "--no-tags", pathToFileURL(remoteDir).href, shallowDir],
				{ stdio: "pipe" },
			);
			assert.equal(
				execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
					cwd: shallowDir,
					encoding: "utf8",
				}).trim(),
				"true",
			);

			withEnv(
				{
					"INPUT_WORKING-DIRECTORY": shallowDir,
					"INPUT_REPO-URL": "https://github.com/owner/pkg",
				},
				() => {
					main(["--check"], { log: silentLog });
					assert.equal(
						execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
							cwd: shallowDir,
							encoding: "utf8",
						}).trim(),
						"false",
					);
					const notes = captureStdout(() => main(["--notes"], { log: silentLog }));
					assert.match(notes, /Second commit\./);
					assert.match(notes, /Third commit\./);
				},
			);

			// Shallow clone without origin fails with an actionable error
			const orphanShallow = join(dir, "orphan-shallow");
			execFileSync(
				"git",
				["clone", "--depth", "1", pathToFileURL(remoteDir).href, orphanShallow],
				{ stdio: "pipe" },
			);
			execFileSync("git", ["remote", "remove", "origin"], {
				cwd: orphanShallow,
				stdio: "pipe",
			});
			withEnv({ "INPUT_WORKING-DIRECTORY": orphanShallow }, () => {
				assert.throws(
					() => main(["--check"], { log: silentLog }),
					/shallow git repository detected with no 'origin' remote/,
				);
			});
		});
	});

	test("runs CLI bump, check, native node24 Action mode, auto dry-run detection, and step summaries", () => {
		withTempDir((dir) => {
			// --help works outside git
			const helpOut = captureStderr(() =>
				withEnv({ INPUT_WORKING_DIRECTORY: dir }, () => main(["--help"], { log: silentLog })),
			);
			assert.match(helpOut, /usage: release/);

			initGitRepo(dir);
			writeFileSync(
				join(dir, "wally.toml"),
				'[package]\nname = "owner/pkg"\nversion = "0.1.0"\n',
			);
			// Unborn HEAD succeeds in --check
			withEnv({ INPUT_WORKING_DIRECTORY: dir }, () => {
				main(["--check"], { log: silentLog });
			});

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
			execFileSync("git", ["add", "wally.toml", "CHANGELOG.md"], { cwd: dir, stdio: "pipe" });
			execFileSync("git", ["commit", "--no-gpg-sign", "-m", "feat: initial release"], {
				cwd: dir,
				stdio: "pipe",
			});
			execFileSync("git", ["tag", "v0.1.0"], { cwd: dir, stdio: "pipe" });
			execFileSync("git", ["tag", "-a", "v0", "-m", "v0"], { cwd: dir, stdio: "pipe" });
			gitCommit(dir, "feat: add new widget");

			assert.throws(() => readCommitsInRange(dir, "--output=/tmp/bad"), /invalid git range/);
			const commits = readCommitsInRange(dir, "v0.1.0..HEAD");
			assert.equal(commits.length, 1);
			assert.equal(commits[0].subject, "feat: add new widget");

			// Rejects bumping to an already-tagged version
			withEnv({ INPUT_WORKING_DIRECTORY: dir }, () => {
				assert.throws(
					() => main(["0.1.0"], { log: silentLog }),
					/already tagged as v0\.1\.0/,
				);
			});

			// Auto-detects workflow_dispatch inputs.dry_run from $GITHUB_EVENT_PATH AND previews pending commits even when CHANGELOG.md exists!
			const dispatchEventPath = join(dir, "dispatch-event.json");
			writeFileSync(dispatchEventPath, JSON.stringify({ inputs: { dry_run: true } }));
			const autoDryOut = join(dir, "auto-dry-out.txt");
			const autoDrySummary = join(dir, "auto-dry-summary.md");
			withEnv(
				{
					GITHUB_ACTIONS: "true",
					GITHUB_EVENT_NAME: "workflow_dispatch",
					GITHUB_EVENT_PATH: dispatchEventPath,
					GITHUB_OUTPUT: autoDryOut,
					GITHUB_STEP_SUMMARY: autoDrySummary,
					INPUT_MODE: "auto",
					"INPUT_WORKING-DIRECTORY": dir,
					"INPUT_REPO-URL": "https://github.com/owner/pkg",
				},
				() => {
					// Invoked with empty argv [] just like native node24 runner!
					main([], { log: silentLog });
				},
			);
			const dryOutputs = parseGitHubOutputs(autoDryOut);
			assert.equal(dryOutputs.should_release, "false");
			assert.equal(dryOutputs.dry_run, "true");
			assert.equal(dryOutputs.should_build, "true");
			// Keeps checked-out manifest version (0.1.0) so downstream `z --version` smoke tests pass!
			assert.equal(dryOutputs.version, "0.1.0");
			assert.match(readFileSync(join(dir, "release-notes.md"), "utf8"), /Add new widget\./);
			assert.match(readFileSync(autoDrySummary, "utf8"), /### Dry run:/);

			// Check mode stays silent on $GITHUB_STEP_SUMMARY
			const checkSummary = join(dir, "check-summary.md");
			withEnv(
				{
					GITHUB_STEP_SUMMARY: checkSummary,
					INPUT_WORKING_DIRECTORY: dir,
					PR_TITLE: 'Revert "feat: add new widget"',
				},
				() => {
					main(["--check"], { log: silentLog });
				},
			);
			assert.equal(existsSync(checkSummary), false);

			// Local bump `release minor` -> re-bump `release 0.2.0` -> release commit flow
			withEnv(
				{
					INPUT_WORKING_DIRECTORY: dir,
					INPUT_REPO_URL: "https://github.com/owner/pkg",
				},
				() => {
					main(["minor"], { log: silentLog });
					assert.equal(detectRepoVersion(dir).version, "0.2.0");
					assert.ok(
						readFileSync(join(dir, "CHANGELOG.md"), "utf8").includes("## [0.2.0]"),
					);
				},
			);

			execFileSync("git", ["add", "wally.toml", "CHANGELOG.md"], { cwd: dir, stdio: "pipe" });
			execFileSync("git", ["commit", "--no-gpg-sign", "-m", "chore: release 0.2.0 (#7)"], {
				cwd: dir,
				stdio: "pipe",
			});

			const relOutFile = join(dir, "rel-out.txt");
			const relSummary = join(dir, "rel-summary.md");
			withEnv(
				{
					GITHUB_ACTIONS: "true",
					GITHUB_OUTPUT: relOutFile,
					GITHUB_STEP_SUMMARY: relSummary,
					INPUT_MODE: "auto",
					"INPUT_WORKING-DIRECTORY": dir,
					"INPUT_REPO-URL": "https://github.com/owner/pkg",
				},
				() => {
					main([], { log: silentLog });
				},
			);
			const relOutputs = parseGitHubOutputs(relOutFile);
			assert.equal(relOutputs.should_release, "true");
			assert.equal(relOutputs.should_build, "true");
			assert.equal(relOutputs.dry_run, "false");
			assert.equal(relOutputs.version, "0.2.0");
			assert.equal(relOutputs.tag, "v0.2.0");
			assert.match(readFileSync(relSummary, "utf8"), /### Release ready: `v0\.2\.0`/);
		});
	});

	test("validates PR titles in check mode and detects release commits across merges, changelogs, and changelog-less bumps", () => {
		withTempDir((dir) => {
			initGitRepo(dir);
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ name: "pkg", version: "0.1.0" }, null, 2) + "\n",
			);
			execFileSync("git", ["add", "package.json"], { cwd: dir, stdio: "pipe" });
			execFileSync("git", ["commit", "--no-gpg-sign", "-m", "feat: initial release"], {
				cwd: dir,
				stdio: "pipe",
			});
			execFileSync("git", ["tag", "v0.1.0"], { cwd: dir, stdio: "pipe" });

			gitCommit(dir, "wip: half baked");
			withEnv({ INPUT_WORKING_DIRECTORY: dir, PR_TITLE: "feat: squash title" }, () => {
				main(["--check"], { log: silentLog });
			});
			withEnv({ INPUT_WORKING_DIRECTORY: dir, PR_TITLE: "Bad PR title" }, () => {
				assert.throws(() => main(["--check"], { log: silentLog }), /Conventional Commit/);
			});
			withEnv({ INPUT_WORKING_DIRECTORY: dir }, () => {
				assert.throws(() => main(["--check"], { log: silentLog }), /Conventional Commit/);
			});

			// Changelog-less manual manifest bump on main is detected as a release commit!
			execFileSync("git", ["reset", "--hard", "v0.1.0"], { cwd: dir, stdio: "pipe" });
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ name: "pkg", version: "0.2.0" }, null, 2) + "\n",
			);
			execFileSync("git", ["add", "package.json"], { cwd: dir, stdio: "pipe" });
			execFileSync("git", ["commit", "--no-gpg-sign", "-m", "feat: manual bump to 0.2.0"], {
				cwd: dir,
				stdio: "pipe",
			});
			assert.deepEqual(detectReleaseCommit(dir, "0.2.0", { trackedFiles: ["package.json"] }), {
				isRelease: true,
				version: "0.2.0",
			});

			// Multi-commit merge PR (`HEAD^1..HEAD^2`) is also detected
			execFileSync("git", ["tag", "v0.2.0"], { cwd: dir, stdio: "pipe" });
			execFileSync("git", ["checkout", "-b", "release/main"], { cwd: dir, stdio: "pipe" });
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ name: "pkg", version: "0.3.0" }, null, 2) + "\n",
			);
			execFileSync("git", ["add", "package.json"], { cwd: dir, stdio: "pipe" });
			execFileSync("git", ["commit", "--no-gpg-sign", "-m", "chore: release 0.3.0"], {
				cwd: dir,
				stdio: "pipe",
			});
			gitCommit(dir, "docs: follow-up commit on release PR branch");
			execFileSync("git", ["checkout", "main"], { cwd: dir, stdio: "pipe" });
			execFileSync(
				"git",
				["merge", "--no-ff", "--no-gpg-sign", "-m", "Merge PR #15", "release/main"],
				{ cwd: dir, stdio: "pipe" },
			);
			assert.deepEqual(detectReleaseCommit(dir, "0.3.0"), {
				isRelease: true,
				version: "0.3.0",
			});
		});
	});

	test("creates Release PRs via pure Git plumbing without mutating the working tree, outputs pr_url/pr_number, and cleans up branches", () => {
		withTempDir((dir) => {
			const { remoteDir, repoDir, binDir } = makeRemotePair(dir);
			writeFileSync(
				join(repoDir, "package.json"),
				JSON.stringify({ name: "pkg", version: "0.1.0" }, null, 2) + "\n",
			);
			writeFileSync(
				join(repoDir, "CHANGELOG.md"),
				[
					"# Changelog",
					"",
					"## [Unreleased]",
					"",
					"### Added",
					"",
					"- Curated unreleased note.",
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
			execFileSync("git", ["add", "package.json", "CHANGELOG.md"], {
				cwd: repoDir,
				stdio: "pipe",
			});
			execFileSync("git", ["commit", "--no-gpg-sign", "-m", "feat: initial"], {
				cwd: repoDir,
				stdio: "pipe",
			});
			execFileSync("git", ["tag", "v0.1.0"], { cwd: repoDir, stdio: "pipe" });
			execFileSync("git", ["push", "-u", "origin", "main", "--tags"], {
				cwd: repoDir,
				stdio: "pipe",
			});
			gitCommit(repoDir, "feat: add feature");

			// Leave an untracked/dirty scratch marker in working tree to verify working tree is NEVER touched!
			writeFileSync(join(repoDir, "untracked-local.txt"), "keep-me\n");

			const hasRemoteReleaseBranch = () =>
				execFileSync(
					"git",
					["ls-remote", "--heads", remoteDir, "refs/heads/release/main"],
					{ encoding: "utf8" },
				).trim().length > 0;

			// 1. Rollback remote release/main when gh pr create fails
			const failingGh = installFakeGh(binDir, [
				"if (args[0] === 'pr' && args[1] === 'list') { process.stdout.write('[]'); process.exit(0); }",
				"if (args[0] === 'pr' && args[1] === 'create') { process.stderr.write('forbidden\\n'); process.exit(1); }",
				"process.exit(0);",
			]);
			withEnv(
				{
					PATH: failingGh.pathEnv,
					INPUT_WORKING_DIRECTORY: repoDir,
					INPUT_REPO_URL: "https://github.com/owner/pkg",
					GH_TOKEN: "test-token",
				},
				() => {
					assert.throws(
						() => main(["--pr"], { log: silentLog }),
						/Command failed: gh pr create/,
					);
					assert.equal(hasRemoteReleaseBranch(), false);
				},
			);

			// Working tree package.json is STILL 0.1.0 and HEAD is STILL main!
			assert.equal(
				JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")).version,
				"0.1.0",
			);
			assert.equal(readFileSync(join(repoDir, "untracked-local.txt"), "utf8"), "keep-me\n");

			// 2. Succeeds, pushes release/main via Git plumbing, preserves curated Unreleased notes, and outputs pr_url & pr_number
			const okGh = installFakeGh(binDir, [
				"if (args[0] === 'pr' && args[1] === 'list') { process.stdout.write('[]'); process.exit(0); }",
				"if (args[0] === 'pr' && args[1] === 'create') { process.stdout.write('https://github.com/owner/pkg/pull/55\\n'); process.exit(0); }",
				"process.exit(0);",
			]);
			const prOutFile = join(dir, "pr-out.txt");
			const prSummaryFile = join(dir, "pr-summary.md");
			withEnv(
				{
					PATH: okGh.pathEnv,
					GITHUB_OUTPUT: prOutFile,
					GITHUB_STEP_SUMMARY: prSummaryFile,
					INPUT_WORKING_DIRECTORY: repoDir,
					INPUT_REPO_URL: "https://github.com/owner/pkg",
					GH_TOKEN: "test-token",
				},
				() => {
					main(["--pr"], { log: silentLog });
				},
			);
			assert.equal(hasRemoteReleaseBranch(), true);
			// Working tree package.json was NEVER mutated on main!
			assert.equal(
				JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")).version,
				"0.1.0",
			);
			// Remote release/main commit has bumped package.json (0.2.0) and stamped CHANGELOG.md!
			execFileSync("git", ["fetch", "origin", "refs/heads/release/main"], {
				cwd: repoDir,
				stdio: "pipe",
			});
			const remotePkg = JSON.parse(
				execFileSync("git", ["show", "FETCH_HEAD:package.json"], {
					cwd: repoDir,
					encoding: "utf8",
				}),
			);
			assert.equal(remotePkg.version, "0.2.0");

			const prOutputs = parseGitHubOutputs(prOutFile);
			assert.equal(prOutputs.should_release, "false");
			assert.equal(prOutputs.should_build, "false");
			assert.equal(prOutputs.pr_number, "55");
			assert.equal(prOutputs.pr_url, "https://github.com/owner/pkg/pull/55");
			assert.match(readFileSync(prSummaryFile, "utf8"), /Curated unreleased note\./);
		});
	});

	test("bumps past non-ancestor rolled-back tags and keeps CHANGELOG.md valid across subsequent releases", () => {
		withTempDir((dir) => {
			const { repoDir, binDir } = makeRemotePair(dir);
			const changelog0190 = [
				"# Changelog",
				"",
				"## [0.19.0] - 2026-08-01",
				"",
				"### Added",
				"",
				"- Release 0.19.0.",
				"",
				"[0.19.0]: https://github.com/owner/pkg/releases/tag/v0.19.0",
				"",
			].join("\n");
			writeFileSync(
				join(repoDir, "package.json"),
				JSON.stringify({ name: "pkg", version: "0.19.0" }, null, 2) + "\n",
			);
			writeFileSync(join(repoDir, "CHANGELOG.md"), changelog0190);
			execFileSync("git", ["add", "package.json", "CHANGELOG.md"], {
				cwd: repoDir,
				stdio: "pipe",
			});
			execFileSync("git", ["commit", "--no-gpg-sign", "-m", "chore: release 0.19.0"], {
				cwd: repoDir,
				stdio: "pipe",
			});
			execFileSync("git", ["tag", "v0.19.0"], { cwd: repoDir, stdio: "pipe" });

			gitCommit(repoDir, "fix: first fix in 0.19.1");
			const baseMainSha = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: repoDir,
				encoding: "utf8",
			}).trim();

			writeFileSync(
				join(repoDir, "package.json"),
				JSON.stringify({ name: "pkg", version: "0.19.1" }, null, 2) + "\n",
			);
			execFileSync("git", ["add", "package.json"], { cwd: repoDir, stdio: "pipe" });
			execFileSync("git", ["commit", "--no-gpg-sign", "-m", "chore: release 0.19.1"], {
				cwd: repoDir,
				stdio: "pipe",
			});
			execFileSync("git", ["tag", "v0.19.1"], { cwd: repoDir, stdio: "pipe" });
			execFileSync("git", ["reset", "--hard", baseMainSha], { cwd: repoDir, stdio: "pipe" });

			gitCommit(repoDir, "fix: second fix after 0.19.1");
			execFileSync("git", ["push", "-u", "origin", "main", "--tags"], {
				cwd: repoDir,
				stdio: "pipe",
			});

			const fakeGh = installFakeGh(binDir, [
				"if (args[0] === 'pr' && args[1] === 'list') { process.stdout.write('[]'); process.exit(0); }",
				"if (args[0] === 'pr' && args[1] === 'create') { process.stdout.write('https://github.com/owner/pkg/pull/10\\n'); process.exit(0); }",
				"process.exit(0);",
			]);

			withEnv(
				{
					PATH: fakeGh.pathEnv,
					INPUT_WORKING_DIRECTORY: repoDir,
					INPUT_REPO_URL: "https://github.com/owner/pkg",
					GH_TOKEN: "test-token",
				},
				() => {
					// Stamp 0.19.2 locally over 0.19.0 (bridged by non-ancestor tag v0.19.1), then verify --check AND a subsequent 0.19.3 bump both succeed!
					main(["patch"], { log: silentLog });
					assert.equal(detectRepoVersion(repoDir).version, "0.19.2");
					main(["--check"], { log: silentLog });

					execFileSync("git", ["add", "package.json", "CHANGELOG.md"], {
						cwd: repoDir,
						stdio: "pipe",
					});
					execFileSync(
						"git",
						["commit", "--no-gpg-sign", "-m", "chore: release 0.19.2"],
						{ cwd: repoDir, stdio: "pipe" },
					);
					execFileSync("git", ["tag", "v0.19.2"], { cwd: repoDir, stdio: "pipe" });

					gitCommit(repoDir, "fix: third fix for 0.19.3");
					main(["patch"], { log: silentLog });
					assert.equal(detectRepoVersion(repoDir).version, "0.19.3");
					main(["--check"], { log: silentLog });
				},
			);
		});
	});

	test("generates and verifies SHA256SUMS, validates dry-run publish assets, and guards historical tags / --latest / floating vN", () => {
		withTempDir((dir) => {
			const { remoteDir, repoDir, binDir } = makeRemotePair(dir);
			writeFileSync(
				join(repoDir, "package.json"),
				JSON.stringify({ name: "pkg", version: "1.1.0" }, null, 2) + "\n",
			);
			execFileSync("git", ["add", "package.json"], { cwd: repoDir, stdio: "pipe" });
			execFileSync("git", ["commit", "--no-gpg-sign", "-m", "chore: release 1.1.0"], {
				cwd: repoDir,
				stdio: "pipe",
			});
			const v110Sha = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: repoDir,
				encoding: "utf8",
			}).trim();
			execFileSync("git", ["tag", "v1.1.0"], { cwd: repoDir, stdio: "pipe" });

			// Create newer v1.2.0 and v2.0.0 tags so v1.1.0 is a historical backport!
			writeFileSync(
				join(repoDir, "package.json"),
				JSON.stringify({ name: "pkg", version: "1.2.0" }, null, 2) + "\n",
			);
			gitCommit(repoDir, "chore: release 1.2.0", "package.json", readFileSync(join(repoDir, "package.json"), "utf8"));
			const v120Sha = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: repoDir,
				encoding: "utf8",
			}).trim();
			execFileSync("git", ["tag", "v1.2.0"], { cwd: repoDir, stdio: "pipe" });
			execFileSync("git", ["tag", "-fa", "v1", "-m", "v1", v120Sha], {
				cwd: repoDir,
				stdio: "pipe",
			});

			writeFileSync(
				join(repoDir, "package.json"),
				JSON.stringify({ name: "pkg", version: "2.0.0" }, null, 2) + "\n",
			);
			gitCommit(repoDir, "chore: release 2.0.0", "package.json", readFileSync(join(repoDir, "package.json"), "utf8"));
			execFileSync("git", ["tag", "v2.0.0"], { cwd: repoDir, stdio: "pipe" });
			execFileSync("git", ["push", "-u", "origin", "main", "--tags"], {
				cwd: repoDir,
				stdio: "pipe",
			});

			// Build assets in dist/ (including a hidden .DS_Store that `*` must ignore!)
			const distDir = join(repoDir, "dist", "nested");
			mkdirSync(distDir, { recursive: true });
			const assetA = join(repoDir, "dist", "pkg-2.0.0-linux.tar.gz");
			const assetB = join(distDir, "pkg.rbxm");
			writeFileSync(assetA, "linux-binary");
			writeFileSync(assetB, "rbxm-binary");
			writeFileSync(join(repoDir, "dist", ".DS_Store"), "junk");

			const fakeGh = installFakeGh(binDir, [
				"if (args[0] === 'release' && args[1] === 'view') { process.exit(1); }",
				"if (args[0] === 'release' && args[1] === 'create') { process.stdout.write('https://github.com/owner/pkg/releases/tag/' + args[2] + '\\n'); process.exit(0); }",
				"if (args[0] === 'api') { process.stdout.write(JSON.stringify({ body: '' })); process.exit(0); }",
				"process.exit(0);",
			]);

			// 1. Dry-run mode: publish generates & verifies SHA256SUMS and writes summary WITHOUT calling gh release create!
			const dryPubOut = join(dir, "dry-pub-out.txt");
			const dryPubSummary = join(dir, "dry-pub-summary.md");
			withEnv(
				{
					PATH: fakeGh.pathEnv,
					GITHUB_OUTPUT: dryPubOut,
					GITHUB_STEP_SUMMARY: dryPubSummary,
					INPUT_MODE: "publish",
					"INPUT_DRY-RUN": "true",
					INPUT_TITLE: "Pkg {version}",
					INPUT_FILES: "dist/pkg-{version}-*, dist/**/*.rbxm",
					INPUT_CHECKSUMS: "dist/SHA256SUMS",
					"INPUT_WORKING-DIRECTORY": repoDir,
					"INPUT_REPO-URL": "https://github.com/owner/pkg",
				},
				() => {
					main(["--ci"], { log: silentLog });
				},
			);
			assert.equal(fakeGh.readCalls().length, 1); // Only generate-notes API, zero `release create`!
			const sumsPath = join(repoDir, "dist", "SHA256SUMS");
			assert.equal(existsSync(sumsPath), true);
			verifySha256Sums(sumsPath);
			const sumsText = readFileSync(sumsPath, "utf8");
			assert.ok(sumsText.includes(`${sha256Hex(assetA)}  pkg-2.0.0-linux.tar.gz`));
			assert.ok(sumsText.includes(`${sha256Hex(assetB)}  nested/pkg.rbxm`));
			assert.ok(!sumsText.includes(".DS_Store"));
			assert.match(readFileSync(dryPubSummary, "utf8"), /pkg-2\.0\.0-linux\.tar\.gz/);

			// 2. Live publish of v2.0.0 marks --latest, outputs release_url, and pushes v2 major tag
			rmSync(sumsPath);
			const livePubOut = join(dir, "live-pub-out.txt");
			withEnv(
				{
					PATH: fakeGh.pathEnv,
					GITHUB_OUTPUT: livePubOut,
					INPUT_MODE: "publish",
					INPUT_TITLE: "Pkg {version} ({tag})",
					INPUT_FILES: "dist/pkg-{version}-*, dist/**/*.rbxm",
					INPUT_CHECKSUMS: "true",
					"INPUT_MAJOR-TAG": "true",
					"INPUT_WORKING-DIRECTORY": repoDir,
					"INPUT_REPO-URL": "https://github.com/owner/pkg",
				},
				() => {
					main(["--ci"], { log: silentLog });
				},
			);
			const liveOutputs = parseGitHubOutputs(livePubOut);
			assert.equal(
				liveOutputs.release_url,
				"https://github.com/owner/pkg/releases/tag/v2.0.0",
			);
			const relCreate200 = fakeGh
				.readCalls()
				.find((c) => c.args[0] === "release" && c.args[1] === "create");
			assert.ok(relCreate200.args.includes("--latest"));
			assert.ok(!relCreate200.args.some((a) => a.includes(".DS_Store")));
			assert.ok(relCreate200.args.some((a) => a.endsWith("SHA256SUMS")));

			// 3. Historical backport publish of v1.1.0 (while v1.2.0 and v2.0.0 exist):
			//    - Passes `--latest=false` (never steals Latest from v2.0.0!)
			//    - Does NOT move floating `v1` backwards from v1.2.0 to v1.1.0!
			execFileSync("git", ["checkout", "-q", v110Sha], { cwd: repoDir, stdio: "pipe" });
			withEnv(
				{
					PATH: fakeGh.pathEnv,
					GITHUB_REF_TYPE: "tag",
					GITHUB_REF_NAME: "v1.1.0",
					INPUT_MODE: "publish",
					"INPUT_MAJOR-TAG": "true",
					"INPUT_WORKING-DIRECTORY": repoDir,
					"INPUT_REPO-URL": "https://github.com/owner/pkg",
				},
				() => {
					main(["--ci"], { log: silentLog });
				},
			);
			const relCreate110 = fakeGh
				.readCalls()
				.find(
					(c) =>
						c.args[0] === "release" &&
						c.args[1] === "create" &&
						c.args[2] === "v1.1.0",
				);
			assert.ok(relCreate110, "expected gh release create for v1.1.0");
			assert.ok(
				relCreate110.args.includes("--latest=false"),
				`expected --latest=false on backport, got: ${relCreate110.args.join(" ")}`,
			);
			const remoteV1Sha = execFileSync(
				"git",
				["rev-parse", "refs/tags/v1^{commit}"],
				{ cwd: remoteDir, encoding: "utf8" },
			).trim();
			assert.equal(remoteV1Sha, v120Sha, "floating v1 tag must stay at v1.2.0");

			// Symlinked asset in dist/ is rejected
			symlinkSync(join(repoDir, "package.json"), join(repoDir, "dist", "sym-pkg.json"));
			assert.throws(
				() =>
					publishGithubRelease(repoDir, {
						version: "1.1.0",
						filesInput: "dist/sym-*",
						dryRun: true,
					}),
				/unsafe symlink/,
			);
		});
	});

	test("resolves previous release tags across changelog headings and reachable/non-ancestor git tags", () => {
		withTempDir((dir) => {
			initGitRepo(dir);
			writeFileSync(
				join(dir, "wally.toml"),
				'[package]\nname = "owner/pkg"\nversion = "0.2.0"\n',
			);
			gitCommit(dir, "feat: v0.1.0");
			execFileSync("git", ["tag", "v0.1.0"], { cwd: dir, stdio: "pipe" });
			gitCommit(dir, "feat: add network-synchronized signals (#16)");
			execFileSync("git", ["tag", "v0.2.0"], { cwd: dir, stdio: "pipe" });
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

			assert.equal(resolvePreviousReleaseTag(dir, "0.3.0", changelog), "v0.2.0");
			assert.equal(resolvePreviousReleaseTag(dir, "0.2.0", changelog), "v0.1.0");
			assert.equal(resolvePreviousReleaseTag(dir, "0.1.5", changelog), "v0.1.0");
		});
	});
});
