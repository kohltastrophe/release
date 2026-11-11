import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	compareSemver,
	formatTag,
	isValidSemverStep,
	normalizeVersionArg,
	parseSemver,
	resolveTargetVersion,
	stripTagPrefix,
} from "../src/semver.mjs";

describe("semver", () => {
	test("parses strict SemVer 2.0.0 and rejects leading zeroes in numeric identifiers", () => {
		assert.deepEqual(parseSemver("0.3.1"), { major: 0, minor: 3, patch: 1 });
		assert.deepEqual(parseSemver("1.2.3-beta.1"), {
			major: 1,
			minor: 2,
			patch: 3,
			prerelease: "beta.1",
		});
		assert.deepEqual(parseSemver("1.0.0-01a.0"), {
			major: 1,
			minor: 0,
			patch: 0,
			prerelease: "01a.0",
		});
		assert.equal(parseSemver("v0.3.1"), undefined);
		assert.equal(parseSemver("01.2.3"), undefined);
		assert.equal(parseSemver("1.02.3"), undefined);
		assert.equal(parseSemver("1.2.03"), undefined);
		// Numeric prerelease identifiers with leading zeroes violate SemVer 2.0.0
		assert.equal(parseSemver("1.0.0-01"), undefined);
		assert.equal(parseSemver("1.0.0-alpha.01"), undefined);
	});

	test("maintains strict comparator antisymmetry across stable and prerelease versions", () => {
		const versions = [
			"0.1.0",
			"0.2.0-01a",
			"0.2.0-alpha.1",
			"0.2.0-alpha.2",
			"0.2.0-alpha.10",
			"0.2.0-beta.1",
			"0.2.0",
			"1.0.0-rc.1",
			"1.0.0",
		];
		for (let i = 0; i < versions.length; i += 1) {
			assert.equal(compareSemver(versions[i], versions[i]), 0);
			for (let j = i + 1; j < versions.length; j += 1) {
				assert.equal(compareSemver(versions[i], versions[j]), -1);
				assert.equal(compareSemver(versions[j], versions[i]), 1);
			}
		}
	});

	test("validates semver steps, prerelease transitions, and target resolution", () => {
		assert.equal(isValidSemverStep("0.3.0", "0.3.1"), true);
		assert.equal(isValidSemverStep("0.3.1", "0.4.0"), true);
		assert.equal(isValidSemverStep("0.3.1", "1.0.0"), true);
		assert.equal(isValidSemverStep("0.3.0", "0.3.2"), false);

		// Stable to next-step prerelease transitions
		assert.equal(isValidSemverStep("1.0.0", "1.0.1-alpha.1"), true);
		assert.equal(isValidSemverStep("1.0.0", "1.1.0-alpha.1"), true);
		assert.equal(isValidSemverStep("1.0.0", "2.0.0-alpha.1"), true);
		assert.equal(isValidSemverStep("1.0.0", "1.0.2-alpha.1"), false);
		assert.equal(isValidSemverStep("1.0.0", "1.0.0-alpha.1"), false);

		// Prerelease progressions & graduations
		assert.equal(isValidSemverStep("1.0.0-alpha.1", "1.0.0-alpha.2"), true);
		assert.equal(isValidSemverStep("1.0.0-alpha.2", "1.0.0-beta.1"), true);
		assert.equal(isValidSemverStep("1.0.0-beta.1", "1.0.0"), true);
		assert.equal(isValidSemverStep("1.0.1-alpha.1", "1.1.0-alpha.1"), true);
		assert.equal(isValidSemverStep("1.0.0-beta.1", "1.0.1"), false);
		assert.equal(isValidSemverStep("1.0.0-beta.1", "1.1.0"), false);
		assert.equal(isValidSemverStep("1.0.0-alpha.2", "1.0.0-alpha.1"), false);

		assert.equal(resolveTargetVersion("0.3.1", "patch"), "0.3.2");
		assert.equal(resolveTargetVersion("0.3.1", "minor"), "0.4.0");
		assert.equal(resolveTargetVersion("0.3.1", "major"), "1.0.0");
		assert.equal(resolveTargetVersion("1.0.0-beta.1", "patch"), "1.0.0");
		assert.equal(resolveTargetVersion("1.0.0-beta.1", "1.0.0"), "1.0.0");
		assert.throws(() => resolveTargetVersion("bad", "patch"), /not valid semver/);
		assert.throws(() => resolveTargetVersion("0.3.1", "invalid"), /invalid release target/);
		assert.throws(() => resolveTargetVersion("0.3.0", "0.3.2"), /not a valid semver increment/);
	});

	test("formats and strips configurable tag prefixes", () => {
		assert.equal(formatTag("1.2.3"), "v1.2.3");
		assert.equal(formatTag("1.2.3", "pkg-v"), "pkg-v1.2.3");
		assert.equal(formatTag("1.2.3", ""), "1.2.3");
		assert.equal(stripTagPrefix("v1.2.3", "v"), "1.2.3");
		assert.equal(stripTagPrefix("pkg-v1.2.3", "pkg-v"), "1.2.3");
		assert.equal(stripTagPrefix("1.2.3", ""), "1.2.3");
		assert.equal(stripTagPrefix("other-1.2.3", "v"), undefined);
		assert.equal(normalizeVersionArg("pkg-v1.2.3", "pkg-v"), "1.2.3");
		assert.equal(normalizeVersionArg("v1.2.3", "pkg-v"), "1.2.3");
		assert.equal(normalizeVersionArg("minor", "v"), "minor");
	});
});
