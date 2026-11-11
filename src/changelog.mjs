import {
	compareSemver,
	formatTag,
	isValidSemverStep,
	parseSemver,
	resolveTargetVersion,
	stripTagPrefix,
} from "./semver.mjs";

export const DEFAULT_REPO_URL = "https://github.com/owner/repo";
export const HEADING_RE = /^## \[([^\]]+)\](?: - (\S+))?$/gm;
const LINK_DEF_RE = /^\[([^\]]+)\]:\s*(\S+)\s*$/;
const TAG_LINK_URL_RE = /^(https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+)\/releases\/tag\//;
const COMMIT_RE =
	/^(feat|fix|perf|docs|refactor|test|build|ci|chore|revert|security)(?:\([a-zA-Z0-9_./-]+\))?(!)?:\s+(.+)$/;
export const RELEASE_COMMIT_RE =
	/^chore(?:\(release\))?:\s*release\s+(?:[A-Za-z_-]*?)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s+\(#\d+\))?$/i;
const TRAILING_PR_RE = /^(.*?)\s*\(#(\d+)\)[0-9.)\s]*$/;

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isValidIsoDate(date) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
	const parsed = new Date(`${date}T00:00:00Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/** Returns today's local calendar date as `YYYY-MM-DD`. */
export function todayIsoDate() {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function splitTrailingLinkDefs(changelog) {
	const lines = changelog.replaceAll("\r\n", "\n").trimEnd().split("\n");
	const links = [];
	let end = lines.length;
	while (end > 0) {
		const match = LINK_DEF_RE.exec(lines[end - 1]);
		if (!match) break;
		links.unshift({ version: match[1], url: match[2] });
		end -= 1;
	}
	return { body: lines.slice(0, end).join("\n").trimEnd(), links };
}

function inferRepoUrlFromLinks(links) {
	for (const link of links) {
		const match = TAG_LINK_URL_RE.exec(link.url);
		if (match?.[1]) return match[1];
	}
	return undefined;
}

/** Scans Keep a Changelog `## [label] - date` headings and their trimmed section bodies. */
export function scanChangelogHeadings(body) {
	return [...body.matchAll(HEADING_RE)].map((match, index, list) => {
		const headingEnd = match.index + match[0].length;
		const end = index + 1 < list.length ? list[index + 1].index : body.length;
		return {
			label: match[1],
			date: match[2],
			start: match.index,
			headingEnd,
			end,
			notes: body.slice(headingEnd, end).trim(),
		};
	});
}

function parseChangelogSections(body, allowUnreleased) {
	const headings = scanChangelogHeadings(body);
	if (headings.length === 0) {
		throw new Error("CHANGELOG.md has no `## [x.y.z] - YYYY-MM-DD` release headings");
	}
	const versions = [];
	const notesByVersion = new Map();
	let unreleasedNotes = "";

	for (const [index, heading] of headings.entries()) {
		const { label, date, notes } = heading;
		if (label === "Unreleased") {
			if (index !== 0) {
				throw new Error("CHANGELOG.md `## [Unreleased]` must appear before all releases");
			}
			if (notes !== "" && !allowUnreleased) {
				throw new Error(
					"CHANGELOG.md has unreleased notes under `## [Unreleased]`; run `release <patch|minor|major>` to stamp them",
				);
			}
			unreleasedNotes = notes;
			continue;
		}
		if (!parseSemver(label)) {
			throw new Error(`CHANGELOG.md heading "## [${label}]" is not valid semver`);
		}
		const isUnreleasedDate = index === 0 && date === "Unreleased" && allowUnreleased;
		if (!date || (!isUnreleasedDate && !isValidIsoDate(date))) {
			throw new Error(
				`CHANGELOG.md heading "## [${label}]" must carry a valid YYYY-MM-DD date`,
			);
		}
		if (notes === "") {
			throw new Error(`CHANGELOG.md section "## [${label}]" has no release notes`);
		}
		if (notesByVersion.has(label)) {
			throw new Error(`CHANGELOG.md contains duplicate "## [${label}]" headings`);
		}
		versions.push(label);
		notesByVersion.set(label, notes);
	}

	const topIsUnreleasedDate =
		allowUnreleased && headings[0]?.label === versions[0] && headings[0]?.date === "Unreleased";
	return { versions, notesByVersion, topIsUnreleasedDate, unreleasedNotes };
}

function isBridgedByKnownVersions(older, newer, knownVersions) {
	if (!knownVersions || compareSemver(older, newer) >= 0) return false;
	const between = [...knownVersions]
		.filter((v) => parseSemver(v) && compareSemver(older, v) < 0 && compareSemver(v, newer) < 0)
		.sort(compareSemver);
	if (between.length === 0) return false;
	// BFS across valid SemVer steps through tagged intermediate versions (e.g. rolled-back v0.19.1)
	const nodes = [older, ...between, newer];
	const reachable = new Set([older]);
	for (const node of nodes) {
		if (!reachable.has(node)) continue;
		if (node === newer) return true;
		for (const next of nodes) {
			if (compareSemver(node, next) < 0 && isValidSemverStep(node, next)) {
				reachable.add(next);
			}
		}
	}
	return reachable.has(newer);
}

function validateBottomTagLinks(versions, links, tagUrlPrefix, tagPrefix, skipTopUnreleasedLink) {
	const releaseLinks = links[0]?.version === "Unreleased" ? links.slice(1) : links;
	const expected =
		skipTopUnreleasedLink && releaseLinks.length === versions.length - 1
			? versions.slice(1)
			: versions;
	if (releaseLinks.length !== expected.length) {
		throw new Error(
			`CHANGELOG.md has ${releaseLinks.length} bottom tag link(s), expected ${expected.length} matching the release headings`,
		);
	}
	for (const [index, version] of expected.entries()) {
		const link = releaseLinks[index];
		const expectedUrl = `${tagUrlPrefix}${version}`;
		const suffix = `/releases/tag/${formatTag(version, tagPrefix)}`;
		const matchesUrl =
			link.url === expectedUrl ||
			(link.url.toLowerCase() === expectedUrl.toLowerCase() && link.url.endsWith(suffix));
		if (link.version !== version || !matchesUrl) {
			throw new Error(
				`CHANGELOG.md bottom link [${link.version}]: ${link.url} does not match expected [${version}]: ${expectedUrl}`,
			);
		}
	}
}

/** Validates that `pkgVersion` and `CHANGELOG.md` headings, step order, and tag links agree. */
export function validateReleaseState(pkgVersion, changelog, repoUrl, options) {
	if (!parseSemver(pkgVersion)) {
		throw new Error(`version "${pkgVersion}" is not valid semver`);
	}
	const resolvedOptions =
		typeof repoUrl === "object" && repoUrl !== null ? repoUrl : options;
	const resolvedRepoUrl = typeof repoUrl === "string" ? repoUrl : undefined;
	const allowUnreleased = Boolean(resolvedOptions?.allowUnreleased);
	const allowSkippedStep = Boolean(resolvedOptions?.allowSkippedStep);
	const knownVersions = resolvedOptions?.knownVersions;
	const tagPrefix = resolvedOptions?.tagPrefix ?? "v";
	const { body, links } = splitTrailingLinkDefs(changelog);
	const effectiveRepoUrl =
		resolvedRepoUrl || inferRepoUrlFromLinks(links) || DEFAULT_REPO_URL;
	const tagUrlPrefix = `${effectiveRepoUrl.replace(/\/+$/, "")}/releases/tag/${tagPrefix}`;
	const { versions, notesByVersion, topIsUnreleasedDate, unreleasedNotes } =
		parseChangelogSections(body, allowUnreleased);

	if (versions.length === 0) {
		if (allowUnreleased) return { versions, notesByVersion, unreleasedNotes };
		throw new Error("CHANGELOG.md has no released version sections");
	}
	if (versions[0] !== pkgVersion) {
		throw new Error(
			`CHANGELOG.md top release is ${versions[0]}, but manifest version is ${pkgVersion}`,
		);
	}
	for (let i = 0; i + 1 < versions.length; i += 1) {
		const older = versions[i + 1];
		const newer = versions[i];
		const validStep =
			isValidSemverStep(older, newer) ||
			isBridgedByKnownVersions(older, newer, knownVersions) ||
			(allowSkippedStep && i === 0 && compareSemver(older, newer) < 0);
		if (!validStep) {
			throw new Error(
				`CHANGELOG.md version ${newer} is not a valid semver step (patch, minor, or major) above ${older}`,
			);
		}
	}
	validateBottomTagLinks(versions, links, tagUrlPrefix, tagPrefix, topIsUnreleasedDate);
	return { versions, notesByVersion, unreleasedNotes };
}

/** Extracts the validated release notes for `version` (excluding bottom link definitions). */
export function extractReleaseNotes(pkgVersion, changelog, version, repoUrl, options) {
	const resolvedOptions =
		typeof repoUrl === "object" && repoUrl !== null ? repoUrl : options;
	const resolvedRepoUrl = typeof repoUrl === "string" ? repoUrl : undefined;
	const { notesByVersion, unreleasedNotes } = validateReleaseState(
		pkgVersion,
		changelog,
		resolvedRepoUrl,
		resolvedOptions,
	);
	const explicitVersion = version !== undefined;
	const targetVersion = version ?? pkgVersion;
	const notes = explicitVersion
		? notesByVersion.get(targetVersion)
		: (resolvedOptions?.allowUnreleased && unreleasedNotes ? unreleasedNotes : undefined) ||
			notesByVersion.get(targetVersion);
	if (!notes) {
		throw new Error(`CHANGELOG.md has no "## [${targetVersion}]" section to release from`);
	}
	return `${notes}\n`;
}

/** Splits a trailing `(#123)` pull request reference off a commit subject or bullet. */
export function splitTrailingPrRef(text) {
	const trimmed = text.trim();
	const match = TRAILING_PR_RE.exec(trimmed);
	if (!match || !match[1].trim()) return { text: trimmed, pr: undefined };
	return { text: match[1].trim(), pr: match[2] };
}

/** Formats a pull request or commit SHA markdown link reference. */
export function formatCommitRef({ pr, sha, repoUrl } = {}) {
	const cleanUrl =
		repoUrl && repoUrl !== DEFAULT_REPO_URL ? repoUrl.replace(/\/+$/, "") : undefined;
	if (pr) {
		return cleanUrl ? `([#${pr}](${cleanUrl}/pull/${pr}))` : `(#${pr})`;
	}
	if (sha) {
		const shortSha = sha.slice(0, 7);
		return cleanUrl ? `([${shortSha}](${cleanUrl}/commit/${sha}))` : `(${shortSha})`;
	}
	return "";
}

/** Formats a single Keep a Changelog bullet line with capitalization, punctuation, and optional commit ref. */
export function formatBullet(text, options) {
	const { text: cleanText, pr: inlinePr } = splitTrailingPrRef(text);
	const trimmed = cleanText.replace(/\s+/g, " ");
	const firstWord = trimmed.split(" ")[0] ?? "";
	const cased =
		/^[a-z]/.test(firstWord) && !/[A-Z.]/.test(firstWord)
			? trimmed[0].toUpperCase() + trimmed.slice(1)
			: trimmed;
	const punctuated = /[.!?]$/.test(cased) ? cased : `${cased}.`;
	const prefixed =
		options?.breaking && !punctuated.startsWith("**Breaking:**")
			? `**Breaking:** ${punctuated}`
			: punctuated;
	const ref = formatCommitRef({
		pr: options?.pr ?? inlinePr,
		sha: options?.sha,
		repoUrl: options?.repoUrl,
	});
	return ref ? `${prefixed} ${ref}` : prefixed;
}

/** Validates a single Conventional Commit subject line. */
export function validateCommitSubject(subject) {
	const trimmed = subject.trim();
	const match = COMMIT_RE.exec(trimmed);
	if (!match) {
		throw new Error(
			`invalid Conventional Commit subject "${trimmed}"; expected <type>: <description>`,
		);
	}
	return {
		type: match[1],
		breaking: Boolean(match[2]),
		description: match[3],
	};
}

/** Parses Conventional Commits and returns the inferred semver bump and Keep a Changelog sections. */
export function buildChangelogFromCommits(baseVersion, commits, options) {
	const strict = options?.strict ?? true;
	const repoUrl = options?.repoUrl;
	const base = parseSemver(baseVersion);
	if (!base) {
		throw new Error(`base version "${baseVersion}" is not valid semver`);
	}
	const added = new Map();
	const changed = new Map();
	const fixed = new Map();
	let hasMajorBreaking = false;
	let hasMinor = false;
	let hasPatch = false;

	const recordBullet = (bucket, rawText, fallbackPr, sha, breaking = false) => {
		const { text: cleanText, pr: textPr } = splitTrailingPrRef(rawText);
		const pr = textPr ?? fallbackPr;
		const key = formatBullet(cleanText, { breaking });
		const ref = formatCommitRef({ pr, sha, repoUrl });
		const formatted = ref ? `${key} ${ref}` : key;
		const existingBullet = bucket.get(key);
		if (!existingBullet || (pr && !/\(#\d+\)|\[#\d+\]/.test(existingBullet))) {
			bucket.set(key, formatted);
		}
	};

	for (const raw of commits) {
		const subject = raw.subject.trim();
		if (!subject || /^Revert "|^Merge /.test(subject)) continue;
		let parsed;
		try {
			parsed = validateCommitSubject(subject);
		} catch (err) {
			if (strict) throw err;
			continue;
		}
		if (RELEASE_COMMIT_RE.test(subject)) continue;

		const { text: subjectText, pr: subjectPr } = splitTrailingPrRef(parsed.description);
		const breakingMatch = /^BREAKING[ -]CHANGE:\s*(.+)$/m.exec(raw.body ?? "");
		if (parsed.breaking || breakingMatch) {
			if (base.major > 0) hasMajorBreaking = true;
			else if (parsed.type === "feat") hasMinor = true;
			else hasPatch = true;
			recordBullet(
				changed,
				breakingMatch ? breakingMatch[1] : subjectText,
				subjectPr,
				raw.sha,
				true,
			);
		} else if (parsed.type === "feat") {
			hasMinor = true;
			recordBullet(added, subjectText, subjectPr, raw.sha);
		} else if (parsed.type === "fix" || parsed.type === "security") {
			hasPatch = true;
			recordBullet(fixed, subjectText, subjectPr, raw.sha);
		} else if (parsed.type === "perf") {
			hasPatch = true;
			recordBullet(changed, subjectText, subjectPr, raw.sha);
		}
	}

	const bump = hasMajorBreaking
		? "major"
		: hasMinor
			? "minor"
			: hasPatch
				? "patch"
				: undefined;

	const sections = [];
	for (const [heading, bucket] of [
		["Added", added],
		["Changed", changed],
		["Fixed", fixed],
	]) {
		if (bucket.size > 0) {
			const lines = [...bucket.values()].map((item) => `- ${item}`);
			sections.push(`### ${heading}\n\n${lines.join("\n")}`);
		}
	}
	return { bump, markdown: sections.join("\n\n") };
}

/** Stamps `CHANGELOG.md` for `target`, generating the section body from `commits` when needed. */
export function prepareRelease(options) {
	const date = options.date ?? todayIsoDate();
	const tagPrefix = options.tagPrefix ?? "v";
	const { body, links } = splitTrailingLinkDefs(options.changelogText);
	const inferredRepoUrl = options.repoUrl || inferRepoUrlFromLinks(links);
	const repoUrl = inferredRepoUrl || DEFAULT_REPO_URL;
	const tagUrlPrefix = `${repoUrl.replace(/\/+$/, "")}/releases/tag/${tagPrefix}`;
	const baseVersion = options.baseVersion;
	if (!baseVersion) {
		throw new Error("prepareRelease requires baseVersion");
	}

	const generated = options.commits
		? buildChangelogFromCommits(baseVersion, options.commits, { repoUrl: inferredRepoUrl })
		: undefined;
	const target = options.target ?? generated?.bump;
	if (!target) {
		throw new Error(
			`no user-facing (feat, fix, perf, security, or !) commits found since ${formatTag(baseVersion, tagPrefix)}`,
		);
	}

	const version = resolveTargetVersion(baseVersion, target);
	const headings = scanChangelogHeadings(body);
	const unreleased = headings.find((h) => h.label === "Unreleased");
	const existing = headings.find((h) => h.label === version);
	const replaceOld =
		options.replaceVersion && options.replaceVersion !== version
			? headings.find((h) => h.label === options.replaceVersion)
			: undefined;
	const replaceSpan = (start, end, replacement) =>
		`${body.slice(0, start)}${replacement}${end < body.length ? `\n\n${body.slice(end)}` : ""}`;

	let nextBody;
	if (unreleased?.notes) {
		const spanEnd =
			replaceOld && replaceOld.start === unreleased.end ? replaceOld.end : unreleased.end;
		nextBody = replaceSpan(
			unreleased.start,
			spanEnd,
			`## [${version}] - ${date}\n\n${unreleased.notes}`,
		);
	} else if (existing?.notes && !options.replaceVersion) {
		nextBody = `${body.slice(0, existing.start)}## [${version}] - ${date}${body.slice(existing.headingEnd)}`;
	} else if (generated?.markdown) {
		const section = `## [${version}] - ${date}\n\n${generated.markdown}`;
		const targetSpan = replaceOld ?? existing ?? unreleased;
		if (targetSpan) {
			const spanStart =
				unreleased && unreleased.end === targetSpan.start
					? unreleased.start
					: targetSpan.start;
			nextBody = replaceSpan(spanStart, targetSpan.end, section);
		} else if (headings.length > 0) {
			nextBody = `${body.slice(0, headings[0].start)}${section}\n\n${body.slice(headings[0].start)}`;
		} else {
			nextBody = `${body.trimEnd()}\n\n${section}`;
		}
	} else if (replaceOld?.notes) {
		nextBody = replaceSpan(
			replaceOld.start,
			replaceOld.end,
			`## [${version}] - ${date}\n\n${replaceOld.notes}`,
		);
	} else if (existing?.notes) {
		nextBody = `${body.slice(0, existing.start)}## [${version}] - ${date}${body.slice(existing.headingEnd)}`;
	} else {
		throw new Error(`no changelog notes found for ${version}`);
	}

	const nextLinks = [
		{ version, url: `${tagUrlPrefix}${version}` },
		...links.filter(
			(link) =>
				link.version !== version &&
				link.version !== "Unreleased" &&
				link.version !== options.replaceVersion,
		),
	];
	const linkLines = nextLinks.map((link) => `[${link.version}]: ${link.url}`).join("\n");
	const changelogText = `${nextBody}\n\n${linkLines}\n`;
	const notes = extractReleaseNotes(version, changelogText, version, repoUrl, {
		allowSkippedStep: options.allowSkippedStep,
		knownVersions: options.knownVersions,
		tagPrefix,
	}).trim();
	return { version, changelogText, notes };
}

function formatNewContributorsSection(rawSection) {
	if (!rawSection) return undefined;
	const lines = rawSection
		.split("\n")
		.slice(1)
		.map((line) => line.trim())
		.filter((line) => Boolean(line) && !/@[^\s]+\[bot\]/i.test(line))
		.map((line) => {
			const bullet = line.replace(/^[*-]\s+/, "- ");
			const linked = bullet.replace(
				/\bin\s+(https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/(\d+))\.?$/,
				"in [#$2]($1).",
			);
			return /[.!?]$/.test(linked) ? linked : `${linked}.`;
		});
	return lines.length > 0 ? `### New Contributors\n\n${lines.join("\n")}` : undefined;
}

function formatFullChangelogLine(rawLine) {
	if (!rawLine) return undefined;
	const trimmed = rawLine.trim();
	const compareMatch = /^\*\*Full Changelog\*\*:\s*(https?:\/\/\S+\/compare\/([^\s/]+))\s*$/.exec(
		trimmed,
	);
	if (compareMatch) {
		return `**Full Changelog**: [${compareMatch[2]}](${compareMatch[1]})`;
	}
	const commitsMatch = /^\*\*Full Changelog\*\*:\s*(https?:\/\/\S+\/commits\/([^\s/]+))\s*$/.exec(
		trimmed,
	);
	if (commitsMatch) {
		return `**Full Changelog**: [${commitsMatch[2]}](${commitsMatch[1]})`;
	}
	return trimmed;
}

/** Extracts `### New Contributors` and `**Full Changelog**: ...` from GitHub's `generate-notes` markdown. */
export function extractGithubReleaseSections(generatedBody) {
	if (!generatedBody) return { newContributors: undefined, fullChangelog: undefined };
	const normalized = generatedBody.replaceAll("\r\n", "\n");
	const contributorsMatch =
		/(?:^|\n)(##+ New Contributors\n[\s\S]*?)(?=\n##+ |\n\*\*Full Changelog\*\*:|$)/.exec(
			normalized,
		);
	const changelogMatch = /(?:^|\n)(\*\*Full Changelog\*\*:[^\n]+)/.exec(normalized);
	return {
		newContributors: formatNewContributorsSection(contributorsMatch?.[1]?.trim()),
		fullChangelog: formatFullChangelogLine(changelogMatch?.[1]?.trim()),
	};
}

/** Appends GitHub's `### New Contributors` section and `**Full Changelog**` link to release notes. */
export function appendGithubReleaseSections(
	notes,
	{ repoUrl, prevTag, version, tagPrefix = "v", generatedBody } = {},
) {
	const base = notes.trim();
	const { newContributors, fullChangelog } = extractGithubReleaseSections(generatedBody);
	const cleanUrl = repoUrl?.replace(/\/+$/, "");
	const strippedVer =
		version !== undefined
			? (stripTagPrefix(version, tagPrefix) ??
				(tagPrefix !== "" && version.startsWith("v") && parseSemver(version.slice(1))
					? version.slice(1)
					: version))
			: undefined;
	const targetTag = strippedVer ? formatTag(strippedVer, tagPrefix) : undefined;
	const normalizedPrevTag = prevTag
		? tagPrefix && !prevTag.startsWith(tagPrefix) && parseSemver(prevTag)
			? formatTag(prevTag, tagPrefix)
			: prevTag
		: undefined;
	const fallbackChangelog =
		cleanUrl && targetTag
			? normalizedPrevTag
				? `**Full Changelog**: [${normalizedPrevTag}...${targetTag}](${cleanUrl}/compare/${normalizedPrevTag}...${targetTag})`
				: `**Full Changelog**: [${targetTag}](${cleanUrl}/commits/${targetTag})`
			: undefined;

	const parts = [base];
	if (
		newContributors &&
		!base.includes("### New Contributors") &&
		!base.includes("## New Contributors")
	) {
		parts.push(newContributors);
	}
	const footer = fullChangelog ?? fallbackChangelog;
	if (footer && !base.includes("**Full Changelog**:")) {
		parts.push(footer);
	}
	return `${parts.filter(Boolean).join("\n\n")}\n`;
}

/** Parses the version from a `chore: release X.Y.Z` commit subject if it matches. */
export function parseReleaseCommitSubject(subject, tagPrefix = "v") {
	if (!subject) return undefined;
	const trimmed = subject.trim();
	if (tagPrefix && tagPrefix !== "v") {
		const customRe = new RegExp(
			`^chore(?:\\(release\\))?:\\s*release\\s+(?:${escapeRegExp(tagPrefix)}|v)?(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)(?:\\s+\\(#\\d+\\))?$`,
			"i",
		);
		const customMatch = customRe.exec(trimmed);
		if (customMatch?.[1] && parseSemver(customMatch[1])) return customMatch[1];
	}
	const match = RELEASE_COMMIT_RE.exec(trimmed);
	return match?.[1] && parseSemver(match[1]) ? match[1] : undefined;
}
