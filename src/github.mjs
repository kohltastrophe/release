import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { appendGithubReleaseSections, todayIsoDate } from "./changelog.mjs";
import {
	deleteRemoteReleaseBranch,
	detectReleaseCommit,
	execGitOrThrow,
	hasOriginRemote,
	listSemverTags,
	pushReleaseBranchCommit,
	resolveBaseBranch,
	tryGit,
} from "./git.mjs";
import { resolveSafeRepoPath } from "./manifests.mjs";
import { compareSemver, formatTag, parseSemver, stripTagPrefix } from "./semver.mjs";

const PASSING_CI_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/** Reads a GitHub Action input from either `INPUT_FOO-BAR` (`node24`) or `INPUT_FOO_BAR`. */
export function getInput(name) {
	const upper = name.toUpperCase();
	const hyphenVal = process.env[`INPUT_${upper}`];
	if (typeof hyphenVal === "string" && hyphenVal.trim() !== "") {
		return hyphenVal.trim();
	}
	const underscoreVal = process.env[`INPUT_${upper.replaceAll("-", "_")}`];
	if (typeof underscoreVal === "string") {
		return underscoreVal.trim();
	}
	return typeof hyphenVal === "string" ? hyphenVal.trim() : "";
}

export function parseGithubRepoSlug(repoUrl) {
	if (repoUrl) {
		const match = /^https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\/|\.git)?$/.exec(repoUrl.trim());
		if (match?.[1]) return match[1];
	}
	return process.env.GITHUB_REPOSITORY || undefined;
}

function spawnGhWithFallback(args, cwd, { timeout = 30_000, token } = {}) {
	const fallbackToken = (process.env.GITHUB_ACTION_TOKEN || "").trim();
	const primaryToken = (
		token ||
		getInput("token") ||
		process.env.GH_TOKEN ||
		process.env.GITHUB_TOKEN ||
		fallbackToken
	).trim();
	const baseEnv = primaryToken
		? { ...process.env, GH_TOKEN: primaryToken, GITHUB_TOKEN: primaryToken }
		: process.env;
	let res = spawnSync("gh", args, {
		cwd,
		encoding: "utf8",
		timeout,
		maxBuffer: 16 * 1024 * 1024,
		env: baseEnv,
	});
	// Never retry on ETIMEDOUT or spawn error to avoid duplicating non-idempotent mutations
	if (
		!res.error &&
		res.status !== 0 &&
		fallbackToken &&
		fallbackToken !== primaryToken
	) {
		res = spawnSync("gh", args, {
			cwd,
			encoding: "utf8",
			timeout,
			maxBuffer: 16 * 1024 * 1024,
			env: {
				...process.env,
				GH_TOKEN: fallbackToken,
				GITHUB_TOKEN: fallbackToken,
			},
		});
	}
	return res;
}

export function execGhOrThrow(args, cwd, options = {}) {
	const res = spawnGhWithFallback(args, cwd, options);
	if (res.error) throw res.error;
	if (res.status !== 0) {
		const detail = (res.stderr ?? "").trim() || (res.stdout ?? "").trim();
		throw new Error(`Command failed: gh ${args.join(" ")}${detail ? `\n${detail}` : ""}`);
	}
	return (res.stdout ?? "").trim();
}

export function fetchGithubGeneratedNotes(
	cwd,
	repoUrl,
	tagName,
	prevTag,
	targetCommitish,
	{ token } = {},
) {
	const slug = parseGithubRepoSlug(repoUrl);
	if (!slug) return undefined;
	const args = [
		"api",
		`repos/${slug}/releases/generate-notes`,
		"-f",
		`tag_name=${tagName}`,
		...(targetCommitish ? ["-f", `target_commitish=${targetCommitish}`] : []),
		...(prevTag ? ["-f", `previous_tag_name=${prevTag}`] : []),
	];
	const res = spawnGhWithFallback(args, cwd, { timeout: 30_000, token });
	if (res.error || res.status !== 0) return undefined;
	const raw = (res.stdout ?? "").trim();
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed?.body === "string" ? parsed.body.trim() || undefined : undefined;
	} catch {
		return raw;
	}
}

/** Parses the JSON response from `GET /repos/{owner}/{repo}/actions/workflows/{workflow}/runs`. */
export function parseWorkflowRunsResponse(raw) {
	if (!raw || !raw.trim()) return { status: "none", conclusion: "none" };
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		const [status = "none", conclusion = "none"] = raw.trim().split(/\s+/);
		return { status, conclusion };
	}
	const runs = Array.isArray(parsed?.workflow_runs) ? parsed.workflow_runs : [];
	if (runs.length === 0) return { status: "none", conclusion: "none" };
	const nonCancelled = runs.filter(
		(r) =>
			r?.event !== "schedule" &&
			!(r?.event === "pull_request" && r?.conclusion === "cancelled"),
	);
	const pool = nonCancelled.length > 0 ? nonCancelled : runs;
	const pushOrDispatch = pool.filter(
		(r) => r?.event === "push" || r?.event === "workflow_dispatch",
	);
	const candidates = pushOrDispatch.length > 0 ? pushOrDispatch : pool;
	let latest = candidates[0];
	for (const run of candidates) {
		if ((run?.run_number ?? 0) >= (latest?.run_number ?? 0)) {
			latest = run;
		}
	}
	return {
		status: latest?.status || "none",
		conclusion: latest?.conclusion || "none",
	};
}

function queryCiWorkflowStatus(runGh, slug, workflow, headSha, isDispatchOrTag) {
	const encodedWorkflow = encodeURIComponent(workflow);
	const baseQuery = `repos/${slug}/actions/workflows/${encodedWorkflow}/runs?head_sha=${headSha}&per_page=100`;
	const endpoint = isDispatchOrTag ? baseQuery : `${baseQuery}&event=push`;
	const raw = runGh(["api", endpoint]);
	if (raw === undefined) return undefined;
	return parseWorkflowRunsResponse(raw);
}

function pollSingleCiWorkflow({
	workflow,
	slug,
	headSha,
	timeoutMinutes,
	isDispatchOrTag,
	runGh,
	getLastError,
	sleep,
	log,
}) {
	const deadline = Date.now() + Number(timeoutMinutes) * 60_000;
	let apiErrors = 0;
	let empty = 0;

	while (true) {
		const out = queryCiWorkflowStatus(runGh, slug, workflow, headSha, isDispatchOrTag);
		if (out === undefined) {
			apiErrors += 1;
			if (apiErrors >= 8) {
				const detail = getLastError() ? `: ${getLastError()}` : "";
				throw new Error(
					`failed to query CI workflow "${workflow}" after 8 consecutive gh api errors${detail}`,
				);
			}
		} else {
			apiErrors = 0;
			const { status, conclusion } = out;
			if (status === "none") {
				empty += 1;
				if (empty >= 20) {
					throw new Error(
						`no CI workflow run found for "${workflow}" on ${headSha} after 5 minutes`,
					);
				}
				log(
					`waiting for CI workflow "${workflow}" on ${headSha.slice(0, 7)} (not registered yet, check ${empty}/20)...`,
				);
			} else if (status === "completed") {
				if (PASSING_CI_CONCLUSIONS.has(conclusion)) {
					log(
						`CI workflow "${workflow}" passed (${conclusion}) on ${headSha.slice(0, 7)}`,
					);
					return;
				}
				throw new Error(
					`CI workflow "${workflow}" concluded "${conclusion}" for ${headSha}`,
				);
			} else {
				empty = 0;
				log(
					`waiting for CI workflow "${workflow}" on ${headSha.slice(0, 7)} (status=${status})...`,
				);
			}
		}

		if (Date.now() >= deadline) {
			throw new Error(`timed out waiting for CI workflow "${workflow}" on ${headSha}`);
		}
		sleep(15_000);
	}
}

/** Polls GitHub Actions until all specified CI workflows complete with a passing conclusion (`success`, `neutral`, or `skipped`). */
export function waitForCiWorkflows(
	root,
	repoUrl,
	workflowsInput,
	timeoutMinutes = 30,
	{ execGh, sleepSync, log = console.log, token } = {},
) {
	const workflows = (workflowsInput ?? "")
		.split(/[\r\n,]+/)
		.map((w) => w.trim())
		.filter(Boolean);
	if (workflows.length === 0) return;

	const slug = parseGithubRepoSlug(repoUrl);
	const headSha = process.env.GITHUB_SHA || tryGit(root, ["rev-parse", "HEAD"]);
	if (!slug || !headSha) {
		throw new Error("cannot wait for CI without repository slug and HEAD SHA");
	}

	let lastGhError = "";
	const runGh =
		execGh ??
		((args) => {
			const res = spawnGhWithFallback(args, root, { timeout: 30_000, token });
			if (res.error || res.status !== 0) {
				lastGhError = (res.stderr ?? "").trim() || res.error?.message || "";
				return undefined;
			}
			return (res.stdout ?? "").trim();
		});
	const sleep =
		sleepSync ??
		((ms) => {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
		});
	const isDispatchOrTag =
		process.env.GITHUB_EVENT_NAME === "workflow_dispatch" ||
		process.env.GITHUB_REF_TYPE === "tag";

	for (const workflow of workflows) {
		pollSingleCiWorkflow({
			workflow,
			slug,
			headSha,
			timeoutMinutes,
			isDispatchOrTag,
			runGh,
			getLastError: () => lastGhError,
			sleep,
			log,
		});
	}
}

function parseOpenReleasePr(rawPrList) {
	if (!rawPrList) return { number: "", url: "" };
	try {
		const parsedPrs = JSON.parse(rawPrList);
		const first = parsedPrs?.[0];
		return {
			number: first?.number ? String(first.number) : "",
			url: typeof first?.url === "string" ? first.url : "",
		};
	} catch {
		const trimmed = rawPrList.trim();
		return { number: /^\d+$/.test(trimmed) ? trimmed : "", url: "" };
	}
}

function extractUrlAndPrNumber(output, repoUrl, fallbackNumber = "") {
	const urlMatch = /https?:\/\/\S+/.exec(output ?? "");
	const url = urlMatch ? urlMatch[0].trim() : "";
	const numMatch = /\/pull\/(\d+)/.exec(url);
	const prNumber = numMatch?.[1] || fallbackNumber;
	const prUrl =
		url ||
		(repoUrl && prNumber ? `${repoUrl.replace(/\/+$/, "")}/pull/${prNumber}` : "");
	return { prNumber, prUrl };
}

/** Pushes the `release/<base>` branch via Git plumbing and opens or updates the Release PR. */
export function publishReleasePullRequest(
	root,
	{
		baseBranch = resolveBaseBranch(root),
		nextVersion,
		markdown,
		fileUpdates,
		repoUrl,
		prevTag,
		tagPrefix = "v",
		token,
	},
) {
	const releaseBranch = `release/${baseBranch}`;
	const prTitle = `chore: release ${nextVersion}`;
	const generatedBody = fetchGithubGeneratedNotes(
		root,
		repoUrl,
		formatTag(nextVersion, tagPrefix),
		prevTag,
		baseBranch,
		{ token },
	);
	const prBody = appendGithubReleaseSections(
		`## [${nextVersion}] - ${todayIsoDate()}\n\n${markdown}`,
		{ repoUrl, prevTag, version: nextVersion, tagPrefix, generatedBody },
	);

	const hadRemoteBranch =
		hasOriginRemote(root) &&
		tryGit(
			root,
			["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${releaseBranch}`],
			{ auth: true, timeout: 30_000, token },
		) !== undefined;

	pushReleaseBranchCommit(root, {
		releaseBranch,
		commitMessage: prTitle,
		fileUpdates,
		token,
	});

	let existingPr = { number: "", url: "" };
	try {
		const rawPrList = execGhOrThrow(
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
				"number,url",
			],
			root,
			{ timeout: 30_000, token },
		);
		existingPr = parseOpenReleasePr(rawPrList);
		if (existingPr.number) {
			const editOut = execGhOrThrow(
				["pr", "edit", existingPr.number, "--title", prTitle, "--body", prBody],
				root,
				{ timeout: 30_000, token },
			);
			const resolved = extractUrlAndPrNumber(
				editOut || existingPr.url,
				repoUrl,
				existingPr.number,
			);
			return { ...resolved, prTitle, created: false };
		}
		const createOut = execGhOrThrow(
			[
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
			],
			root,
			{ timeout: 30_000, token },
		);
		const resolved = extractUrlAndPrNumber(createOut, repoUrl);
		return { ...resolved, prTitle, created: true };
	} catch (error) {
		if (!hadRemoteBranch && !existingPr.number) {
			deleteRemoteReleaseBranch(root, baseBranch, { token, tagPrefix });
		}
		throw error;
	}
}

/** Verifies all SHA-256 digests in a `SHA256SUMS` file against the files in its directory. */
export function verifySha256Sums(sumsFilePath) {
	const dir = dirname(sumsFilePath);
	const lines = readFileSync(sumsFilePath, "utf8")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length === 0) {
		throw new Error(`SHA256SUMS file "${sumsFilePath}" is empty`);
	}
	for (const line of lines) {
		const match = /^([0-9a-fA-F]{64})\s+[ *]?(.+)$/.exec(line);
		if (!match) {
			throw new Error(`invalid SHA256SUMS entry "${line}" in ${sumsFilePath}`);
		}
		const expected = match[1].toLowerCase();
		const relTarget = match[2].trim();
		const targetAbs = resolveSafeRepoPath(dir, relTarget);
		if (!existsSync(targetAbs)) {
			throw new Error(`SHA256SUMS references missing file "${relTarget}"`);
		}
		const actual = createHash("sha256").update(readFileSync(targetAbs)).digest("hex");
		if (actual !== expected) {
			throw new Error(
				`SHA256 mismatch for "${relTarget}": expected ${expected}, got ${actual}`,
			);
		}
	}
}

/** Generates a `SHA256SUMS` file at `sumsFilePath` for `assetPaths` (using paths relative to `dirname(sumsFilePath)`). */
export function generateSha256Sums(sumsFilePath, assetPaths) {
	const baseDir = dirname(sumsFilePath);
	mkdirSync(baseDir, { recursive: true });
	const lines = assetPaths.map((assetAbs) => {
		const digest = createHash("sha256").update(readFileSync(assetAbs)).digest("hex");
		const rel = relative(baseDir, assetAbs).replaceAll("\\", "/");
		return `${digest}  ${rel}`;
	});
	const content = `${lines.join("\n")}\n`;
	writeFileSync(sumsFilePath, content, "utf8");
	return content;
}

function globToRegExp(globPattern) {
	let out = "^";
	for (let i = 0; i < globPattern.length; i += 1) {
		const ch = globPattern[i];
		if (ch === "*") {
			if (globPattern[i + 1] === "*") {
				if (globPattern[i + 2] === "/") {
					out += "(?:.+/)?";
					i += 2;
				} else {
					out += ".*";
					i += 1;
				}
			} else {
				out += "[^/]*";
			}
		} else if (ch === "?") {
			out += "[^/]";
		} else if (/[.+^${}()|[\]\\]/.test(ch)) {
			out += `\\${ch}`;
		} else {
			out += ch;
		}
	}
	out += "$";
	return new RegExp(out);
}

function walkSafeRegularFiles(dirAbs, allowDotfiles = false) {
	const results = [];
	for (const name of readdirSync(dirAbs).sort()) {
		if (!allowDotfiles && name.startsWith(".")) continue;
		if (name.replace(/[. ]+$/, "").toLowerCase() === ".git") continue;
		const childAbs = join(dirAbs, name);
		const st = lstatSync(childAbs);
		if (st.isSymbolicLink()) {
			throw new Error(`unsafe symlink in release assets "${childAbs}"`);
		}
		if (st.isDirectory()) {
			results.push(...walkSafeRegularFiles(childAbs, allowDotfiles));
		} else if (st.isFile()) {
			results.push(childAbs);
		}
	}
	return results;
}

function expandRecursiveAssetGlob(root, pattern) {
	const prefixBeforeGlob = pattern.split("**")[0].replace(/\/+$/, "");
	const baseDir = resolveSafeRepoPath(root, prefixBeforeGlob || ".", { allowRoot: true });
	if (!existsSync(baseDir) || !lstatSync(baseDir).isDirectory()) {
		throw new Error(`release asset pattern "${pattern}" matched no files`);
	}
	const rootAbs = resolveSafeRepoPath(root, ".", { allowRoot: true });
	const allowDot = pattern.split("/").some((seg) => seg.startsWith("."));
	const globRe = globToRegExp(pattern);
	const matched = walkSafeRegularFiles(baseDir, allowDot).filter((fileAbs) =>
		globRe.test(relative(rootAbs, fileAbs).replaceAll("\\", "/")),
	);
	if (matched.length === 0) {
		throw new Error(`release asset pattern "${pattern}" matched no files`);
	}
	return matched;
}

function expandSingleDirAssetGlob(root, pattern) {
	const dirAbs = resolveSafeRepoPath(root, dirname(pattern), { allowRoot: true });
	if (!existsSync(dirAbs) || !lstatSync(dirAbs).isDirectory()) {
		throw new Error(`release asset pattern "${pattern}" matched no files`);
	}
	const basePat = basename(pattern);
	const allowDot = basePat.startsWith(".");
	const globRe = globToRegExp(basePat);
	const matched = [];
	for (const name of readdirSync(dirAbs).sort()) {
		if (!allowDot && name.startsWith(".")) continue;
		if (!globRe.test(name)) continue;
		const childAbs = join(dirAbs, name);
		const st = lstatSync(childAbs);
		if (st.isSymbolicLink()) {
			throw new Error(`unsafe symlink in release assets "${pattern}"`);
		}
		if (st.isFile()) matched.push(childAbs);
	}
	if (matched.length === 0) {
		throw new Error(`release asset pattern "${pattern}" matched no files`);
	}
	return matched;
}

function expandLiteralAssetTarget(root, pattern, { checksumsEnabled, checksumsRaw, explicitSumsAbs }) {
	const abs = resolveSafeRepoPath(root, pattern, { allowRoot: true });
	if (!existsSync(abs)) {
		const isGeneratedSums =
			checksumsEnabled &&
			(abs === explicitSumsAbs || (checksumsRaw === "true" && basename(abs) === "SHA256SUMS"));
		if (isGeneratedSums) return [];
		throw new Error(`release asset "${pattern}" does not exist`);
	}
	const stat = lstatSync(abs);
	if (!stat.isDirectory()) {
		return stat.isFile() ? [abs] : [];
	}
	const children = [];
	for (const name of readdirSync(abs).sort()) {
		if (name.startsWith(".")) continue;
		const childAbs = join(abs, name);
		const childStat = lstatSync(childAbs);
		if (childStat.isSymbolicLink()) {
			throw new Error(`unsafe symlink in release asset directory "${pattern}"`);
		}
		if (childStat.isFile()) children.push(childAbs);
	}
	if (children.length === 0) {
		throw new Error(`release asset directory "${pattern}" contains no files`);
	}
	return children;
}

function finalizeReleaseChecksums(root, assets, addAsset, { checksumsEnabled, explicitSumsAbs }) {
	if (checksumsEnabled) {
		const hashTargets = assets.filter(
			(a) => a !== explicitSumsAbs && basename(a) !== "SHA256SUMS",
		);
		if (hashTargets.length === 0) {
			throw new Error("cannot generate SHA256SUMS: no release assets matched 'files'");
		}
		const dirs = new Set(hashTargets.map((a) => dirname(a)));
		const defaultDir =
			dirs.size === 1 ? [...dirs][0] : resolveSafeRepoPath(root, ".", { allowRoot: true });
		const sumsAbs = explicitSumsAbs ?? join(defaultDir, "SHA256SUMS");
		const rootAbs = resolveSafeRepoPath(root, ".", { allowRoot: true });
		resolveSafeRepoPath(rootAbs, relative(rootAbs, sumsAbs));
		generateSha256Sums(sumsAbs, hashTargets);
		addAsset(sumsAbs);
	}

	let checksumsContent = "";
	for (const asset of assets) {
		if (basename(asset) === "SHA256SUMS" || asset === explicitSumsAbs) {
			verifySha256Sums(asset);
			checksumsContent = readFileSync(asset, "utf8").trim();
		}
	}
	return checksumsContent;
}

/** Resolves asset files, expands globs/directories safely, optionally generates `SHA256SUMS`, and verifies checksums. */
export function resolveReleaseAssets(
	root,
	filesInput,
	version,
	tag,
	{ checksumsInput = "" } = {},
) {
	const interpolate = (value) => value.replaceAll("{version}", version).replaceAll("{tag}", tag);
	const rawPatterns = (filesInput ?? "")
		.split(/[\r\n,]+/)
		.map((item) => item.trim())
		.filter(Boolean);

	const checksumsRaw =
		checksumsInput === true
			? "true"
			: checksumsInput === false
				? ""
				: String(checksumsInput ?? "").trim();
	const checksumsEnabled = checksumsRaw !== "" && checksumsRaw !== "false";
	const explicitSumsAbs =
		checksumsEnabled && checksumsRaw !== "true"
			? resolveSafeRepoPath(root, interpolate(checksumsRaw))
			: undefined;

	const assets = [];
	const seen = new Set();
	const addAsset = (abs) => {
		if (!seen.has(abs)) {
			seen.add(abs);
			assets.push(abs);
		}
	};

	for (const rawPattern of rawPatterns) {
		const pattern = interpolate(rawPattern).replaceAll("\\", "/");
		let matched;
		if (pattern.includes("**")) {
			matched = expandRecursiveAssetGlob(root, pattern);
		} else if (pattern.includes("*") || pattern.includes("?")) {
			matched = expandSingleDirAssetGlob(root, pattern);
		} else {
			matched = expandLiteralAssetTarget(root, pattern, {
				checksumsEnabled,
				checksumsRaw,
				explicitSumsAbs,
			});
		}
		for (const fileAbs of matched) addAsset(fileAbs);
	}

	const checksumsContent = finalizeReleaseChecksums(root, assets, addAsset, {
		checksumsEnabled,
		explicitSumsAbs,
	});
	return { assets, checksumsContent };
}

function pushFloatingMajorTag(root, tag, parsedVer, hasOrigin, targetSha, { tagPrefix = "v", token } = {}) {
	const existingInMajor = listSemverTags(root, { tagPrefix }).some((t) => {
		const ver = stripTagPrefix(t, tagPrefix);
		const p = ver ? parseSemver(ver) : undefined;
		return Boolean(
			p && !p.prerelease && p.major === parsedVer.major && compareSemver(ver, `${parsedVer.major}.${parsedVer.minor}.${parsedVer.patch}`) > 0,
		);
	});
	if (existingInMajor) return undefined;

	const majorTag = formatTag(String(parsedVer.major), tagPrefix);
	const tagTarget =
		tryGit(root, ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`]) ||
		targetSha ||
		"HEAD";
	execGitOrThrow(root, [
		"-c",
		"user.name=github-actions[bot]",
		"-c",
		"user.email=41898282+github-actions[bot]@users.noreply.github.com",
		"tag",
		"-fa",
		majorTag,
		"-m",
		majorTag,
		tagTarget,
	]);
	if (hasOrigin) {
		execGitOrThrow(root, ["push", "--force", "origin", `refs/tags/${majorTag}`], {
			auth: true,
			timeout: 60_000,
			token,
		});
	}
	return majorTag;
}

function shouldMarkReleaseLatest(root, version, prerelease, tagPrefix) {
	if (prerelease) return false;
	return !listSemverTags(root, { tagPrefix }).some((t) => {
		const ver = stripTagPrefix(t, tagPrefix);
		const p = ver ? parseSemver(ver) : undefined;
		return Boolean(p && !p.prerelease && compareSemver(ver, version) > 0);
	});
}

function updateExistingGithubRelease(root, viewStdout, {
	version,
	tag,
	tagPrefix,
	title,
	notesFile,
	prerelease,
	shouldMarkLatest,
	assets,
	hasOrigin,
	targetSha,
	token,
}) {
	let releaseUrl = "";
	try {
		const parsedView = JSON.parse((viewStdout ?? "").trim());
		if (typeof parsedView?.url === "string") releaseUrl = parsedView.url.trim();
	} catch {
		// Ignore non-JSON view stdout
	}
	const relCommit = detectReleaseCommit(root, version, { tagPrefix });
	const shouldUpdateTagTarget =
		relCommit.isRelease && (relCommit.version ?? version) === version;
	if (shouldUpdateTagTarget && hasOrigin && targetSha) {
		execGitOrThrow(root, ["push", "--force", "origin", `${targetSha}:refs/tags/${tag}`], {
			auth: true,
			timeout: 60_000,
			token,
		});
	}
	if (assets.length > 0) {
		execGhOrThrow(["release", "upload", tag, ...assets, "--clobber"], root, {
			timeout: 300_000,
			token,
		});
	}
	const editOut = execGhOrThrow(
		[
			"release",
			"edit",
			tag,
			...(shouldUpdateTagTarget && targetSha ? ["--target", targetSha] : []),
			"--title",
			title,
			"--notes-file",
			notesFile,
			`--prerelease=${prerelease}`,
			...(prerelease ? [] : [shouldMarkLatest ? "--latest" : "--latest=false"]),
		],
		root,
		{ timeout: 30_000, token },
	);
	if (!releaseUrl) {
		const urlMatch = /https?:\/\/\S+/.exec(editOut);
		if (urlMatch) releaseUrl = urlMatch[0].trim();
	}
	return releaseUrl;
}

function createNewGithubRelease(root, {
	tag,
	title,
	notesFile,
	prerelease,
	shouldMarkLatest,
	assets,
	hasOrigin,
	targetSha,
	token,
}) {
	const tagOnOrigin =
		hasOrigin &&
		tryGit(root, ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`], {
			auth: true,
			timeout: 30_000,
			token,
		}) !== undefined;
	const createOut = execGhOrThrow(
		[
			"release",
			"create",
			tag,
			...assets,
			...(!tagOnOrigin && targetSha ? ["--target", targetSha] : []),
			"--title",
			title,
			"--notes-file",
			notesFile,
			...(prerelease
				? ["--prerelease"]
				: [shouldMarkLatest ? "--latest" : "--latest=false"]),
		],
		root,
		{ timeout: 300_000, token },
	);
	return /https?:\/\/\S+/.exec(createOut)?.[0]?.trim() ?? "";
}

/** Creates or updates the GitHub Release, verifies/generates checksums, uploads assets, and optionally updates the floating major tag. */
export function publishGithubRelease(root, versionOrOptions, notesFileArg, options = {}) {
	const opts =
		typeof versionOrOptions === "object" && versionOrOptions !== null
			? versionOrOptions
			: { ...options, version: versionOrOptions, notesFile: notesFileArg };
	const version = opts.version;
	const tagPrefix = opts.tagPrefix ?? "v";
	const notesFile = opts.notesFile ?? join(root, "release-notes.md");
	const tag = formatTag(version, tagPrefix);
	const parsedVer = parseSemver(version);
	const prerelease = Boolean(parsedVer?.prerelease);
	const rawTitle = (opts.title ?? getInput("title")).trim();
	const title = rawTitle
		? rawTitle.replaceAll("{version}", version).replaceAll("{tag}", tag)
		: tag;
	const filesInput = opts.files ?? opts.filesInput ?? getInput("files");
	const checksumsInput = opts.checksums ?? getInput("checksums");
	const majorTagEnabled =
		opts.majorTag !== undefined ? Boolean(opts.majorTag) : getInput("major-tag") === "true";
	const dryRun = Boolean(opts.dryRun);
	const token = opts.token;
	const repoUrl = opts.repoUrl;

	const { assets, checksumsContent } = resolveReleaseAssets(root, filesInput, version, tag, {
		checksumsInput,
	});
	if (dryRun) {
		return {
			releaseUrl: "",
			tag,
			title,
			prerelease,
			assets,
			checksumsContent,
			dryRun: true,
		};
	}

	const targetSha = (
		process.env.GITHUB_SHA ||
		tryGit(root, ["rev-parse", "-q", "--verify", "HEAD"]) ||
		""
	).trim();
	const hasOrigin = hasOriginRemote(root);
	const shouldMarkLatest = shouldMarkReleaseLatest(root, version, prerelease, tagPrefix);
	const viewRes = spawnGhWithFallback(["release", "view", tag, "--json", "url"], root, {
		timeout: 30_000,
		token,
	});
	const releaseArgs = {
		version,
		tag,
		tagPrefix,
		title,
		notesFile,
		prerelease,
		shouldMarkLatest,
		assets,
		hasOrigin,
		targetSha,
		token,
	};
	let releaseUrl =
		!viewRes.error && viewRes.status === 0
			? updateExistingGithubRelease(root, viewRes.stdout, releaseArgs)
			: createNewGithubRelease(root, releaseArgs);

	if (!releaseUrl && repoUrl) {
		releaseUrl = `${repoUrl.replace(/\/+$/, "")}/releases/tag/${tag}`;
	}

	const majorTag =
		majorTagEnabled && parsedVer && !prerelease
			? pushFloatingMajorTag(root, tag, parsedVer, hasOrigin, targetSha, { tagPrefix, token })
			: undefined;

	return {
		releaseUrl,
		tag,
		title,
		prerelease,
		assets,
		checksumsContent,
		majorTag,
		dryRun: false,
	};
}

/** Appends Markdown to `$GITHUB_STEP_SUMMARY` when running in GitHub Actions. */
export function writeStepSummary(markdown) {
	const summaryPath = process.env.GITHUB_STEP_SUMMARY;
	if (!summaryPath || !markdown?.trim()) return;
	appendFileSync(summaryPath, `${markdown.trim()}\n\n`, "utf8");
}
