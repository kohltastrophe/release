import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { main } from "../src/cli.mjs";
import {
	bumpRepoVersionFiles,
	detectRepoVersion,
	locateVersionByPattern,
	resolveSafeRepoPath,
	validateVersionConsistency,
} from "../src/manifests.mjs";
import { initGitRepo, withEnv, withTempDir } from "./helpers.mjs";

const silentLog = () => {};

describe("manifests & [release] config", () => {
	test("rejects path traversal, case-insensitive .git segments, and symlinks in resolveSafeRepoPath", () => {
		withTempDir((dir) => {
			mkdirSync(join(dir, ".git"), { recursive: true });
			writeFileSync(join(dir, ".git", "config"), "secret-token=123\n");
			writeFileSync(join(dir, "outside-secret.txt"), "secret\n");

			const subRepo = join(dir, "repo");
			mkdirSync(join(subRepo, ".git"), { recursive: true });
			writeFileSync(join(subRepo, ".git", "config"), "repo-secret=456\n");
			symlinkSync(join(dir, "outside-secret.txt"), join(subRepo, "leak.toml"));
			symlinkSync(join(subRepo, ".git", "config"), join(subRepo, "git-leak.toml"));
			mkdirSync(join(dir, "external-dir"));
			symlinkSync(join(dir, "external-dir"), join(subRepo, "symdir"));

			assert.throws(() => resolveSafeRepoPath(subRepo, "../outside-secret.txt"), /unsafe/);
			assert.throws(() => resolveSafeRepoPath(subRepo, ".git/config"), /unsafe/);
			assert.throws(() => resolveSafeRepoPath(subRepo, ".GIT/config"), /unsafe/);
			assert.throws(() => resolveSafeRepoPath(subRepo, ".git./config"), /unsafe/);
			assert.throws(() => resolveSafeRepoPath(subRepo, "leak.toml"), /unsafe symlink/);
			assert.throws(() => resolveSafeRepoPath(subRepo, "git-leak.toml"), /unsafe symlink/);
			assert.throws(
				() => resolveSafeRepoPath(subRepo, "symdir/nested.toml"),
				/unsafe symlink/,
			);
		});
	});

	test("detects and bumps multi-manifest repos, quoted inline-table patterns, and exact capture-group-1 spans", () => {
		withTempDir((dir) => {
			mkdirSync(join(dir, "python", "pkg"), { recursive: true });
			writeFileSync(
				join(dir, "Cargo.toml"),
				'[workspace]\nresolver = "2"\n\n[dependencies.foo]\nversion = "9.9.9"\n\n[package]\nname = "demo"\nversion = "0.2.0"\n',
			);
			writeFileSync(
				join(dir, "Cargo.lock"),
				'[[package]]\nname = "other"\nversion = "9.9.9"\n\n[[package]]\nname = "demo-cli"\nversion = "0.2.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n\n[[package]]\nname = "demo-cli"\nversion = "0.2.0"\n',
			);
			writeFileSync(
				join(dir, "wally.toml"),
				'[package]\nname = "owner/demo"\nversion = "0.2.0"\n',
			);
			writeFileSync(join(dir, "VERSION.txt"), "0.2.0\n");
			writeFileSync(join(dir, "python", "pkg", "__init__.py"), 'VERSION = "0.2.0"\n');
			// Note: prefix before group 1 ALSO contains "0.2.0" AND inline pattern contains `key = "..."`
			writeFileSync(
				join(dir, "init.luau"),
				'local SCHEMA_0_2_0 = "0.2.0" -- key = "0.2.0", val = "0.2.0"\n',
			);
			writeFileSync(
				join(dir, "release.toml"),
				[
					"[release]",
					'prefix = "pkg-v"',
					"versions = [",
					'  # { file = "../ignored.toml" }',
					'  { file = "python/pkg/__init__.py", pattern = \'^VERSION = "([^"]*)"\' },',
					'  { file = "Cargo.lock", key = "package", where = { name = "demo-cli" }, field = "version" },',
					'  { file = "init.luau", pattern = \'key = "0\\.2\\.0", val = "([^"]+)"\' },',
					"]",
				].join("\n"),
			);

			const detected = detectRepoVersion(dir);
			assert.equal(detected.version, "0.2.0");
			assert.equal(detected.tagPrefix, "pkg-v");
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

			// Local Cargo.lock [[package]] (without source =) was bumped, while registry duplicate stayed 0.2.0!
			const lockAfter = readFileSync(join(dir, "Cargo.lock"), "utf8");
			assert.ok(
				lockAfter.includes(
					'[[package]]\nname = "demo-cli"\nversion = "0.2.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"',
				),
			);
			assert.ok(lockAfter.includes('[[package]]\nname = "demo-cli"\nversion = "0.3.0"'));

			// Only capture group 1 (`val = "0.3.0"`) was replaced; `SCHEMA_0_2_0 = "0.2.0"` and `key = "0.2.0"` stayed untouched!
			assert.equal(
				readFileSync(join(dir, "init.luau"), "utf8"),
				'local SCHEMA_0_2_0 = "0.2.0" -- key = "0.2.0", val = "0.3.0"\n',
			);

			// Pattern missing capture group 1 throws explicitly
			assert.throws(
				() => locateVersionByPattern("version = 1.0.0", "version = \\d+\\.\\d+\\.\\d+"),
				/must include a capture group/,
			);
		});
	});

	test("prevents label collisions across multiple entries on the same file and preserves patterned primary manifests", () => {
		withTempDir((dir) => {
			writeFileSync(
				join(dir, "wally.toml"),
				[
					"[package] # package comment",
					'name = "owner/flux-ui"',
					'version = "release-0.2.0"',
					"",
					"[dependencies]",
					'Flux = "kohltastrophe/flux@1.0.0"',
					'Sert = "kohltastrophe/sert@0.4.0-alpha.1"',
					"",
				].join("\r\n"),
			);
			writeFileSync(
				join(dir, "README.md"),
				[
					'rev = "v0.2.0"',
					'rev = "v0.2.0"',
					'kohltastrophe/sert@0.1.0',
				].join("\n"),
			);
			writeFileSync(
				join(dir, "sert.toml"),
				[
					"[release]",
					"versions = [",
					'  { file = "wally.toml", key = "package.version", pattern = "^release-(\\\\d{1,3}\\\\.\\\\d{1,3}\\\\.\\\\d{1,3})$" },',
					'  { file = "README.md", pattern = \'rev = "v([^"]+)"\' },',
					'  { file = "README.md", pattern = "kohltastrophe/sert@([0-9.]+)" },',
					"]",
					"released = [",
					'  { file = "wally.toml", key = "dependencies.Flux", pattern = "^kohltastrophe/flux@(.+)$" },',
					'  { file = "wally.toml", key = "dependencies.Sert", pattern = "^kohltastrophe/sert@(.+)$" },',
					"]",
				].join("\r\n"),
			);

			const detected = detectRepoVersion(dir);
			assert.equal(detected.version, "0.2.0");
			// Entry 2 on README.md has 0.1.0 and must NOT overwrite Entry 1's #1/#2 or get masked!
			assert.throws(
				() => validateVersionConsistency(detected.version, detected.versionsByFile),
				/README\.md.*has 0\.1\.0, expected 0\.2\.0/,
			);

			// Fix README drift, then verify 2nd [release].released entry catches prerelease pin
			writeFileSync(
				join(dir, "README.md"),
				['rev = "v0.2.0"', 'rev = "v0.2.0"', "kohltastrophe/sert@0.2.0"].join("\n"),
			);
			const detected2 = detectRepoVersion(dir);
			assert.throws(
				() =>
					validateVersionConsistency(detected2.version, detected2.versionsByFile, {
						releasedChecks: detected2.releasedChecks,
					}),
				/dependencies\.Sert.*expected a released semver version/,
			);

			// Patterned primary manifest (`release-0.2.0` -> `release-0.3.0`) is NOT clobbered to bare `0.3.0`
			bumpRepoVersionFiles(dir, "0.3.0", detected2.files);
			const wallyAfter = readFileSync(join(dir, "wally.toml"), "utf8");
			assert.ok(wallyAfter.includes("\r\n"), "preserves CRLF");
			assert.ok(
				wallyAfter.includes('version = "release-0.3.0"'),
				`expected patterned version to stay prefixed, got:\n${wallyAfter}`,
			);
		});
	});

	test("auto-syncs root package-lock.json and Cargo.lock, ignores nested JSON version deps, and skips versionless package.json", () => {
		withTempDir((dir) => {
			initGitRepo(dir);
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify(
					{
						name: "demo-js",
						dependencies: { version: "9.9.9" },
						version: "1.0.0",
					},
					null,
					2,
				) + "\n",
			);
			writeFileSync(
				join(dir, "package-lock.json"),
				JSON.stringify(
					{
						name: "demo-js",
						version: "1.0.0",
						lockfileVersion: 3,
						packages: {
							"": { name: "demo-js", version: "1.0.0" },
							"node_modules/version": { version: "9.9.9" },
						},
					},
					null,
					2,
				) + "\n",
			);
			writeFileSync(
				join(dir, "Cargo.toml"),
				[
					"[workspace.package]",
					'version = "1.0.0"',
					"",
					"[package]",
					'name = "demo-rs"',
					'version = "1.0.0"',
					"",
				].join("\n"),
			);
			writeFileSync(
				join(dir, "Cargo.lock"),
				[
					"[[package]]",
					'name = "demo-rs"',
					'version = "1.0.0"',
					"",
					"[[package]]",
					'name = "serde"',
					'version = "1.0.210"',
					'source = "registry+https://github.com/rust-lang/crates.io-index"',
					"",
				].join("\n"),
			);

			const detected = detectRepoVersion(dir);
			assert.equal(detected.version, "1.0.0");
			const modified = bumpRepoVersionFiles(dir, "1.1.0", detected.files);
			assert.deepEqual(modified, [
				"package.json",
				"Cargo.toml",
				"package-lock.json",
				"Cargo.lock",
			]);

			const pkgAfter = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			assert.equal(pkgAfter.version, "1.1.0");
			assert.equal(pkgAfter.dependencies.version, "9.9.9");

			const lockAfter = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
			assert.equal(lockAfter.version, "1.1.0");
			assert.equal(lockAfter.packages[""].version, "1.1.0");
			assert.equal(lockAfter.packages["node_modules/version"].version, "9.9.9");

			const cargoAfter = readFileSync(join(dir, "Cargo.toml"), "utf8");
			assert.equal([...cargoAfter.matchAll(/version = "1\.1\.0"/g)].length, 2);
			assert.ok(
				readFileSync(join(dir, "Cargo.lock"), "utf8").includes(
					'name = "demo-rs"\nversion = "1.1.0"',
				),
			);

			withEnv({ INPUT_WORKING_DIRECTORY: dir }, () => {
				main(["--check"], { log: silentLog });
			});
		});

		// Versionless root package.json (like z-docs) does not trigger package-lock.json sync or break wally.toml detection
		withTempDir((dir) => {
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ name: "z-docs", private: true }, null, 2) + "\n",
			);
			writeFileSync(
				join(dir, "package-lock.json"),
				JSON.stringify({ name: "z-docs", lockfileVersion: 3, packages: { "": {} } }) + "\n",
			);
			writeFileSync(
				join(dir, "wally.toml"),
				'[package]\nname = "owner/z"\nversion = "0.5.0"\n',
			);
			const detected = detectRepoVersion(dir);
			assert.equal(detected.version, "0.5.0");
			assert.deepEqual(detected.files, ["wally.toml"]);
		});
	});
});
