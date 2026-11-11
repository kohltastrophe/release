const SEMVER_RE =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

/** Parses a strict SemVer 2.0.0 `MAJOR.MINOR.PATCH` (with optional `-PRERELEASE`) string. */
export function parseSemver(version) {
	if (typeof version !== "string") return undefined;
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
		const aIsNum = /^\d+$/.test(aId);
		const bIsNum = /^\d+$/.test(bId);
		if (aIsNum && bIsNum) {
			const aNum = Number(aId);
			const bNum = Number(bId);
			return aNum < bNum ? -1 : 1;
		}
		if (aIsNum) return -1;
		if (bIsNum) return 1;
		return aId < bId ? -1 : 1;
	}
	return 0;
}

/** Compares two SemVer strings, returning `-1` if `a < b`, `0` if equal, or `1` if `a > b`. */
export function compareSemver(a, b) {
	const pa = parseSemver(a);
	const pb = parseSemver(b);
	if (!pa || !pb) return 0;
	if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
	if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
	if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
	if (!pa.prerelease && !pb.prerelease) return 0;
	if (!pa.prerelease) return 1;
	if (!pb.prerelease) return -1;
	return comparePrerelease(pa.prerelease, pb.prerelease);
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
	if (a.prerelease) {
		return (
			(b.major === a.major && b.minor === a.minor + 1 && b.patch === 0 && a.patch > 0) ||
			(b.major === a.major + 1 && b.minor === 0 && b.patch === 0 && (a.minor > 0 || a.patch > 0))
		);
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
	if (cur.prerelease) {
		if (target === "patch") return `${cur.major}.${cur.minor}.${cur.patch}`;
		if (target === "minor" && cur.patch === 0) return `${cur.major}.${cur.minor}.0`;
		if (target === "major" && cur.minor === 0 && cur.patch === 0) return `${cur.major}.0.0`;
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

/** Formats a SemVer string as a git tag using `tagPrefix` (defaults to `"v"`). */
export function formatTag(version, tagPrefix = "v") {
	return `${tagPrefix}${version}`;
}

/** Strips `tagPrefix` from `tag` if present, returning the bare string or `undefined`. */
export function stripTagPrefix(tag, tagPrefix = "v") {
	if (typeof tag !== "string") return undefined;
	if (tagPrefix === "") return tag;
	return tag.startsWith(tagPrefix) ? tag.slice(tagPrefix.length) : undefined;
}

/** Strips `tagPrefix` (or a leading `v` when `parseSemver` matches) from a CLI version argument. */
export function normalizeVersionArg(raw, tagPrefix = "v") {
	if (typeof raw !== "string") return raw;
	const trimmed = raw.trim();
	if (parseSemver(trimmed)) return trimmed;
	const stripped = stripTagPrefix(trimmed, tagPrefix);
	if (stripped && parseSemver(stripped)) return stripped;
	if (trimmed.startsWith("v") && parseSemver(trimmed.slice(1))) return trimmed.slice(1);
	return trimmed;
}
