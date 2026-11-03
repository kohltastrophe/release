#!/usr/bin/env node
/**
 * Conventional Commits validator, Keep a Changelog generator, multi-manifest
 * SemVer bumper, and automated Release PR / GitHub Release driver.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_REPO_URL = "https://github.com/owner/repo";
const SEMVER_RE =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const HEADING_RE = /^## \[([^\]]+)\](?: - (\S+))?$/gm;
const LINK_DEF_RE = /^\[([^\]]+)\]:\s*(\S+)\s*$/;
const TAG_LINK_URL_RE = /^(https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+)\/releases\/tag\/v/;
const COMMIT_RE =
	/^(feat|fix|perf|docs|refactor|test|build|ci|chore|revert|security)(?:\([a-zA-Z0-9_./-]+\))?(!)?:\s+(.+)$/;
const RELEASE_COMMIT_RE =
	/^chore(?:\(release\))?:\s*release\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s+\(#\d+\))?$/i;
const PACKAGE_TOML_SECTIONS = new Set(["package", "workspace.package", "project", "tool.poetry"]);
const MANIFEST_CANDIDATES = [
	"package.json",
	"VERSION.txt",
	"wally.toml",
	"pesde.toml",
	"rotriever.toml",
	"Cargo.toml",
	"pyproject.toml",
];

/** Parses a `MAJOR.MINOR.PATCH` (with optional `-PRERELEASE`) version string. */
export function parseSemver(version) {
	const match = SEMVER_RE.exec(version.trim());
	if (!match) return undefined;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		...(match[4] ? { prerelease: match[4] } : {}),
	};
}

function comparePrerelease(a, b) {
	const aParts = a.split(".");
	const bParts = b.split(".");
	const len = Math.max(aParts.length, bParts.length);
	for (let i = 0; i < len; i += 1) {
		const aId = aParts[i];
		const bId = bParts[i];
		if (aId === undefined) return -1;
		if (bId === undefined) return 1;
		if (aId === bId) continue;
		const aNum = /^\d+$/.test(aId) ? Number(aId) : undefined;
		const bNum = /^\d+$/.test(bId) ? Number(bId) : undefined;
		if (aNum !== undefined && bNum !== undefined) return aNum < bNum ? -1 : 1;
		if (aNum !== undefined) return -1;
		if (bNum !== undefined) return 1;
		return aId < bId ? -1 : 1;
	}
	return 0;
}

/** Returns whether `newer` is a valid `patch`, `minor`, `major`, or prerelease step above `older`. */
export function isValidSemverStep(older, newer) {
	const a = parseSemver(older);
	const b = parseSemver(newer);
	if (!a || !b) return false;
	if (b.major === a.major && b.minor === a.minor && b.patch === a.patch) {
		if (!a.prerelease) return false;
		if (!b.prerelease) return true;
		return comparePrerelease(a.prerelease, b.prerelease) < 0;
	}
	return (
		(b.major === a.major && b.minor === a.minor && b.patch === a.patch + 1) ||
		(b.major === a.major && b.minor === a.minor + 1 && b.patch === 0) ||
		(b.major === a.major + 1 && b.minor === 0 && b.patch === 0)
	);
}

/** Resolves the target version from `patch`, `minor`, `major`, or `x.y.z` against `current`. */
export function resolveTargetVersion(current, target) {
	const cur = parseSemver(current);
	if (!cur) {
		throw new Error(`current version "${current}" is not valid semver`);
	}
	if (target === "patch") return `${cur.major}.${cur.minor}.${cur.patch + 1}`;
	if (target === "minor") return `${cur.major}.${cur.minor + 1}.0`;
	if (target === "major") return `${cur.major + 1}.0.0`;
	if (!parseSemver(target)) {
		throw new Error(
			`invalid release target "${target}"; expected patch, minor, major, or x.y.z`,
		);
	}
	if (target !== current && !isValidSemverStep(current, target)) {
		throw new Error(
			`version ${target} is not a valid semver increment (patch, minor, or major) from ${current}`,
		);
	}
	return target;
}

function isValidIsoDate(date) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
	const parsed = new Date(`${date}T00:00:00Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

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

function parseChangelogSections(body, allowUnreleased) {
	const matches = [...body.matchAll(HEADING_RE)];
	if (matches.length === 0) {
		throw new Error("CHANGELOG.md has no `## [x.y.z] - YYYY-MM-DD` release headings");
	}
	const versions = [];
	const notesByVersion = new Map();

	for (const [index, match] of matches.entries()) {
		const label = match[1];
		const date = match[2];
		const sectionStart = match.index + match[0].length;
		const sectionEnd = index + 1 < matches.length ? matches[index + 1].index : body.length;
		const notes = body.slice(sectionStart, sectionEnd).trim();

		if (label === "Unreleased") {
			if (index !== 0) {
				throw new Error("CHANGELOG.md `## [Unreleased]` must appear before all releases");
			}
			if (notes !== "" && !allowUnreleased) {
				throw new Error(
					"CHANGELOG.md has unreleased notes under `## [Unreleased]`; run `release <patch|minor|major>` to stamp them",
				);
			}
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
		allowUnreleased && matches[0]?.[1] === versions[0] && matches[0]?.[2] === "Unreleased";
	return { versions, notesByVersion, topIsUnreleasedDate };
}

function validateBottomTagLinks(versions, links, tagPrefix, skipTopUnreleasedLink) {
	const expected =
		skipTopUnreleasedLink && links.length === versions.length - 1
			? versions.slice(1)
			: versions;
	if (links.length !== expected.length) {
		throw new Error(
			`CHANGELOG.md has ${links.length} bottom tag link(s), expected ${expected.length} matching the release headings`,
		);
	}
	for (const [index, version] of expected.entries()) {
		const link = links[index];
		const expectedUrl = `${tagPrefix}${version}`;
		if (link.version !== version || link.url !== expectedUrl) {
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
	const allowUnreleased = Boolean(options?.allowUnreleased);
	const { body, links } = splitTrailingLinkDefs(changelog);
	const effectiveRepoUrl = repoUrl || inferRepoUrlFromLinks(links) || DEFAULT_REPO_URL;
	const tagPrefix = `${effectiveRepoUrl.replace(/\/+$/, "")}/releases/tag/v`;
	const { versions, notesByVersion, topIsUnreleasedDate } = parseChangelogSections(
		body,
		allowUnreleased,
	);

	if (versions.length === 0) {
		if (allowUnreleased) return { versions, notesByVersion };
		throw new Error("CHANGELOG.md has no released version sections");
	}
	if (versions[0] !== pkgVersion) {
		throw new Error(
			`CHANGELOG.md top release is ${versions[0]}, but manifest version is ${pkgVersion}`,
		);
	}
	for (let i = 0; i + 1 < versions.length; i += 1) {
		if (!isValidSemverStep(versions[i + 1], versions[i])) {
			throw new Error(
				`CHANGELOG.md version ${versions[i]} is not a valid semver step (patch, minor, or major) above ${versions[i + 1]}`,
			);
		}
	}
	validateBottomTagLinks(versions, links, tagPrefix, topIsUnreleasedDate);
	return { versions, notesByVersion };
}

/** Extracts the validated release notes for `version` (excluding bottom link definitions). */
export function extractReleaseNotes(pkgVersion, changelog, version = pkgVersion, repoUrl) {
	const { notesByVersion } = validateReleaseState(pkgVersion, changelog, repoUrl);
	const notes = notesByVersion.get(version);
	if (!notes) {
		throw new Error(`CHANGELOG.md has no "## [${version}]" section to release from`);
	}
	return `${notes}\n`;
}

export function formatBullet(text) {
	const trimmed = text.trim().replace(/\s+/g, " ");
	const firstWord = trimmed.split(" ")[0] ?? "";
	const cased =
		/^[a-z]/.test(firstWord) && !/[A-Z.]/.test(firstWord)
			? trimmed[0].toUpperCase() + trimmed.slice(1)
			: trimmed;
	return /[.!?]$/.test(cased) ? cased : `${cased}.`;
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
	const base = parseSemver(baseVersion);
	if (!base) {
		throw new Error(`base version "${baseVersion}" is not valid semver`);
	}
	const added = [];
	const changed = [];
	const fixed = [];
	let hasMajorBreaking = false;
	let hasMinor = false;
	let hasPatch = false;

	for (const raw of commits) {
		const subject = raw.subject.trim();
		if (!subject || /^Revert "/.test(subject)) continue;
		let parsed;
		try {
			parsed = validateCommitSubject(subject);
		} catch (err) {
			if (strict) throw err;
			continue;
		}
		if (RELEASE_COMMIT_RE.test(subject)) continue;

		const breakingMatch = /^BREAKING[ -]CHANGE:\s*(.+)$/m.exec(raw.body ?? "");
		if (parsed.breaking || breakingMatch) {
			if (base.major > 0) hasMajorBreaking = true;
			else if (parsed.type === "feat") hasMinor = true;
			else hasPatch = true;
			changed.push(formatBullet(breakingMatch ? breakingMatch[1] : parsed.description));
		} else if (parsed.type === "feat") {
			hasMinor = true;
			added.push(formatBullet(parsed.description));
		} else if (parsed.type === "fix" || parsed.type === "security") {
			hasPatch = true;
			fixed.push(formatBullet(parsed.description));
		} else if (parsed.type === "perf") {
			hasPatch = true;
			changed.push(formatBullet(parsed.description));
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
	for (const [heading, items] of [
		["Added", added],
		["Changed", changed],
		["Fixed", fixed],
	]) {
		const unique = [...new Set(items)];
		if (unique.length > 0) {
			sections.push(`### ${heading}\n\n${unique.map((item) => `- ${item}`).join("\n")}`);
		}
	}
	return { bump, markdown: sections.join("\n\n") };
}

/** Stamps `CHANGELOG.md` for `target`, generating the section body from `commits` when needed. */
export function prepareRelease(options) {
	const date = options.date ?? todayIsoDate();
	const { body, links } = splitTrailingLinkDefs(options.changelogText);
	const repoUrl = options.repoUrl || inferRepoUrlFromLinks(links) || DEFAULT_REPO_URL;
	const tagPrefix = `${repoUrl.replace(/\/+$/, "")}/releases/tag/v`;
	const baseVersion = options.baseVersion;
	if (!baseVersion) {
		throw new Error("prepareRelease requires baseVersion");
	}

	const generated = options.commits
		? buildChangelogFromCommits(baseVersion, options.commits)
		: undefined;
	const target = options.target ?? generated?.bump;
	if (!target) {
		throw new Error(
			`no user-facing (feat, fix, perf, security, or !) commits found since v${baseVersion}`,
		);
	}

	const version = resolveTargetVersion(baseVersion, target);
	const headings = [...body.matchAll(HEADING_RE)].map((match, index, list) => ({
		label: match[1],
		date: match[2],
		start: match.index,
		headingEnd: match.index + match[0].length,
		end: index + 1 < list.length ? list[index + 1].index : body.length,
		notes: body
			.slice(
				match.index + match[0].length,
				index + 1 < list.length ? list[index + 1].index : body.length,
			)
			.trim(),
	}));
	const unreleased = headings.find((h) => h.label === "Unreleased");
	const existing = headings.find((h) => h.label === version);
	const replaceSpan = (start, end, replacement) =>
		`${body.slice(0, start)}${replacement}${end < body.length ? `\n\n${body.slice(end)}` : ""}`;

	let nextBody;
	if (unreleased?.notes) {
		nextBody = replaceSpan(
			unreleased.start,
			unreleased.end,
			`## [${version}] - ${date}\n\n${unreleased.notes}`,
		);
	} else if (existing?.date === "Unreleased" && existing.notes) {
		nextBody = `${body.slice(0, existing.start)}## [${version}] - ${date}${body.slice(existing.headingEnd)}`;
	} else if (generated?.markdown) {
		const section = `## [${version}] - ${date}\n\n${generated.markdown}`;
		const targetSpan = existing ?? unreleased;
		if (targetSpan) {
			nextBody = replaceSpan(targetSpan.start, targetSpan.end, section);
		} else if (headings.length > 0) {
			nextBody = `${body.slice(0, headings[0].start)}${section}\n\n${body.slice(headings[0].start)}`;
		} else {
			nextBody = `${body.trimEnd()}\n\n${section}`;
		}
	} else if (existing?.notes) {
		nextBody = `${body.slice(0, existing.start)}## [${version}] - ${date}${body.slice(existing.headingEnd)}`;
	} else {
		throw new Error(`no changelog notes found for ${version}`);
	}

	const nextLinks = [
		{ version, url: `${tagPrefix}${version}` },
		...links.filter((link) => link.version !== version),
	];
	const linkLines = nextLinks.map((link) => `[${link.version}]: ${link.url}`).join("\n");
	const changelogText = `${nextBody}\n\n${linkLines}\n`;
	const notes = extractReleaseNotes(version, changelogText, version, repoUrl).trim();
	return { version, changelogText, notes };
}

function locateTomlVersionLine(lines, targetSection) {
	let currentSection;
	let fallback;
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const sectionMatch = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
		if (sectionMatch) {
			currentSection = sectionMatch[1].trim();
			continue;
		}
		const verMatch = /^\s*version\s*=\s*"([^"]+)"/.exec(line);
		if (!verMatch) continue;
		if (targetSection !== undefined) {
			if (currentSection === targetSection) return { index: i, version: verMatch[1] };
			continue;
		}
		if (currentSection === undefined || PACKAGE_TOML_SECTIONS.has(currentSection)) {
			return { index: i, version: verMatch[1] };
		}
		fallback ??= { index: i, version: verMatch[1] };
	}
	return fallback;
}

function locateTomlArrayPackageField(lines, packageName, field = "version") {
	let inPackageBlock = false;
	let matchedName = false;
	let hit;
	const fieldRe = new RegExp(`^\\s*${field}\\s*=\\s*"([^"]+)"`);

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const headerMatch = /^\s*(\[\[?[^\]]+\]?\])\s*(?:#.*)?$/.exec(line);
		if (headerMatch) {
			if (inPackageBlock && matchedName && hit) return hit;
			inPackageBlock = headerMatch[1].trim() === "[[package]]";
			matchedName = false;
			hit = undefined;
			continue;
		}
		if (!inPackageBlock) continue;
		const nameMatch = /^\s*name\s*=\s*"([^"]+)"/.exec(line);
		if (nameMatch?.[1] === packageName) matchedName = true;
		const verMatch = fieldRe.exec(line);
		if (verMatch?.[1]) hit = { index: i, value: verMatch[1] };
	}
	return inPackageBlock && matchedName ? hit : undefined;
}

function parseReleaseTomlEntries(tomlText) {
	if (!/^\s*\[release(?:\.[^\]]+)?\]/m.test(tomlText)) return [];
	const entries = [];
	const uncommented = tomlText
		.split(/\r?\n/)
		.filter((line) => !/^\s*#/.test(line))
		.join("\n");
	for (const itemMatch of uncommented.matchAll(/\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)) {
		const body = itemMatch[1];
		const file = /\bfile\s*=\s*"([^"]+)"/.exec(body)?.[1];
		if (!file) continue;
		const patMatch = /\bpattern\s*=\s*(?:'([^']+)'|"([^"]+)")/.exec(body);
		const pattern = patMatch ? (patMatch[1] ?? patMatch[2]) : undefined;
		const key = /\bkey\s*=\s*"([^"]+)"/.exec(body)?.[1];
		const whereName = /\bwhere\s*=\s*\{\s*name\s*=\s*"([^"]+)"\s*\}/.exec(body)?.[1];
		const field = /\bfield\s*=\s*"([^"]+)"/.exec(body)?.[1];
		entries.push({
			file,
			...(pattern ? { pattern } : {}),
			...(key ? { key } : {}),
			...(whereName ? { whereName } : {}),
			...(field ? { field } : {}),
		});
	}
	return entries;
}

function discoverConfiguredVersionEntries(root, extraInput = process.env.INPUT_VERSION_FILES) {
	const entries = [];
	if (existsSync(root)) {
		const rootTomls = readdirSync(root)
			.filter((name) => name.endsWith(".toml"))
			.sort();
		for (const name of rootTomls) {
			try {
				entries.push(...parseReleaseTomlEntries(readFileSync(join(root, name), "utf8")));
			} catch {
				// Ignore unreadable files
			}
		}
	}
	if (extraInput?.trim()) {
		const rawItems = extraInput.includes("\n")
			? extraInput.split(/\r?\n/)
			: extraInput.split(",");
		for (const raw of rawItems) {
			const trimmed = raw.trim();
			if (!trimmed) continue;
			const colonIdx = trimmed.indexOf(":");
			if (colonIdx > 0) {
				const file = trimmed.slice(0, colonIdx).trim();
				const pattern = trimmed.slice(colonIdx + 1).trim();
				entries.push(pattern ? { file, pattern } : { file });
			} else {
				entries.push({ file: trimmed });
			}
		}
	}
	return entries;
}

function extractEntryVersion(entry, text) {
	if (entry.whereName) {
		return locateTomlArrayPackageField(
			text.split(/\r?\n/),
			entry.whereName,
			entry.field ?? "version",
		)?.value;
	}
	if (entry.pattern) {
		return new RegExp(entry.pattern, "m").exec(text)?.[1]?.trim();
	}
	if (entry.key === "version" || entry.key?.endsWith(".version") || entry.file.endsWith(".toml")) {
		const section = entry.key?.endsWith(".version")
			? entry.key.slice(0, -".version".length)
			: undefined;
		return locateTomlVersionLine(text.split(/\r?\n/), section)?.version;
	}
	if (entry.file.endsWith("package.json")) {
		const parsed = JSON.parse(text);
		return typeof parsed?.version === "string" ? parsed.version : undefined;
	}
	if (entry.file.endsWith("VERSION.txt")) return text.trim();
	if (entry.file.endsWith(".py")) return /^VERSION\s*=\s*"([^"]+)"/m.exec(text)?.[1];
	return undefined;
}

function updateEntryContent(entry, content, newVersion) {
	if (entry.whereName) {
		const field = entry.field ?? "version";
		const lines = content.split("\n");
		const hit = locateTomlArrayPackageField(lines, entry.whereName, field);
		if (!hit) return content;
		const fieldRe = new RegExp(`^(\\s*${field}\\s*=\\s*")([^"]+)(")`);
		lines[hit.index] = lines[hit.index].replace(
			fieldRe,
			(_, p1, _cur, p3) => `${p1}${newVersion}${p3}`,
		);
		return lines.join("\n");
	}
	if (entry.pattern) {
		return content.replace(new RegExp(entry.pattern, "gm"), (full, current) =>
			typeof current === "string" ? full.replace(current, () => newVersion) : full,
		);
	}
	if (entry.file.endsWith(".toml")) {
		const section = entry.key?.endsWith(".version")
			? entry.key.slice(0, -".version".length)
			: undefined;
		const lines = content.split("\n");
		const hit = locateTomlVersionLine(lines, section);
		if (!hit) return content;
		lines[hit.index] = lines[hit.index].replace(
			/^(\s*version\s*=\s*")([^"]+)(")/,
			(_, p1, _cur, p3) => `${p1}${newVersion}${p3}`,
		);
		return lines.join("\n");
	}
	if (entry.file.endsWith("package.json")) {
		return content.replace(/"version":\s*"[^"]+"/, () => `"version": "${newVersion}"`);
	}
	if (entry.file.endsWith("VERSION.txt")) {
		return `${newVersion}\n`;
	}
	if (entry.file.endsWith(".py")) {
		return content.replace(
			/^(VERSION\s*=\s*")([^"]+)(")/m,
			(_, p1, _cur, p3) => `${p1}${newVersion}${p3}`,
		);
	}
	return content;
}

function resolveSafeRepoPath(root, rel) {
	const resolvedRoot = resolve(root);
	const abs = resolve(resolvedRoot, rel);
	const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
	const segments = rel.split(/[\\/]/);
	if (!abs.startsWith(rootPrefix) || segments.includes(".git")) {
		throw new Error(`unsafe release file path "${rel}" outside repository root`);
	}
	return abs;
}

/** Reads the current version from the repository's manifests, configured `[release]` entries, or latest `v*` tag. */
export function detectRepoVersion(root) {
	const foundFiles = [];
	const versionsByFile = new Map();
	let detectedVersion;

	const allEntries = [
		...MANIFEST_CANDIDATES.map((file) => ({ file, isDefaultCandidate: true })),
		...discoverConfiguredVersionEntries(root),
	];

	for (const entry of allEntries) {
		const abs = entry.isDefaultCandidate
			? join(root, entry.file)
			: resolveSafeRepoPath(root, entry.file);
		if (!existsSync(abs)) continue;
		const ver = extractEntryVersion(entry, readFileSync(abs, "utf8"));
		if (!ver || !parseSemver(ver)) continue;
		if (!foundFiles.includes(entry.file)) {
			foundFiles.push(entry.file);
		}
		if (!entry.isDefaultCandidate && versionsByFile.has(entry.file)) {
			const detail = entry.pattern ?? entry.key ?? entry.whereName;
			if (detail) {
				versionsByFile.set(`${entry.file} (${detail})`, ver);
			}
		} else {
			versionsByFile.set(entry.file, ver);
		}
		detectedVersion ??= ver;
	}

	if (!detectedVersion) {
		const latestTag = latestGitTag(root);
		if (latestTag) detectedVersion = latestTag.replace(/^v/, "");
	}

	return { version: detectedVersion ?? "0.1.0", files: foundFiles, versionsByFile };
}

/** Updates all detected version sources in `root` (including configured `[release]` patterns if present). */
export function bumpRepoVersionFiles(root, newVersion, detectedFiles) {
	const files = detectedFiles ?? detectRepoVersion(root).files;
	const entriesByFile = new Map();
	for (const entry of discoverConfiguredVersionEntries(root)) {
		const list = entriesByFile.get(entry.file) ?? [];
		list.push(entry);
		entriesByFile.set(entry.file, list);
	}
	for (const rel of files) {
		if (!entriesByFile.has(rel)) {
			entriesByFile.set(rel, [{ file: rel }]);
		}
	}

	const modified = [];
	for (const rel of new Set([...files, ...entriesByFile.keys()])) {
		const entries = entriesByFile.get(rel);
		if (!entries) continue;
		const abs = resolveSafeRepoPath(root, rel);
		if (!existsSync(abs)) continue;
		const before = readFileSync(abs, "utf8");
		let after = before;
		for (const entry of entries) {
			after = updateEntryContent(entry, after, newVersion);
		}
		if (after !== before) {
			writeFileSync(abs, after);
			modified.push(rel);
		}
	}
	return modified;
}

function assertSafeGitRef(ref, label) {
	if (!ref || ref.startsWith("-")) {
		throw new Error(`invalid git ${label} "${ref}"`);
	}
}

function tryGit(cwd, args) {
	const res = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (res.error) throw res.error;
	if (/not a git repository|dubious ownership/i.test(res.stderr ?? "")) {
		throw new Error(res.stderr.trim());
	}
	return res.status === 0 ? (res.stdout ?? "").trim() : undefined;
}

function hasGitTag(cwd, version) {
	assertSafeGitRef(version, "version");
	return tryGit(cwd, ["rev-parse", "-q", "--verify", `refs/tags/v${version}`]) !== undefined;
}

function latestGitTag(cwd, fromRef = "HEAD") {
	assertSafeGitRef(fromRef, "ref");
	const tag = tryGit(cwd, [
		"describe",
		"--tags",
		"--abbrev=0",
		"--match",
		"v[0-9]*.[0-9]*.[0-9]*",
		fromRef,
	]);
	return tag && parseSemver(tag.slice(1)) ? tag : undefined;
}

export function readCommitsInRange(cwd, range) {
	assertSafeGitRef(range, "range");
	const raw = execFileSync(
		"git",
		["log", "--no-merges", "--format=%s%x1f%b%x1e", range, "--"],
		{ cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
	);
	return raw
		.split("\x1e")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const [subject = "", body = ""] = entry.split("\x1f");
			return { subject: subject.trim(), body: body.trim() };
		})
		.reverse();
}

function detectRepoUrl(cwd) {
	if (process.env.GITHUB_REPOSITORY) {
		const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
		return `${server.replace(/\/+$/, "")}/${process.env.GITHUB_REPOSITORY}`;
	}
	const remote = tryGit(cwd, ["remote", "get-url", "origin"]);
	if (!remote) return undefined;
	const sshMatch = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(remote);
	return sshMatch ? `https://${sshMatch[1]}/${sshMatch[2]}` : remote.replace(/\.git$/, "");
}

function writeReleaseOutputs(version, shouldRelease, notesFile) {
	const outputPath = process.env.GITHUB_OUTPUT;
	if (!outputPath) return;
	const outputs = {
		should_release: shouldRelease ? "true" : "false",
		version,
		tag: `v${version}`,
		prerelease: String(Boolean(parseSemver(version)?.prerelease)),
		...(notesFile ? { notes_file: notesFile } : {}),
	};
	const lines = Object.entries(outputs).map(([k, v]) => {
		if (/[\r\n]/.test(k) || /[\r\n]/.test(v)) {
			throw new Error(`invalid newline in GitHub output "${k}"`);
		}
		return `${k}=${v}`;
	});
	appendFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
}

function headCommitSubject(cwd) {
	return execFileSync("git", ["log", "-1", "--format=%s", "HEAD"], {
		cwd,
		encoding: "utf8",
	}).trim();
}

function parseGithubRepoSlug(repoUrl) {
	if (!repoUrl) return process.env.GITHUB_REPOSITORY || undefined;
	const match = /^https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\/|\.git)?$/.exec(repoUrl.trim());
	return match?.[1] ?? (process.env.GITHUB_REPOSITORY || undefined);
}

/** Extracts `## New Contributors` and `**Full Changelog**: ...` from GitHub's `generate-notes` markdown. */
export function extractGithubReleaseSections(generatedBody) {
	if (!generatedBody) return { newContributors: undefined, fullChangelog: undefined };
	const normalized = generatedBody.replaceAll("\r\n", "\n");
	const contributorsMatch =
		/(?:^|\n)(## New Contributors\n[\s\S]*?)(?=\n## |\n\*\*Full Changelog\*\*:|$)/.exec(
			normalized,
		);
	const changelogMatch = /(?:^|\n)(\*\*Full Changelog\*\*:[^\n]+)/.exec(normalized);
	return {
		newContributors: contributorsMatch?.[1]?.trim() || undefined,
		fullChangelog: changelogMatch?.[1]?.trim() || undefined,
	};
}

/** Appends GitHub's `## New Contributors` section and `**Full Changelog**` link to release notes. */
export function appendGithubReleaseSections(
	notes,
	{ repoUrl, prevTag, version, generatedBody } = {},
) {
	const base = notes.trim();
	const { newContributors, fullChangelog } = extractGithubReleaseSections(generatedBody);
	const cleanUrl = repoUrl?.replace(/\/+$/, "");
	const cleanVersion = version?.replace(/^v/, "");
	const normalizedPrevTag = prevTag
		? prevTag.startsWith("v")
			? prevTag
			: `v${prevTag}`
		: undefined;
	const fallbackChangelog =
		cleanUrl && cleanVersion
			? normalizedPrevTag
				? `**Full Changelog**: ${cleanUrl}/compare/${normalizedPrevTag}...v${cleanVersion}`
				: `**Full Changelog**: ${cleanUrl}/commits/v${cleanVersion}`
			: undefined;

	const parts = [base];
	if (newContributors && !base.includes("## New Contributors")) {
		parts.push(newContributors);
	}
	const footer = fullChangelog ?? fallbackChangelog;
	if (footer && !base.includes("**Full Changelog**:")) {
		parts.push(footer);
	}
	return `${parts.filter(Boolean).join("\n\n")}\n`;
}

function fetchGithubGeneratedNotes(cwd, repoUrl, tagName, prevTag, targetCommitish) {
	const slug = parseGithubRepoSlug(repoUrl);
	if (!slug) return undefined;
	const args = [
		"api",
		`repos/${slug}/releases/generate-notes`,
		"-f",
		`tag_name=${tagName}`,
		...(targetCommitish ? ["-f", `target_commitish=${targetCommitish}`] : []),
		...(prevTag ? ["-f", `previous_tag_name=${prevTag}`] : []),
		"--jq",
		".body",
	];
	const res = spawnSync("gh", args, { cwd, encoding: "utf8", timeout: 15_000 });
	if (res.error || res.status !== 0) return undefined;
	return (res.stdout ?? "").trim() || undefined;
}

function resolvePreviousReleaseTag(root, targetVersion, changelogText) {
	if (changelogText) {
		const versions = [...changelogText.replaceAll("\r\n", "\n").matchAll(HEADING_RE)]
			.map((m) => m[1])
			.filter((v) => v !== "Unreleased");
		const idx = versions.indexOf(targetVersion);
		const prevHeadingVersion = idx >= 0 ? versions[idx + 1] : versions[0];
		if (prevHeadingVersion) return `v${prevHeadingVersion}`;
	}
	const fromRef = hasGitTag(root, targetVersion) ? `v${targetVersion}~1` : "HEAD~1";
	return latestGitTag(root, fromRef);
}

function resolveReleaseNotes(root, pkgVersion, targetVersion, repoUrl) {
	const changelogPath = join(root, "CHANGELOG.md");
	let changelogText;
	let baseNotes;
	if (existsSync(changelogPath)) {
		changelogText = readFileSync(changelogPath, "utf8");
		baseNotes = extractReleaseNotes(pkgVersion, changelogText, targetVersion, repoUrl);
	} else {
		const prevTag = latestGitTag(root, "HEAD~1");
		const baseVer = prevTag ? prevTag.replace(/^v/, "") : "0.0.0";
		const range = prevTag ? `${prevTag}..HEAD` : "HEAD";
		const { markdown } = buildChangelogFromCommits(baseVer, readCommitsInRange(root, range), {
			strict: false,
		});
		baseNotes = `${markdown}\n`;
	}
	const prevTag = resolvePreviousReleaseTag(root, targetVersion, changelogText);
	const generatedBody = fetchGithubGeneratedNotes(
		root,
		repoUrl,
		`v${targetVersion}`,
		prevTag,
		tryGit(root, ["rev-parse", "HEAD"]),
	);
	return appendGithubReleaseSections(baseNotes, {
		repoUrl,
		prevTag,
		version: targetVersion,
		generatedBody,
	});
}

function publishReleasePullRequest(
	root,
	baseBranch,
	nextVersion,
	markdown,
	modifiedFiles,
	repoUrl,
	prevTag,
) {
	const releaseBranch = `release/${baseBranch}`;
	const prTitle = `chore: release ${nextVersion}`;
	const generatedBody = fetchGithubGeneratedNotes(
		root,
		repoUrl,
		`v${nextVersion}`,
		prevTag,
		baseBranch,
	);
	const prBody = appendGithubReleaseSections(
		`## [${nextVersion}] - ${todayIsoDate()}\n\n${markdown}`,
		{ repoUrl, prevTag, version: nextVersion, generatedBody },
	);

	execFileSync("git", ["checkout", "-B", releaseBranch], { cwd: root });
	if (modifiedFiles.length > 0) {
		execFileSync("git", ["add", "--", ...new Set(modifiedFiles)], { cwd: root });
	}
	execFileSync(
		"git",
		[
			"-c",
			"user.name=github-actions[bot]",
			"-c",
			"user.email=41898282+github-actions[bot]@users.noreply.github.com",
			"commit",
			"--allow-empty",
			"--no-gpg-sign",
			"-m",
			prTitle,
		],
		{ cwd: root },
	);
	execFileSync("git", ["push", "--force", "origin", `HEAD:refs/heads/${releaseBranch}`], {
		cwd: root,
		timeout: 60_000,
	});

	const existingPr = execFileSync(
		"gh",
		[
			"pr",
			"list",
			"--head",
			releaseBranch,
			"--base",
			baseBranch,
			"--state",
			"open",
			"--json",
			"number",
			"--jq",
			".[0].number // empty",
		],
		{ cwd: root, encoding: "utf8", timeout: 60_000 },
	).trim();

	const ghArgs = existingPr
		? ["pr", "edit", existingPr, "--title", prTitle, "--body", prBody]
		: [
				"pr",
				"create",
				"--head",
				releaseBranch,
				"--base",
				baseBranch,
				"--title",
				prTitle,
				"--body",
				prBody,
			];
	execFileSync("gh", ghArgs, { cwd: root, stdio: "inherit", timeout: 60_000 });
}

function runPullRequestFlow(root, repoUrl, cachedHeadSubject) {
	const headSubject = cachedHeadSubject ?? headCommitSubject(root);
	const { version: manifestVersion, files } = detectRepoVersion(root);
	if (RELEASE_COMMIT_RE.test(headSubject)) {
		console.log(`HEAD is already a release commit ("${headSubject}"); skipping PR creation`);
		writeReleaseOutputs(manifestVersion, false);
		return;
	}

	const tag = latestGitTag(root, "HEAD");
	const baseVersion = tag ? tag.replace(/^v/, "") : manifestVersion;
	const commits = readCommitsInRange(root, tag ? `${tag}..HEAD` : "HEAD");
	const changelogPath = join(root, "CHANGELOG.md");
	const hasChangelog = existsSync(changelogPath);
	const { bump, markdown } = buildChangelogFromCommits(baseVersion, commits, {
		strict: hasChangelog,
	});

	if (!bump || !markdown) {
		console.log(`no releasable commits since v${baseVersion}; skipping release PR`);
		writeReleaseOutputs(baseVersion, false);
		return;
	}

	const nextVersion = tag ? resolveTargetVersion(baseVersion, bump) : baseVersion;
	const modifiedFiles = bumpRepoVersionFiles(root, nextVersion, files);

	if (hasChangelog) {
		const prepared = prepareRelease({
			changelogText: readFileSync(changelogPath, "utf8"),
			target: nextVersion,
			baseVersion,
			commits,
			repoUrl,
		});
		writeFileSync(changelogPath, prepared.changelogText);
		modifiedFiles.push("CHANGELOG.md");
	}

	const baseBranch = process.env.GITHUB_REF_NAME || "main";
	publishReleasePullRequest(root, baseBranch, nextVersion, markdown, modifiedFiles, repoUrl, tag);
	writeReleaseOutputs(nextVersion, false);
}

function validateVersionConsistency(currentVersion, versionsByFile) {
	for (const [file, ver] of versionsByFile.entries()) {
		if (ver !== currentVersion) {
			throw new Error(
				`manifest version mismatch: ${file} has ${ver}, expected ${currentVersion}`,
			);
		}
	}
	const refName = process.env.GITHUB_REF_NAME;
	if (
		refName?.startsWith("v") &&
		parseSemver(refName.slice(1)) &&
		refName !== `v${currentVersion}`
	) {
		throw new Error(
			`git tag (${refName}) does not match manifest version (v${currentVersion})`,
		);
	}
}

function runCheckMode(root, repoUrl, currentVersion, versionsByFile, explicitRange) {
	const prTitle = process.env.PR_TITLE || process.env.INPUT_PR_TITLE;
	if (prTitle && !/^Revert "/.test(prTitle.trim())) {
		validateCommitSubject(prTitle);
	}
	validateVersionConsistency(currentVersion, versionsByFile);

	const changelogPath = join(root, "CHANGELOG.md");
	let range = explicitRange;
	let baseTag;
	if (existsSync(changelogPath)) {
		const state = validateReleaseState(
			currentVersion,
			readFileSync(changelogPath, "utf8"),
			repoUrl,
			{ allowUnreleased: !hasGitTag(root, currentVersion) },
		);
		baseTag = state.versions.find((v) => hasGitTag(root, v));
		range ??= baseTag ? `v${baseTag}..HEAD` : undefined;
	}

	if (range) {
		buildChangelogFromCommits(baseTag ?? currentVersion, readCommitsInRange(root, range));
	} else {
		const headSubject = headCommitSubject(root);
		if (headSubject && !/^Revert "/.test(headSubject)) {
			validateCommitSubject(headSubject);
		}
	}

	writeReleaseOutputs(currentVersion, false);
	console.log(`release state valid (${currentVersion})`);
}

function runReleaseMode(root, repoUrl, currentVersion, versionsByFile, releaseVersion, dryRun = false) {
	const version = releaseVersion ?? currentVersion;
	if (!parseSemver(version)) {
		throw new Error(`release version "${version}" is not valid semver`);
	}
	validateVersionConsistency(version, versionsByFile);
	const notesFile = join(root, "release-notes.md");
	writeFileSync(notesFile, resolveReleaseNotes(root, version, version, repoUrl), "utf8");
	writeReleaseOutputs(version, !dryRun, notesFile);
	console.log(dryRun ? `dry-run validated v${version}` : `ready to release v${version}`);
}

function runLocalBumpMode(root, repoUrl, currentVersion, files, targetArg) {
	const changelogPath = join(root, "CHANGELOG.md");
	if (existsSync(changelogPath)) {
		const changelogText = readFileSync(changelogPath, "utf8");
		const { versions } = validateReleaseState(currentVersion, changelogText, repoUrl, {
			allowUnreleased: true,
		});
		const baseVersion =
			versions.length === 0 || hasGitTag(root, currentVersion)
				? currentVersion
				: (versions[1] ?? currentVersion);
		const commits = hasGitTag(root, baseVersion)
			? readCommitsInRange(root, `v${baseVersion}..HEAD`)
			: undefined;

		const next = prepareRelease({
			changelogText,
			target: targetArg,
			baseVersion,
			commits,
			repoUrl,
		});

		bumpRepoVersionFiles(root, next.version, files);
		writeFileSync(changelogPath, next.changelogText);
		validateReleaseState(next.version, next.changelogText, repoUrl);
		console.log(`prepared release ${next.version}`);
		return;
	}

	const tag = latestGitTag(root, "HEAD");
	const baseVersion = tag ? tag.replace(/^v/, "") : currentVersion;
	const commits = readCommitsInRange(root, tag ? `${tag}..HEAD` : "HEAD");
	const { bump } = buildChangelogFromCommits(baseVersion, commits, { strict: false });
	const target = targetArg ?? bump;
	if (!target) {
		throw new Error(`no user-facing commits found since v${baseVersion}`);
	}
	const nextVersion = resolveTargetVersion(baseVersion, target);
	bumpRepoVersionFiles(root, nextVersion, files);
	console.log(`prepared release ${nextVersion}`);
}

export function main(argv) {
	const root = resolve(process.env.INPUT_WORKING_DIRECTORY || process.cwd());
	const repoUrl = process.env.INPUT_REPO_URL || detectRepoUrl(root);
	const { version: currentVersion, files, versionsByFile } = detectRepoVersion(root);

	const isCi = argv[0] === "--ci";
	const rawMode = isCi ? (process.env.INPUT_MODE || "auto") : argv[0];
	if (isCi && !["auto", "check", "pr", "release"].includes(rawMode)) {
		throw new Error(`invalid INPUT_MODE "${rawMode}"; expected auto, check, pr, or release`);
	}

	const dryRun = process.env.INPUT_DRY_RUN === "true";
	const eventName = process.env.GITHUB_EVENT_NAME;
	const isPullRequestEvent =
		eventName === "pull_request" || eventName === "pull_request_target";
	const mode = rawMode === "auto" && isPullRequestEvent ? "check" : rawMode;

	if (mode === "--help" || mode === "-h") {
		console.error(
			"usage: release [patch|minor|major|x.y.z] | --check [range] | --notes [x.y.z] | --pr",
		);
		return;
	}
	if (mode === "--check" || mode === "check") {
		runCheckMode(root, repoUrl, currentVersion, versionsByFile, isCi ? undefined : argv[1]);
		return;
	}
	if (mode === "--notes" || mode === "notes") {
		process.stdout.write(
			resolveReleaseNotes(root, currentVersion, argv[1] ?? currentVersion, repoUrl),
		);
		return;
	}
	if (mode === "--pr" || mode === "pr") {
		runPullRequestFlow(root, repoUrl);
		return;
	}
	if (mode === "auto" || mode === "release") {
		const headSubject = headCommitSubject(root);
		const releaseMatch = RELEASE_COMMIT_RE.exec(headSubject);
		const isTagRef = process.env.GITHUB_REF_TYPE === "tag";
		const isWorkflowDispatch = eventName === "workflow_dispatch";
		if (dryRun || (mode === "auto" && isWorkflowDispatch && !releaseMatch && !isTagRef)) {
			runReleaseMode(
				root,
				repoUrl,
				currentVersion,
				versionsByFile,
				releaseMatch?.[1],
				dryRun || !isTagRef,
			);
			return;
		}
		if (mode === "auto" && !releaseMatch && !isTagRef) {
			runPullRequestFlow(root, repoUrl, headSubject);
			return;
		}
		runReleaseMode(root, repoUrl, currentVersion, versionsByFile, releaseMatch?.[1], false);
		return;
	}
	if (mode?.startsWith("-")) {
		throw new Error(`unknown option "${mode}"`);
	}

	runLocalBumpMode(root, repoUrl, currentVersion, files, argv[0]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
}
