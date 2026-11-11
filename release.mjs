#!/usr/bin/env node
/**
 * Conventional Commits validator, Keep a Changelog generator, multi-manifest
 * SemVer bumper, and automated Release PR / GitHub Release driver.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { main } from "./src/cli.mjs";

export {
	buildChangelogFromCommits,
	extractReleaseNotes,
	prepareRelease,
	validateCommitSubject,
	validateReleaseState,
} from "./src/changelog.mjs";
export { publishGithubRelease, verifySha256Sums } from "./src/github.mjs";
export { bumpRepoVersionFiles, detectRepoVersion } from "./src/manifests.mjs";
export {
	compareSemver,
	isValidSemverStep,
	parseSemver,
	resolveTargetVersion,
} from "./src/semver.mjs";

function isExecutedDirectly() {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return import.meta.url === pathToFileURL(realpathSync(entry)).href;
	} catch {
		return import.meta.url === pathToFileURL(entry).href;
	}
}

if (isExecutedDirectly()) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
}
