import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	appendGithubReleaseSections,
	buildChangelogFromCommits,
	extractReleaseNotes,
	parseReleaseCommitSubject,
	prepareRelease,
	validateCommitSubject,
	validateReleaseState,
} from "./changelog.mjs";
import {
	deleteRemoteReleaseBranch,
	detectReleaseCommit,
	detectRepoUrl,
	ensureFullGitHistory,
	hasGitTag,
	headCommitSubject,
	highestSemverTag,
	isHeadTagged,
	listSemverTagVersions,
	reachableSemverTag,
	readCommitsInRange,
	resolveBaseBranch,
	resolvePreviousReleaseTag,
	tryGit,
} from "./git.mjs";
import {
	fetchGithubGeneratedNotes,
	getInput,
	publishGithubRelease,
	publishReleasePullRequest,
	waitForCiWorkflows,
	writeStepSummary,
} from "./github.mjs";
import {
	bumpRepoVersionFiles,
	detectRepoVersion,
	stageRepoVersionBumps,
	validateVersionConsistency,
} from "./manifests.mjs";
import {
	compareSemver,
	formatTag,
	normalizeVersionArg,
	parseSemver,
	resolveTargetVersion,
	stripTagPrefix,
} from "./semver.mjs";

const USAGE_TEXT = [
	"usage: release [patch|minor|major|x.y.z] [options]",
	"       release --check [range]",
	"       release --notes [x.y.z]",
	"       release --pr [--dry-run]",
	"       release --publish [x.y.z] [--title <t>] [--files <globs>] [--checksums [path]] [--major-tag] [--dry-run]",
].join("\n");

function normalizeBareBooleanValueFlags(argv) {
	const out = [];
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--checksums") {
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("-")) {
				out.push("--checksums=true");
				continue;
			}
		}
		out.push(arg);
	}
	return out;
}

function parseCliArgs(argv) {
	try {
		return parseArgs({
			args: normalizeBareBooleanValueFlags(argv),
			allowPositionals: true,
			strict: true,
			options: {
				help: { type: "boolean", short: "h" },
				check: { type: "boolean" },
				notes: { type: "boolean" },
				pr: { type: "boolean" },
				publish: { type: "boolean" },
				ci: { type: "boolean" },
				"dry-run": { type: "boolean" },
				"major-tag": { type: "boolean" },
				title: { type: "string" },
				files: { type: "string" },
				checksums: { type: "string" },
				"tag-prefix": { type: "string" },
				"repo-url": { type: "string" },
				"working-directory": { type: "string", short: "C" },
				"version-files": { type: "string" },
				"wait-for-ci": { type: "string" },
				"wait-timeout": { type: "string" },
			},
		});
	} catch (err) {
		if (/unknown option/i.test(err.message)) {
			throw new Error(err.message.replace(/^Unknown option/, "unknown option"));
		}
		throw err;
	}
}

function readGithubEventPayload() {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath || !existsSync(eventPath)) return undefined;
	try {
		return JSON.parse(readFileSync(eventPath, "utf8"));
	} catch {
		return undefined;
	}
}

function resolveDryRun(cliDryRun) {
	if (cliDryRun === true) return true;
	const raw = getInput("dry-run");
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch") {
		const payload = readGithubEventPayload();
		const dispatchVal = payload?.inputs?.dry_run;
		if (dispatchVal === true || dispatchVal === "true") return true;
	}
	return false;
}

function resolvePullRequestTitle() {
	const direct = (process.env.PR_TITLE || getInput("pr-title")).trim();
	if (direct) return direct;
	const payload = readGithubEventPayload();
	if (typeof payload?.pull_request?.title === "string") {
		return payload.pull_request.title.trim();
	}
	return "";
}

function writeReleaseOutputs({
	version,
	tagPrefix = "v",
	shouldRelease = false,
	dryRun = false,
	notesFile,
	releaseUrl,
	prUrl,
	prNumber,
}) {
	const outputPath = process.env.GITHUB_OUTPUT;
	if (!outputPath) return;
	const shouldBuild = shouldRelease || dryRun;
	const outputs = {
		should_release: shouldRelease ? "true" : "false",
		should_build: shouldBuild ? "true" : "false",
		dry_run: dryRun ? "true" : "false",
		version,
		tag: formatTag(version, tagPrefix),
		prerelease: String(Boolean(parseSemver(version)?.prerelease)),
		...(notesFile ? { notes_file: notesFile } : {}),
		...(releaseUrl ? { release_url: releaseUrl } : {}),
		...(prUrl ? { pr_url: prUrl } : {}),
		...(prNumber ? { pr_number: String(prNumber) } : {}),
	};
	const lines = Object.entries(outputs).map(([k, v]) => {
		if (/[\r\n]/.test(k) || /[\r\n]/.test(v)) {
			throw new Error(`invalid newline in GitHub output "${k}"`);
		}
		return `${k}=${v}`;
	});
	appendFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
}

function buildPendingPreviewNotes(root, targetTag, targetVersion, repoUrl) {
	const pendingCommits = readCommitsInRange(root, `${targetTag}..HEAD`);
	const { markdown } = buildChangelogFromCommits(targetVersion, pendingCommits, {
		strict: false,
		repoUrl,
	});
	return markdown ? `${markdown}\n` : undefined;
}

function resolveChangelogBaseNotes(root, changelogText, {
	pkgVersion,
	targetVersion,
	targetTag,
	repoUrl,
	allowUnreleased,
	explicitVersion,
	isPendingDryPreview,
	knownVersions,
	tagPrefix,
	prevTag,
}) {
	if (isPendingDryPreview) {
		const state = validateReleaseState(pkgVersion, changelogText, repoUrl, {
			allowUnreleased: true,
			knownVersions,
			tagPrefix,
		});
		if (state.unreleasedNotes) {
			return { prevTag: targetTag, baseNotes: `${state.unreleasedNotes}\n` };
		}
		const pendingNotes = buildPendingPreviewNotes(root, targetTag, targetVersion, repoUrl);
		if (pendingNotes) {
			return { prevTag: targetTag, baseNotes: pendingNotes };
		}
	}
	const baseNotes = extractReleaseNotes(
		pkgVersion,
		changelogText,
		explicitVersion ? targetVersion : undefined,
		repoUrl,
		{ allowUnreleased, knownVersions, tagPrefix },
	);
	return { prevTag, baseNotes };
}

function resolveCommitRangeBaseNotes(root, {
	pkgVersion,
	targetVersion,
	targetTag,
	repoUrl,
	explicitVersion,
	isPendingDryPreview,
	tagPrefix,
	prevTag,
	endRef,
}) {
	if (
		explicitVersion &&
		targetVersion !== pkgVersion &&
		!hasGitTag(root, targetVersion, { tagPrefix })
	) {
		throw new Error(`version ${targetVersion} has no git tag (${targetTag})`);
	}
	if (isPendingDryPreview) {
		const pendingNotes = buildPendingPreviewNotes(root, targetTag, targetVersion, repoUrl);
		if (pendingNotes) {
			return { prevTag: targetTag, baseNotes: pendingNotes };
		}
	}
	const fallbackEndRef =
		isPendingDryPreview && hasGitTag(root, targetVersion, { tagPrefix }) ? targetTag : endRef;
	const baseVer = prevTag ? (stripTagPrefix(prevTag, tagPrefix) ?? prevTag) : "0.0.0";
	const range = prevTag ? `${prevTag}..${fallbackEndRef}` : fallbackEndRef;
	const { markdown } = buildChangelogFromCommits(baseVer, readCommitsInRange(root, range), {
		strict: false,
		repoUrl,
	});
	return { prevTag, baseNotes: `${markdown}\n` };
}

function resolveReleaseNotes(
	root,
	pkgVersion,
	targetVersion,
	repoUrl,
	{
		allowUnreleased = false,
		explicitVersion = false,
		tagPrefix = "v",
		trackedFiles,
		token,
	} = {},
) {
	const changelogPath = join(root, "CHANGELOG.md");
	const changelogText = existsSync(changelogPath)
		? readFileSync(changelogPath, "utf8")
		: undefined;
	const knownVersions = listSemverTagVersions(root, { tagPrefix });
	const headRelease = detectReleaseCommit(root, pkgVersion, { tagPrefix, trackedFiles });
	const targetTag = formatTag(targetVersion, tagPrefix);
	const hasTargetTag = hasGitTag(root, targetVersion, { tagPrefix });
	const headTagged = isHeadTagged(root, targetVersion, { tagPrefix });
	const isPendingDryPreview =
		allowUnreleased &&
		!explicitVersion &&
		targetVersion === pkgVersion &&
		hasTargetTag &&
		!headTagged &&
		!headRelease.isRelease;

	const initialPrevTag = resolvePreviousReleaseTag(root, targetVersion, changelogText, {
		tagPrefix,
	});
	const useTagEndRef =
		!isPendingDryPreview &&
		hasTargetTag &&
		(headTagged || !(headRelease.isRelease && (headRelease.version ?? pkgVersion) === targetVersion));
	const endRef = useTagEndRef ? targetTag : "HEAD";

	const { prevTag, baseNotes } =
		changelogText !== undefined
			? resolveChangelogBaseNotes(root, changelogText, {
					pkgVersion,
					targetVersion,
					targetTag,
					repoUrl,
					allowUnreleased,
					explicitVersion,
					isPendingDryPreview,
					knownVersions,
					tagPrefix,
					prevTag: initialPrevTag,
				})
			: resolveCommitRangeBaseNotes(root, {
					pkgVersion,
					targetVersion,
					targetTag,
					repoUrl,
					explicitVersion,
					isPendingDryPreview,
					tagPrefix,
					prevTag: initialPrevTag,
					endRef,
				});

	const targetCommitish =
		endRef === "HEAD" ? tryGit(root, ["rev-parse", "-q", "--verify", "HEAD"]) : endRef;
	const generatedBody = fetchGithubGeneratedNotes(
		root,
		repoUrl,
		targetTag,
		prevTag,
		targetCommitish,
		{ token },
	);
	return appendGithubReleaseSections(baseNotes, {
		repoUrl,
		prevTag,
		version: targetVersion,
		tagPrefix,
		generatedBody,
	});
}

function runCheckMode({
	root,
	repoUrl,
	currentVersion,
	versionsByFile,
	releasedChecks,
	tagPrefix,
	explicitRange,
	log,
}) {
	const prTitle = resolvePullRequestTitle();
	if (prTitle && !/^Revert "/.test(prTitle)) {
		validateCommitSubject(prTitle);
	}
	validateVersionConsistency(currentVersion, versionsByFile, { releasedChecks, tagPrefix });

	const changelogPath = join(root, "CHANGELOG.md");
	let range = explicitRange;
	let baseTagVer;
	if (existsSync(changelogPath)) {
		const isExplicitReleaseCommit =
			Boolean(parseReleaseCommitSubject(prTitle, tagPrefix)) ||
			Boolean(parseReleaseCommitSubject(headCommitSubject(root), tagPrefix)) ||
			Boolean(
				parseReleaseCommitSubject(
					tryGit(root, ["log", "-1", "--format=%s", "HEAD^2"]) ?? "",
					tagPrefix,
				),
			) ||
			process.env.GITHUB_REF_TYPE === "tag";
		const knownVersions = listSemverTagVersions(root, { tagPrefix });
		const state = validateReleaseState(
			currentVersion,
			readFileSync(changelogPath, "utf8"),
			repoUrl,
			{
				allowUnreleased: !isExplicitReleaseCommit,
				knownVersions,
				tagPrefix,
			},
		);
		baseTagVer = state.versions.find((v) => hasGitTag(root, v, { tagPrefix }));
		if (!prTitle) {
			range ??= baseTagVer ? `${formatTag(baseTagVer, tagPrefix)}..HEAD` : undefined;
		}
	} else if (!prTitle && !range) {
		const rTag = reachableSemverTag(root, "HEAD", { tagPrefix });
		if (rTag) {
			baseTagVer = stripTagPrefix(rTag, tagPrefix);
			range = `${rTag}..HEAD`;
		}
	}

	if (range) {
		buildChangelogFromCommits(baseTagVer ?? currentVersion, readCommitsInRange(root, range));
	} else if (!prTitle) {
		const headSubject = headCommitSubject(root);
		if (headSubject && !/^Revert "|^Merge /.test(headSubject)) {
			validateCommitSubject(headSubject);
		}
	}

	writeReleaseOutputs({ version: currentVersion, tagPrefix, shouldRelease: false, dryRun: false });
	log(`release state valid (${currentVersion})`);
}

function formatReleaseSummary({
	heading,
	notes,
	checksumsContent,
}) {
	const parts = [heading];
	if (checksumsContent) {
		parts.push(`\`\`\`text\n${checksumsContent}\n\`\`\``);
	}
	if (notes?.trim()) {
		parts.push(notes.trim());
	}
	return parts.join("\n\n");
}

function writeReleaseModeSummary(
	tag,
	notesText,
	{ dryRun, shouldPublish, reuseExistingNotes, publishResult },
) {
	if (dryRun) {
		if (reuseExistingNotes) {
			if (publishResult?.checksumsContent) {
				writeStepSummary(
					formatReleaseSummary({
						heading: `### Dry run checksums: \`${publishResult?.title || tag}\``,
						checksumsContent: publishResult.checksumsContent,
					}),
				);
			}
			return;
		}
		writeStepSummary(
			formatReleaseSummary({
				heading: `### Dry run: \`${publishResult?.title || tag}\``,
				notes: notesText,
				checksumsContent: publishResult?.checksumsContent,
			}),
		);
		return;
	}
	if (!shouldPublish) {
		writeStepSummary(`### Release ready: \`${tag}\``);
		return;
	}
	const label = publishResult?.title || tag;
	const linked = publishResult?.releaseUrl
		? `[${label}](${publishResult.releaseUrl})`
		: `\`${label}\``;
	writeStepSummary(
		formatReleaseSummary({
			heading: `### Released ${linked}`,
			notes: notesText,
			checksumsContent: publishResult?.checksumsContent,
		}),
	);
}

function runReleaseMode({
	root,
	repoUrl,
	currentVersion,
	versionsByFile,
	releasedChecks,
	trackedFiles,
	tagPrefix,
	releaseVersion,
	dryRun = false,
	isPublishMode = false,
	publishFlag = false,
	publishOptions = {},
	log,
}) {
	const version = releaseVersion ?? currentVersion;
	if (!parseSemver(version)) {
		throw new Error(`release version "${version}" is not valid semver`);
	}
	validateVersionConsistency(version, versionsByFile, { releasedChecks, tagPrefix });

	const { token } = publishOptions;
	const tag = formatTag(version, tagPrefix);
	const notesFile = join(root, "release-notes.md");
	const reuseExistingNotes =
		isPublishMode &&
		existsSync(notesFile) &&
		readFileSync(notesFile, "utf8").trim().length > 0;
	const notesText = reuseExistingNotes
		? readFileSync(notesFile, "utf8")
		: resolveReleaseNotes(root, version, version, repoUrl, {
				allowUnreleased: dryRun,
				tagPrefix,
				trackedFiles,
				token,
			});
	if (!reuseExistingNotes) writeFileSync(notesFile, notesText, "utf8");

	const shouldPublish = isPublishMode || publishFlag || getInput("publish") === "true";
	if (!dryRun && !isPublishMode) {
		const waitWorkflows = (publishOptions.waitForCi ?? getInput("wait-for-ci")).trim();
		if (waitWorkflows) {
			const timeoutMinutes =
				Number(publishOptions.waitTimeout || getInput("wait-timeout")) || 30;
			waitForCiWorkflows(root, repoUrl, waitWorkflows, timeoutMinutes, { log, token });
		}
		deleteRemoteReleaseBranch(root, undefined, { token, tagPrefix });
	}

	const publishResult = shouldPublish
		? publishGithubRelease(root, {
				version,
				notesFile,
				title: publishOptions.title,
				filesInput: publishOptions.files,
				checksums: publishOptions.checksums,
				majorTag: publishOptions.majorTag,
				tagPrefix,
				repoUrl,
				dryRun,
				token,
			})
		: undefined;

	writeReleaseOutputs({
		version,
		tagPrefix,
		shouldRelease: !dryRun,
		dryRun,
		notesFile,
		releaseUrl: publishResult?.releaseUrl,
	});
	writeReleaseModeSummary(tag, notesText, {
		dryRun,
		shouldPublish,
		reuseExistingNotes,
		publishResult,
	});
	log(
		dryRun
			? `dry-run validated ${tag}`
			: shouldPublish
				? `published release ${tag}`
				: `ready to release ${tag}`,
	);
}

function finalizePullRequestDryRun(root, {
	manifestVersion,
	nextVersion,
	prNotes,
	repoUrl,
	highestTag,
	tagPrefix,
	log,
}) {
	const notesFile = join(root, "release-notes.md");
	const dryNotes = appendGithubReleaseSections(prNotes, {
		repoUrl,
		prevTag: highestTag,
		version: nextVersion,
		tagPrefix,
	});
	writeFileSync(notesFile, dryNotes, "utf8");
	writeReleaseOutputs({
		version: manifestVersion,
		tagPrefix,
		shouldRelease: false,
		dryRun: true,
		notesFile,
	});
	writeStepSummary(
		formatReleaseSummary({
			heading: `### Dry run: \`chore: release ${nextVersion}\``,
			notes: dryNotes,
		}),
	);
	log(`dry-run validated release PR ${formatTag(nextVersion, tagPrefix)}`);
}

function submitPreparedReleasePr(root, {
	baseBranch,
	nextVersion,
	prNotes,
	preparedChangelogText,
	files,
	extraVersionFiles,
	repoUrl,
	highestTag,
	tagPrefix,
	token,
	log,
}) {
	const fileUpdates = stageRepoVersionBumps(root, nextVersion, files, {
		extraVersionFiles,
		tagPrefix,
	});
	if (preparedChangelogText !== undefined) {
		fileUpdates.set("CHANGELOG.md", preparedChangelogText);
	}
	const prResult = publishReleasePullRequest(root, {
		baseBranch,
		nextVersion,
		markdown: prNotes,
		fileUpdates,
		repoUrl,
		prevTag: highestTag,
		tagPrefix,
		token,
	});
	writeReleaseOutputs({
		version: nextVersion,
		tagPrefix,
		shouldRelease: false,
		dryRun: false,
		prUrl: prResult.prUrl,
		prNumber: prResult.prNumber,
	});
	const prLabel = prResult.prUrl
		? `[${prResult.prTitle}](${prResult.prUrl})`
		: `\`${prResult.prTitle}\``;
	writeStepSummary(
		formatReleaseSummary({
			heading: `### Release PR: ${prLabel}`,
			notes: prNotes,
		}),
	);
	log(
		`${prResult.created ? "opened" : "updated"} release PR ${prResult.prNumber ? `#${prResult.prNumber} ` : ""}(${prResult.prTitle})`,
	);
}

function buildPullRequestChangelogPayload(root, { baseVersion, commits, repoUrl, allowSkippedStep, tagPrefix }) {
	const changelogPath = join(root, "CHANGELOG.md");
	if (!existsSync(changelogPath)) return undefined;
	const knownVersions = listSemverTagVersions(root, { tagPrefix });
	const highestTag = highestSemverTag(root, { tagPrefix });
	const { bump } = buildChangelogFromCommits(baseVersion, commits, { strict: true, repoUrl });
	if (!bump) return null;
	const nextVersion = highestTag ? resolveTargetVersion(baseVersion, bump) : baseVersion;
	const prepared = prepareRelease({
		changelogText: readFileSync(changelogPath, "utf8"),
		target: nextVersion,
		baseVersion,
		commits,
		repoUrl,
		allowSkippedStep,
		knownVersions,
		tagPrefix,
	});
	return { nextVersion, prNotes: prepared.notes, preparedChangelogText: prepared.changelogText };
}

function runPullRequestFlow({
	root,
	repoUrl,
	detected,
	cachedHeadSubject,
	dryRun = false,
	extraVersionFiles,
	token,
	log,
}) {
	const { version: manifestVersion, files, tagPrefix } = detected;
	const headSubject = cachedHeadSubject ?? headCommitSubject(root);
	const baseBranch = resolveBaseBranch(root, { tagPrefix });
	const releaseCommit = detectReleaseCommit(root, manifestVersion, {
		headSubject,
		tagPrefix,
		trackedFiles: files,
	});
	if (releaseCommit.isRelease) {
		if (!dryRun) deleteRemoteReleaseBranch(root, baseBranch, { token, tagPrefix });
		log(`HEAD is already a release commit ("${headSubject}"); skipping PR creation`);
		writeReleaseOutputs({
			version: releaseCommit.version ?? manifestVersion,
			tagPrefix,
			shouldRelease: false,
			dryRun,
		});
		return;
	}

	const highestTag = highestSemverTag(root, { tagPrefix });
	const reachableTag = reachableSemverTag(root, "HEAD", { tagPrefix });
	const baseVersion = highestTag
		? (stripTagPrefix(highestTag, tagPrefix) ?? manifestVersion)
		: manifestVersion;
	const commits = readCommitsInRange(root, highestTag ? `${highestTag}..HEAD` : "HEAD");
	const allowSkippedStep = Boolean(highestTag && reachableTag && highestTag !== reachableTag);
	const changelogPayload = buildPullRequestChangelogPayload(root, {
		baseVersion,
		commits,
		repoUrl,
		allowSkippedStep,
		tagPrefix,
	});
	const commitSummary =
		changelogPayload === undefined
			? buildChangelogFromCommits(baseVersion, commits, { strict: false, repoUrl })
			: undefined;

	if (changelogPayload === null || (commitSummary && (!commitSummary.bump || !commitSummary.markdown))) {
		if (!dryRun) deleteRemoteReleaseBranch(root, baseBranch, { token, tagPrefix });
		log(`no releasable commits since ${formatTag(baseVersion, tagPrefix)}; skipping release PR`);
		writeReleaseOutputs({ version: baseVersion, tagPrefix, shouldRelease: false, dryRun });
		return;
	}

	const nextVersion =
		changelogPayload?.nextVersion ??
		(highestTag ? resolveTargetVersion(baseVersion, commitSummary.bump) : baseVersion);
	const prNotes = changelogPayload?.prNotes ?? commitSummary.markdown;
	const preparedChangelogText = changelogPayload?.preparedChangelogText;

	if (dryRun) {
		finalizePullRequestDryRun(root, {
			manifestVersion,
			nextVersion,
			prNotes,
			repoUrl,
			highestTag,
			tagPrefix,
			log,
		});
		return;
	}
	submitPreparedReleasePr(root, {
		baseBranch,
		nextVersion,
		prNotes,
		preparedChangelogText,
		files,
		extraVersionFiles,
		repoUrl,
		highestTag,
		tagPrefix,
		token,
		log,
	});
}

function runLocalBumpMode({
	root,
	repoUrl,
	currentVersion,
	files,
	tagPrefix,
	targetArg,
	extraVersionFiles,
	log,
}) {
	const normalizedTarget = targetArg ? normalizeVersionArg(targetArg, tagPrefix) : undefined;
	if (
		normalizedTarget &&
		parseSemver(normalizedTarget) &&
		hasGitTag(root, normalizedTarget, { tagPrefix })
	) {
		throw new Error(
			`version ${normalizedTarget} is already tagged as ${formatTag(normalizedTarget, tagPrefix)}`,
		);
	}

	const changelogPath = join(root, "CHANGELOG.md");
	const highestTag = highestSemverTag(root, { tagPrefix });
	const reachableTag = reachableSemverTag(root, "HEAD", { tagPrefix });
	const knownVersions = listSemverTagVersions(root, { tagPrefix });

	if (existsSync(changelogPath)) {
		const changelogText = readFileSync(changelogPath, "utf8");
		const { versions } = validateReleaseState(currentVersion, changelogText, repoUrl, {
			allowUnreleased: true,
			knownVersions,
			tagPrefix,
		});
		const topIsUntagged =
			versions.length > 0 && !hasGitTag(root, currentVersion, { tagPrefix });
		const changelogBase =
			versions.length === 0 || !topIsUntagged
				? currentVersion
				: (versions[1] ?? currentVersion);
		const tagVersion = highestTag ? stripTagPrefix(highestTag, tagPrefix) : undefined;
		const baseVersion =
			tagVersion && compareSemver(tagVersion, changelogBase) > 0
				? tagVersion
				: changelogBase;
		const allowSkippedStep = Boolean(
			(highestTag && reachableTag && highestTag !== reachableTag) ||
				(versions[0] && compareSemver(versions[0], baseVersion) > 0) ||
				(!topIsUntagged && versions[0] && compareSemver(baseVersion, versions[0]) > 0),
		);
		const commits = hasGitTag(root, baseVersion, { tagPrefix })
			? readCommitsInRange(root, `${formatTag(baseVersion, tagPrefix)}..HEAD`)
			: readCommitsInRange(root, "HEAD");

		const next = prepareRelease({
			changelogText,
			target: normalizedTarget,
			baseVersion,
			commits,
			repoUrl,
			replaceVersion: topIsUntagged ? versions[0] : undefined,
			allowSkippedStep,
			knownVersions,
			tagPrefix,
		});

		bumpRepoVersionFiles(root, next.version, files, { extraVersionFiles, tagPrefix });
		writeFileSync(changelogPath, next.changelogText);
		validateReleaseState(next.version, next.changelogText, repoUrl, {
			allowSkippedStep,
			knownVersions,
			tagPrefix,
		});
		log(`prepared release ${next.version}`);
		return;
	}

	const baseVersion = highestTag
		? (stripTagPrefix(highestTag, tagPrefix) ?? currentVersion)
		: currentVersion;
	const commits = readCommitsInRange(root, highestTag ? `${highestTag}..HEAD` : "HEAD");
	const { bump } = buildChangelogFromCommits(baseVersion, commits, {
		strict: false,
		repoUrl,
	});
	const target = normalizedTarget ?? bump;
	if (!target) {
		throw new Error(
			`no user-facing commits found since ${formatTag(baseVersion, tagPrefix)}`,
		);
	}
	const nextVersion = resolveTargetVersion(baseVersion, target);
	bumpRepoVersionFiles(root, nextVersion, files, { extraVersionFiles, tagPrefix });
	log(`prepared release ${nextVersion}`);
}

function resolveExecutionMode(argv, values) {
	const isActionMode =
		Boolean(values.ci) ||
		(argv.length === 0 &&
			process.env.GITHUB_ACTIONS === "true" &&
			Boolean(getInput("mode")));

	const cliFlagModes = [
		values.check && "check",
		values.notes && "notes",
		values.pr && "pr",
		values.publish && "publish",
	].filter(Boolean);
	if (cliFlagModes.length > 1) {
		throw new Error(
			`conflicting mode flags (${cliFlagModes.map((m) => `--${m}`).join(", ")})`,
		);
	}

	const rawMode = isActionMode ? getInput("mode") || "auto" : (cliFlagModes[0] ?? "bump");
	if (isActionMode && !["auto", "check", "pr", "release", "publish"].includes(rawMode)) {
		throw new Error(
			`invalid INPUT_MODE "${rawMode}"; expected auto, check, pr, release, or publish`,
		);
	}

	const eventName = process.env.GITHUB_EVENT_NAME;
	const isPullRequestEvent =
		eventName === "pull_request" || eventName === "pull_request_target";
	const mode = rawMode === "auto" && isPullRequestEvent ? "check" : rawMode;
	return { mode, isActionMode, eventName };
}

function buildPublishOptions(values, token) {
	return {
		title: values.title,
		files: values.files,
		checksums: values.checksums,
		majorTag: values["major-tag"],
		waitForCi: values["wait-for-ci"],
		waitTimeout: values["wait-timeout"],
		token,
	};
}

function runAutoOrReleaseFlow({
	mode,
	eventName,
	root,
	repoUrl,
	detected,
	dryRun,
	extraVersionFiles,
	publishFlag,
	publishOptions,
	log,
}) {
	const { version: currentVersion, files, versionsByFile, releasedChecks, tagPrefix } = detected;
	const headSubject = headCommitSubject(root);
	const releaseCommit = detectReleaseCommit(root, currentVersion, {
		headSubject,
		tagPrefix,
		trackedFiles: files,
	});
	const isTagRef = process.env.GITHUB_REF_TYPE === "tag";
	const headTagged = isHeadTagged(root, currentVersion, { tagPrefix });
	const untaggedInitial = !hasGitTag(root, currentVersion, { tagPrefix });
	const isReleaseCommit =
		mode === "release" ||
		releaseCommit.isRelease ||
		isTagRef ||
		headTagged ||
		(eventName === "workflow_dispatch" && untaggedInitial);

	if (!dryRun && !isReleaseCommit) {
		runPullRequestFlow({
			root,
			repoUrl,
			detected,
			cachedHeadSubject: headSubject,
			dryRun: false,
			extraVersionFiles,
			token: publishOptions.token,
			log,
		});
		return;
	}
	runReleaseMode({
		root,
		repoUrl,
		currentVersion,
		versionsByFile,
		releasedChecks,
		trackedFiles: files,
		tagPrefix,
		releaseVersion: releaseCommit.version,
		dryRun,
		publishFlag,
		publishOptions,
		log,
	});
}

function runPublishFlow({
	root,
	repoUrl,
	detected,
	positionalArg,
	isActionMode,
	dryRun,
	publishOptions,
	log,
}) {
	const { version: currentVersion, files, versionsByFile, releasedChecks, tagPrefix } = detected;
	const explicitVer =
		!isActionMode && positionalArg ? normalizeVersionArg(positionalArg, tagPrefix) : undefined;
	const releaseCommit = detectReleaseCommit(root, currentVersion, {
		tagPrefix,
		trackedFiles: files,
	});
	runReleaseMode({
		root,
		repoUrl,
		currentVersion,
		versionsByFile,
		releasedChecks,
		trackedFiles: files,
		tagPrefix,
		releaseVersion: explicitVer ?? releaseCommit.version,
		dryRun,
		isPublishMode: true,
		publishFlag: true,
		publishOptions,
		log,
	});
}

/** Runs the `release` CLI or GitHub Action entrypoint. */
export function main(argv = [], { log = console.log } = {}) {
	const { values, positionals } = parseCliArgs(argv);
	if (values.help) {
		console.error(USAGE_TEXT);
		return;
	}

	const root = resolve(values["working-directory"] || getInput("working-directory") || process.cwd());
	const token = getInput("token") || undefined;
	ensureFullGitHistory(root, { token });

	const repoUrl = values["repo-url"] || getInput("repo-url") || detectRepoUrl(root);
	const extraVersionFiles = values["version-files"];
	const detected = detectRepoVersion(root, {
		extraVersionFiles,
		tagPrefix: values["tag-prefix"],
		fallbackTagVersion: (prefix) => stripTagPrefix(highestSemverTag(root, { tagPrefix: prefix }) ?? "", prefix),
	});
	const { version: currentVersion, files, versionsByFile, releasedChecks, tagPrefix } = detected;
	const { mode, isActionMode, eventName } = resolveExecutionMode(argv, values);
	const dryRun = resolveDryRun(values["dry-run"]);
	const publishOptions = buildPublishOptions(values, token);

	if (mode === "check") {
		runCheckMode({
			root,
			repoUrl,
			currentVersion,
			versionsByFile,
			releasedChecks,
			tagPrefix,
			explicitRange: isActionMode ? undefined : positionals[0],
			log,
		});
		return;
	}
	if (mode === "notes") {
		const explicitArg = positionals[0];
		const targetVer = explicitArg ? normalizeVersionArg(explicitArg, tagPrefix) : currentVersion;
		process.stdout.write(
			resolveReleaseNotes(root, currentVersion, targetVer, repoUrl, {
				allowUnreleased: true,
				explicitVersion: explicitArg !== undefined,
				tagPrefix,
				trackedFiles: files,
				token,
			}),
		);
		return;
	}
	if (mode === "pr") {
		runPullRequestFlow({ root, repoUrl, detected, dryRun, extraVersionFiles, token, log });
		return;
	}
	if (mode === "publish") {
		runPublishFlow({
			root,
			repoUrl,
			detected,
			positionalArg: positionals[0],
			isActionMode,
			dryRun,
			publishOptions,
			log,
		});
		return;
	}
	if (mode === "auto" || mode === "release") {
		runAutoOrReleaseFlow({
			mode,
			eventName,
			root,
			repoUrl,
			detected,
			dryRun,
			extraVersionFiles,
			publishFlag: Boolean(values.publish),
			publishOptions,
			log,
		});
		return;
	}
	runLocalBumpMode({
		root,
		repoUrl,
		currentVersion,
		files,
		tagPrefix,
		targetArg: positionals[0],
		extraVersionFiles,
		log,
	});
}
