import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseReleaseCommitSubject,
	scanChangelogHeadings,
	validateReleaseState,
} from "./changelog.mjs";
import { MANIFEST_CANDIDATES } from "./manifests.mjs";
import { compareSemver, formatTag, parseSemver, stripTagPrefix } from "./semver.mjs";

export function assertSafeGitRef(ref, label) {
	if (!ref || typeof ref !== "string" || ref.startsWith("-")) {
		throw new Error(`invalid git ${label} "${ref}"`);
	}
}

export function resolveAuthToken(explicitToken) {
	return (
		explicitToken ||
		process.env["INPUT_TOKEN"] ||
		process.env.GH_TOKEN ||
		process.env.GITHUB_TOKEN ||
		process.env.GITHUB_ACTION_TOKEN ||
		""
	).trim();
}

export function buildGitEnv({ auth = false, token, extraEnv } = {}) {
	const env = {
		...process.env,
		...extraEnv,
		GIT_TERMINAL_PROMPT: "0",
	};
	if (!auth) return env;
	const resolvedToken = resolveAuthToken(token);
	if (!resolvedToken) return env;

	const serverUrl = (process.env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "");
	const basic = Buffer.from(`x-access-token:${resolvedToken}`, "utf8").toString("base64");
	const baseCount = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
	const offset = Number.isFinite(baseCount) && baseCount > 0 ? baseCount : 0;
	env.GIT_CONFIG_COUNT = String(offset + 2);
	env[`GIT_CONFIG_KEY_${offset}`] = `http.${serverUrl}/.extraheader`;
	env[`GIT_CONFIG_VALUE_${offset}`] = "";
	env[`GIT_CONFIG_KEY_${offset + 1}`] = `http.${serverUrl}/.extraheader`;
	env[`GIT_CONFIG_VALUE_${offset + 1}`] = `AUTHORIZATION: basic ${basic}`;
	return env;
}

/** Runs `git` and returns trimmed stdout on exit 0 or `undefined` on non-zero exit (throwing on fatal repo errors). */
export function tryGit(cwd, args, { auth = false, timeout = 15_000, token, env } = {}) {
	const res = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		timeout,
		maxBuffer: 16 * 1024 * 1024,
		env: buildGitEnv({ auth, token, extraEnv: env }),
	});
	if (res.error) throw res.error;
	if (/not a git repository|dubious ownership/i.test(res.stderr ?? "")) {
		throw new Error(res.stderr.trim());
	}
	return res.status === 0 ? (res.stdout ?? "").trim() : undefined;
}

/** Runs `git` and returns trimmed stdout, throwing an error (without leaking env credentials) on non-zero exit. */
export function execGitOrThrow(
	cwd,
	args,
	{ auth = false, timeout = 15_000, token, input, env } = {},
) {
	const res = spawnSync("git", args, {
		cwd,
		input,
		encoding: "utf8",
		timeout,
		maxBuffer: 16 * 1024 * 1024,
		env: buildGitEnv({ auth, token, extraEnv: env }),
	});
	if (res.error) throw res.error;
	if (res.status !== 0) {
		const detail = (res.stderr ?? "").trim() || (res.stdout ?? "").trim();
		throw new Error(`Command failed: git ${args.join(" ")}${detail ? `\n${detail}` : ""}`);
	}
	return (res.stdout ?? "").trim();
}

export function hasOriginRemote(cwd) {
	return tryGit(cwd, ["remote", "get-url", "origin"]) !== undefined;
}

/** Automatically unshallows a shallow git checkout (`fetch-depth: 1`) and fetches tags from `origin`. */
export function ensureFullGitHistory(cwd, { token } = {}) {
	const isShallow = tryGit(cwd, ["rev-parse", "--is-shallow-repository"]);
	if (isShallow !== "true") return false;
	if (!hasOriginRemote(cwd)) {
		throw new Error(
			"shallow git repository detected with no 'origin' remote; fetch full history or set fetch-depth: 0 on actions/checkout",
		);
	}
	try {
		execGitOrThrow(cwd, ["fetch", "--unshallow", "--tags", "--force", "origin"], {
			auth: true,
			timeout: 120_000,
			token,
		});
	} catch (err) {
		throw new Error(
			`failed to unshallow repository from origin (set fetch-depth: 0 on actions/checkout if origin is unreachable): ${err.message}`,
		);
	}
	const baseRef = (process.env.GITHUB_BASE_REF || "").trim();
	if (baseRef && !baseRef.startsWith("-")) {
		tryGit(
			cwd,
			["fetch", "--no-tags", "origin", `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`],
			{ auth: true, timeout: 60_000, token },
		);
	}
	return true;
}

export function hasGitTag(cwd, version, { tagPrefix = "v" } = {}) {
	assertSafeGitRef(version, "version");
	const tag = formatTag(version, tagPrefix);
	return tryGit(cwd, ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]) !== undefined;
}

export function isHeadTagged(cwd, version, { tagPrefix = "v" } = {}) {
	assertSafeGitRef(version, "version");
	const tag = formatTag(version, tagPrefix);
	const headSha = tryGit(cwd, ["rev-parse", "-q", "--verify", "HEAD"]);
	const tagSha = tryGit(cwd, ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`]);
	return Boolean(headSha && tagSha && headSha === tagSha);
}

/** Lists all SemVer tags matching `tagPrefix`, sorted highest-version first. */
export function listSemverTags(cwd, { tagPrefix = "v" } = {}) {
	const raw = tryGit(cwd, ["tag", "-l"]);
	if (!raw) return [];
	return raw
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter((t) => {
			const ver = stripTagPrefix(t, tagPrefix);
			return Boolean(ver && parseSemver(ver));
		})
		.sort((a, b) =>
			compareSemver(stripTagPrefix(b, tagPrefix), stripTagPrefix(a, tagPrefix)),
		);
}

/** Returns a `Set` of bare SemVer strings for all repository tags matching `tagPrefix`. */
export function listSemverTagVersions(cwd, { tagPrefix = "v" } = {}) {
	return new Set(
		listSemverTags(cwd, { tagPrefix })
			.map((t) => stripTagPrefix(t, tagPrefix))
			.filter(Boolean),
	);
}

/** Lists all SemVer tags reachable from `fromRef`, sorted highest-version first. */
export function reachableSemverTags(cwd, fromRef = "HEAD", { tagPrefix = "v" } = {}) {
	assertSafeGitRef(fromRef, "ref");
	if (tryGit(cwd, ["rev-parse", "-q", "--verify", `${fromRef}^{commit}`]) === undefined) {
		return [];
	}
	const raw = tryGit(cwd, ["tag", "--merged", fromRef]);
	if (!raw) return [];
	return raw
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter((t) => {
			const ver = stripTagPrefix(t, tagPrefix);
			return Boolean(ver && parseSemver(ver));
		})
		.sort((a, b) =>
			compareSemver(stripTagPrefix(b, tagPrefix), stripTagPrefix(a, tagPrefix)),
		);
}

export function reachableSemverTag(cwd, fromRef = "HEAD", { tagPrefix = "v" } = {}) {
	return reachableSemverTags(cwd, fromRef, { tagPrefix })[0];
}

export function highestSemverTag(cwd, { tagPrefix = "v" } = {}) {
	return listSemverTags(cwd, { tagPrefix })[0];
}

/** Reads non-merge commits in `range` in chronological order (oldest first). */
export function readCommitsInRange(cwd, range) {
	assertSafeGitRef(range, "range");
	if (tryGit(cwd, ["rev-parse", "-q", "--verify", "HEAD"]) === undefined) {
		return [];
	}
	const raw = execGitOrThrow(cwd, [
		"log",
		"--no-merges",
		"--format=%H%x1f%s%x1f%b%x1e",
		range,
		"--",
	]);
	return raw
		.split("\x1e")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const [sha = "", subject = "", body = ""] = entry.split("\x1f");
			return { sha: sha.trim(), subject: subject.trim(), body: body.trim() };
		})
		.reverse();
}

/** Sanitizes a git remote URL (stripping embedded credentials/ports and normalizing SSH) into an `https://` web URL. */
export function sanitizeRemoteUrl(remote) {
	if (!remote || typeof remote !== "string") return undefined;
	const trimmed = remote.trim();
	if (!trimmed) return undefined;

	// SCP-like SSH syntax: [user@]host:owner/repo[.git]
	if (!trimmed.includes("://")) {
		const scpMatch = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):([^/\s][^:\s]*?)(?:\.git)?\/?$/.exec(
			trimmed,
		);
		if (!scpMatch) return undefined;
		const host = scpMatch[1];
		const repoPath = scpMatch[2].replace(/^\/+|\/+$/g, "");
		if (repoPath.split("/").filter(Boolean).length < 2) return undefined;
		return `https://${host}/${repoPath}`;
	}

	const normalizedInput = trimmed.replace(/^git\+/, "");
	if (!URL.canParse(normalizedInput)) return undefined;
	const parsed = new URL(normalizedInput);
	if (!["http:", "https:", "ssh:"].includes(parsed.protocol)) {
		return undefined;
	}
	const protocol = parsed.protocol === "http:" ? "http:" : "https:";
	const cleanPath = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
	const segments = cleanPath.split("/").filter(Boolean);
	if (!parsed.hostname || segments.length < 2) return undefined;
	return `${protocol}//${parsed.hostname}/${segments.join("/")}`;
}

/** Resolves the repository web URL from `$GITHUB_REPOSITORY` or sanitized `origin` remote URL. */
export function detectRepoUrl(cwd) {
	if (process.env.GITHUB_REPOSITORY) {
		const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
		return `${server.replace(/\/+$/, "")}/${process.env.GITHUB_REPOSITORY}`;
	}
	return sanitizeRemoteUrl(tryGit(cwd, ["remote", "get-url", "origin"]));
}

export function headCommitSubject(cwd) {
	return tryGit(cwd, ["log", "-1", "--format=%s", "HEAD"]) ?? "";
}

/** Resolves the previous release git tag before `targetVersion` from `CHANGELOG.md` or git tags. */
export function resolvePreviousReleaseTag(
	root,
	targetVersion,
	changelogText,
	{ tagPrefix = "v" } = {},
) {
	if (changelogText) {
		const versions = scanChangelogHeadings(changelogText.replaceAll("\r\n", "\n"))
			.map((h) => h.label)
			.filter((v) => v !== "Unreleased");
		const idx = versions.indexOf(targetVersion);
		const prevHeadingVersion =
			idx >= 0
				? versions[idx + 1]
				: versions[0] &&
						parseSemver(targetVersion) &&
						compareSemver(versions[0], targetVersion) < 0
					? versions[0]
					: undefined;
		if (prevHeadingVersion) return formatTag(prevHeadingVersion, tagPrefix);
	}

	const startRef = hasGitTag(root, targetVersion, { tagPrefix })
		? `${formatTag(targetVersion, tagPrefix)}~1`
		: "HEAD";
	const reachable = reachableSemverTags(root, startRef, { tagPrefix });
	const prevReachable = reachable.find((tag) => {
		const ver = stripTagPrefix(tag, tagPrefix);
		return !parseSemver(targetVersion) || (ver && compareSemver(ver, targetVersion) < 0);
	});
	if (prevReachable) return prevReachable;

	if (parseSemver(targetVersion)) {
		return listSemverTags(root, { tagPrefix }).find((tag) => {
			const ver = stripTagPrefix(tag, tagPrefix);
			return Boolean(ver && compareSemver(ver, targetVersion) < 0);
		});
	}
	return undefined;
}

/** Resolves the base branch name from `$GITHUB_REF_NAME`, `origin/HEAD`, or `"main"`. */
export function resolveBaseBranch(root, { tagPrefix = "v" } = {}) {
	const refName = (process.env.GITHUB_REF_NAME || "").trim();
	const stripped = stripTagPrefix(refName, tagPrefix);
	const isTagRef =
		process.env.GITHUB_REF_TYPE === "tag" ||
		(tagPrefix !== "" && Boolean(stripped && parseSemver(stripped)));
	if (refName && !isTagRef) {
		return refName;
	}
	const originHead = tryGit(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	if (originHead?.startsWith("origin/")) {
		return originHead.slice("origin/".length);
	}
	return "main";
}

/** Deletes `refs/heads/release/<baseBranch>` on `origin` if it exists. */
export function deleteRemoteReleaseBranch(
	root,
	baseBranch,
	{ token, tagPrefix = "v" } = {},
) {
	if (!hasOriginRemote(root)) return false;
	const resolvedBase = baseBranch ?? resolveBaseBranch(root, { tagPrefix });
	const releaseBranch = `release/${resolvedBase}`;
	const existsOnOrigin =
		tryGit(
			root,
			["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${releaseBranch}`],
			{ auth: true, timeout: 30_000, token },
		) !== undefined;
	if (!existsOnOrigin) return false;
	return (
		tryGit(root, ["push", "origin", "--delete", `refs/heads/${releaseBranch}`], {
			auth: true,
			timeout: 60_000,
			token,
		}) !== undefined
	);
}

/**
 * Builds a release commit on top of `HEAD` using a temporary `GIT_INDEX_FILE` and force-pushes
 * it to `refs/heads/<releaseBranch>` on `origin` without touching the working tree or moving `HEAD`.
 */
export function pushReleaseBranchCommit(
	root,
	{ releaseBranch, commitMessage, fileUpdates, token },
) {
	const tmpDir = mkdtempSync(join(tmpdir(), "release-index-"));
	const indexPath = join(tmpDir, "index");
	const indexEnv = { GIT_INDEX_FILE: indexPath };
	try {
		const headSha = tryGit(root, ["rev-parse", "-q", "--verify", "HEAD"]);
		if (headSha) {
			execGitOrThrow(root, ["read-tree", headSha], { env: indexEnv });
		}
		for (const [relPath, content] of fileUpdates.entries()) {
			const gitPath = relPath.replaceAll("\\", "/");
			let mode = "100644";
			if (headSha) {
				const lsOut = tryGit(root, ["ls-tree", headSha, "--", gitPath]);
				const modeMatch = /^(\d{6})\s+/.exec(lsOut ?? "");
				if (modeMatch?.[1] === "100755") mode = "100755";
			}
			const blobSha = execGitOrThrow(root, ["hash-object", "-w", "--stdin"], {
				input: content,
				env: indexEnv,
			});
			execGitOrThrow(
				root,
				["update-index", "--add", "--cacheinfo", `${mode},${blobSha},${gitPath}`],
				{ env: indexEnv },
			);
		}
		const treeSha = execGitOrThrow(root, ["write-tree"], { env: indexEnv });
		const commitSha = execGitOrThrow(
			root,
			[
				"-c",
				"user.name=github-actions[bot]",
				"-c",
				"user.email=41898282+github-actions[bot]@users.noreply.github.com",
				"commit-tree",
				treeSha,
				...(headSha ? ["-p", headSha] : []),
				"-m",
				commitMessage,
			],
			{ env: indexEnv },
		);
		execGitOrThrow(
			root,
			["push", "--force", "origin", `${commitSha}:refs/heads/${releaseBranch}`],
			{ auth: true, timeout: 60_000, token },
		);
		return commitSha;
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

function listChangedFilesInHead(root) {
	const hasParent = tryGit(root, ["rev-parse", "-q", "--verify", "HEAD^1"]) !== undefined;
	if (!hasParent) return undefined; // Initial commit
	const raw = tryGit(root, ["diff", "--name-only", "HEAD^1", "HEAD"]) ?? "";
	return raw
		.split(/\r?\n/)
		.map((f) => f.trim())
		.filter(Boolean);
}

/**
 * Detects whether `HEAD` is a release commit:
 * 1. `HEAD` commit subject matches `chore: release X.Y.Z`
 * 2. Any merged commit in `HEAD^1..HEAD^2` matches `chore: release X.Y.Z`
 * 3. `CHANGELOG.md` was stamped to an untagged `currentVersion`
 * 4. In a changelog-less repo, `HEAD` bumped a manifest above the highest existing SemVer tag
 */
export function detectReleaseCommit(root, currentVersion, headSubjectOrOptions) {
	const opts =
		typeof headSubjectOrOptions === "object" && headSubjectOrOptions !== null
			? headSubjectOrOptions
			: { headSubject: headSubjectOrOptions };
	const tagPrefix = opts.tagPrefix ?? "v";
	const headSubject = opts.headSubject ?? headCommitSubject(root);

	const directVer = parseReleaseCommitSubject(headSubject, tagPrefix);
	if (directVer) {
		return { isRelease: true, version: directVer };
	}

	if (tryGit(root, ["rev-parse", "-q", "--verify", "HEAD^2"]) !== undefined) {
		const mergedSubjects = (
			tryGit(root, ["log", "--format=%s", "HEAD^1..HEAD^2"]) ?? ""
		).split(/\r?\n/);
		for (const subject of mergedSubjects) {
			const mergeVer = parseReleaseCommitSubject(subject, tagPrefix);
			if (mergeVer) {
				return { isRelease: true, version: mergeVer };
			}
		}
	}

	if (!currentVersion || !parseSemver(currentVersion) || hasGitTag(root, currentVersion, { tagPrefix })) {
		return { isRelease: false, version: undefined };
	}

	const changelogPath = join(root, "CHANGELOG.md");
	const headFiles = listChangedFilesInHead(root);
	const trackedFiles = opts.trackedFiles ?? MANIFEST_CANDIDATES;

	if (existsSync(changelogPath)) {
		const touchedReleaseFiles =
			headFiles === undefined ||
			headFiles.includes("CHANGELOG.md") ||
			headFiles.some((f) => trackedFiles.includes(f) || MANIFEST_CANDIDATES.includes(f));
		if (touchedReleaseFiles) {
			try {
				const knownVersions = listSemverTagVersions(root, { tagPrefix });
				const { versions } = validateReleaseState(
					currentVersion,
					readFileSync(changelogPath, "utf8"),
					undefined,
					{ tagPrefix, knownVersions },
				);
				if (
					versions[0] === currentVersion &&
					(versions.length === 1 ||
						(versions[1] &&
							(hasGitTag(root, versions[1], { tagPrefix }) ||
								knownVersions.has(versions[1]))))
				) {
					return { isRelease: true, version: currentVersion };
				}
			} catch {
				// Ignore invalid/unreleased changelog state when probing for a stamped release
			}
		}
		return { isRelease: false, version: undefined };
	}

	// Changelog-less manual version bump above the highest existing tag
	const highestTag = highestSemverTag(root, { tagPrefix });
	const highestVer = highestTag ? stripTagPrefix(highestTag, tagPrefix) : undefined;
	if (
		highestVer &&
		headFiles !== undefined &&
		compareSemver(currentVersion, highestVer) > 0 &&
		headFiles.some((f) => trackedFiles.includes(f) || MANIFEST_CANDIDATES.includes(f))
	) {
		const workingDiff =
			trackedFiles.length > 0
				? (tryGit(root, ["diff", "--name-only", "HEAD", "--", ...trackedFiles]) ?? "")
				: "";
		if (workingDiff === "") {
			for (const rel of trackedFiles) {
				const gitPath = rel.replaceAll("\\", "/");
				const headBlob = tryGit(root, ["rev-parse", "-q", "--verify", `HEAD:${gitPath}`]);
				const parentBlob = tryGit(root, [
					"rev-parse",
					"-q",
					"--verify",
					`HEAD^1:${gitPath}`,
				]);
				if (headBlob && headBlob !== parentBlob) {
					return { isRelease: true, version: currentVersion };
				}
			}
		}
	}

	return { isRelease: false, version: undefined };
}
