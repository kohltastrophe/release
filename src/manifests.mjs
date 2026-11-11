import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { compareSemver, formatTag, parseSemver, stripTagPrefix } from "./semver.mjs";

const PACKAGE_TOML_SECTIONS = new Set(["package", "workspace.package", "project", "tool.poetry"]);
export const MANIFEST_CANDIDATES = [
	"package.json",
	"VERSION.txt",
	"wally.toml",
	"pesde.toml",
	"rotriever.toml",
	"Cargo.toml",
	"pyproject.toml",
];

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDotGitSegment(segment) {
	return segment.replace(/[. ]+$/, "").toLowerCase() === ".git";
}

/**
 * Resolves `rel` inside `root`, rejecting path traversal outside `root`, `.git` segments
 * (case-insensitively), null bytes, and symbolic links anywhere along the relative path.
 */
export function resolveSafeRepoPath(root, rel, { allowRoot = false } = {}) {
	if (typeof rel !== "string" || rel.length === 0 || rel.includes("\0")) {
		throw new Error(`unsafe release file path "${rel}" outside repository root`);
	}
	const rawSegments = rel.split(/[\\/]/).filter(Boolean);
	if (rawSegments.some(isDotGitSegment)) {
		throw new Error(`unsafe release file path "${rel}" outside repository root`);
	}

	const realRoot = existsSync(root) ? realpathSync(root) : resolve(root);
	const abs = resolve(realRoot, rel);
	if (allowRoot && abs === realRoot) {
		return realRoot;
	}
	const rootPrefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
	if (!abs.startsWith(rootPrefix)) {
		throw new Error(`unsafe release file path "${rel}" outside repository root`);
	}

	const relFromRoot = relative(realRoot, abs);
	const relParts = relFromRoot.split(sep).filter(Boolean);
	if (relParts.length === 0 || relParts.some(isDotGitSegment)) {
		throw new Error(`unsafe release file path "${rel}" outside repository root`);
	}

	let cursor = realRoot;
	let deepestExisting = realRoot;
	for (const part of relParts) {
		cursor = join(cursor, part);
		let stat;
		try {
			stat = lstatSync(cursor);
		} catch {
			break;
		}
		if (stat.isSymbolicLink()) {
			throw new Error(`unsafe symlink in release file path "${rel}"`);
		}
		deepestExisting = cursor;
	}

	if (deepestExisting !== realRoot) {
		const realDeepest = realpathSync(deepestExisting);
		if (realDeepest !== realRoot && !realDeepest.startsWith(rootPrefix)) {
			throw new Error(`unsafe release file path "${rel}" outside repository root`);
		}
	}
	return abs;
}

function isGitIgnored(root, rel) {
	if (!existsSync(join(root, ".git"))) return false;
	const res = spawnSync("git", ["check-ignore", "-q", "--", rel], {
		cwd: root,
		encoding: "utf8",
		timeout: 5_000,
	});
	return res.status === 0;
}

function splitKeySectionAndField(key) {
	if (!key) return { section: undefined, field: "version" };
	const dotIdx = key.lastIndexOf(".");
	if (dotIdx < 0) return { section: undefined, field: key };
	return { section: key.slice(0, dotIdx), field: key.slice(dotIdx + 1) };
}

/** Finds matching `field = "..."` lines in a TOML document. */
export function locateTomlPackageVersion(lines, targetSection, field = "version") {
	return locateTomlKeyLines(lines, targetSection, field)[0];
}

function locateTomlKeyLines(lines, targetSection, field = "version") {
	let currentSection;
	const hits = [];
	const fieldRe = new RegExp(`^\\s*${escapeRegExp(field)}\\s*=\\s*"([^"]+)"`);
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const sectionMatch = /^\s*(\[\[?[^\]\r\n]+\]?\])\s*(?:#.*)?$/.exec(line);
		if (sectionMatch) {
			const rawHeader = sectionMatch[1].trim();
			currentSection =
				rawHeader.startsWith("[[") && rawHeader.endsWith("]]")
					? rawHeader
					: rawHeader.slice(1, -1).trim();
			continue;
		}
		const valMatch = fieldRe.exec(line);
		if (!valMatch) continue;
		if (targetSection !== undefined) {
			if (currentSection === targetSection) {
				return [{ index: i, version: valMatch[1], value: valMatch[1] }];
			}
			continue;
		}
		if (currentSection === undefined || PACKAGE_TOML_SECTIONS.has(currentSection)) {
			hits.push({ index: i, version: valMatch[1], value: valMatch[1] });
		}
	}
	return hits;
}

/** Finds `field = "..."` inside a `[[<arrayTableName>]]` block matching `name = "<packageName>"`, preferring local blocks without `source =`. */
export function locateTomlArrayPackageField(
	lines,
	packageName,
	field = "version",
	arrayTableName = "package",
) {
	const expectedHeader = `[[${arrayTableName}]]`;
	const fieldRe = new RegExp(`^\\s*${escapeRegExp(field)}\\s*=\\s*"([^"]+)"`);
	const matches = [];

	let inBlock = false;
	let matchedName = false;
	let hasSource = false;
	let hit;

	const flushBlock = () => {
		if (inBlock && matchedName && hit) {
			matches.push({ ...hit, hasSource });
		}
	};

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const headerMatch = /^\s*(\[\[?[^\]\r\n]+\]?\])\s*(?:#.*)?$/.exec(line);
		if (headerMatch) {
			flushBlock();
			inBlock = headerMatch[1].trim() === expectedHeader;
			matchedName = false;
			hasSource = false;
			hit = undefined;
			continue;
		}
		if (!inBlock) continue;
		const nameMatch = /^\s*name\s*=\s*"([^"]+)"/.exec(line);
		if (nameMatch?.[1] === packageName) matchedName = true;
		if (/^\s*source\s*=/.test(line)) hasSource = true;
		const verMatch = fieldRe.exec(line);
		if (verMatch?.[1]) hit = { index: i, value: verMatch[1] };
	}
	flushBlock();

	return matches.find((m) => !m.hasSource) ?? matches[0];
}

function stripTomlComment(line) {
	let quote = "";
	for (let i = 0; i < line.length; i += 1) {
		const ch = line[i];
		if (quote === '"') {
			if (ch === "\\") i += 1;
			else if (ch === '"') quote = "";
		} else if (quote === "'") {
			if (ch === "'") quote = "";
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (ch === "#") {
			return line.slice(0, i);
		}
	}
	return line;
}

function splitReleaseTomlSections(tomlText) {
	const lines = tomlText.split(/\r?\n/);
	const directLines = [];
	const allReleaseLines = [];
	let mode = "none";
	for (const rawLine of lines) {
		const line = stripTomlComment(rawLine);
		if (!line.trim()) continue;
		const sectionMatch = /^\s*(\[\[?[^\]\r\n]+\]?\])\s*$/.exec(line);
		if (sectionMatch) {
			const rawHeader = sectionMatch[1].trim();
			const isArray = rawHeader.startsWith("[[") && rawHeader.endsWith("]]");
			const name = rawHeader.slice(isArray ? 2 : 1, isArray ? -2 : -1).trim();
			if (!isArray && name === "release") mode = "direct";
			else if (name.startsWith("release.")) mode = "sub";
			else mode = "none";
			continue;
		}
		if (mode === "direct") {
			directLines.push(line);
			allReleaseLines.push(line);
		} else if (mode === "sub") {
			allReleaseLines.push(line);
		}
	}
	return {
		directText: directLines.join("\n"),
		allText: allReleaseLines.join("\n"),
	};
}

function readTomlQuotedString(text, startIdx) {
	const quote = text[startIdx];
	let i = startIdx + 1;
	let out = "";
	while (i < text.length) {
		const ch = text[i];
		if (quote === '"' && ch === "\\") {
			const next = text[i + 1];
			if (next === '"' || next === "\\" || next === "'") {
				out += next;
				i += 2;
				continue;
			}
			if (next === "n") {
				out += "\n";
				i += 2;
				continue;
			}
			if (next === "r") {
				out += "\r";
				i += 2;
				continue;
			}
			if (next === "t") {
				out += "\t";
				i += 2;
				continue;
			}
		}
		if (ch === quote) return { value: out, nextIndex: i + 1 };
		out += ch;
		i += 1;
	}
	return { value: undefined, nextIndex: text.length };
}

function parseInlineTableFields(body) {
	const fields = {};
	let i = 0;
	const skipWsAndCommas = () => {
		while (i < body.length && /[\s,]/.test(body[i])) i += 1;
	};

	while (i < body.length) {
		skipWsAndCommas();
		if (i >= body.length) break;
		const keyMatch = /^[A-Za-z0-9_-]+/.exec(body.slice(i));
		if (!keyMatch) {
			i += 1;
			continue;
		}
		const key = keyMatch[0];
		i += key.length;
		while (i < body.length && /\s/.test(body[i])) i += 1;
		if (body[i] !== "=") continue;
		i += 1;
		while (i < body.length && /\s/.test(body[i])) i += 1;
		if (i >= body.length) break;

		const ch = body[i];
		if (ch === '"' || ch === "'") {
			const parsed = readTomlQuotedString(body, i);
			if (parsed.value !== undefined) fields[key] = parsed.value;
			i = parsed.nextIndex;
		} else if (ch === "{") {
			let depth = 1;
			let quote = "";
			const innerStart = i + 1;
			i += 1;
			while (i < body.length && depth > 0) {
				const c = body[i];
				if (quote === '"') {
					if (c === "\\") i += 1;
					else if (c === '"') quote = "";
				} else if (quote === "'") {
					if (c === "'") quote = "";
				} else if (c === '"' || c === "'") {
					quote = c;
				} else if (c === "{") {
					depth += 1;
				} else if (c === "}") {
					depth -= 1;
				}
				i += 1;
			}
			if (depth === 0) {
				fields[key] = parseInlineTableFields(body.slice(innerStart, i - 1));
			}
		} else {
			const start = i;
			while (i < body.length && body[i] !== ",") i += 1;
			fields[key] = body.slice(start, i).trim();
		}
	}
	return fields;
}

function scanInlineTables(text) {
	const tables = [];
	let depth = 0;
	let start = -1;
	let quote = "";
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (quote === '"') {
			if (ch === "\\") i += 1;
			else if (ch === '"') quote = "";
			continue;
		}
		if (quote === "'") {
			if (ch === "'") quote = "";
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "{") {
			if (depth === 0) start = i + 1;
			depth += 1;
		} else if (ch === "}") {
			depth -= 1;
			if (depth === 0 && start >= 0) {
				tables.push(text.slice(start, i));
				start = -1;
			}
		}
	}
	return tables;
}

function extractTomlArrayBlocks(sectionText, arrayKey) {
	const blocks = [];
	const keyRe = new RegExp(`(?:^|\\n)\\s*${escapeRegExp(arrayKey)}\\s*=\\s*\\[`, "g");
	let match = keyRe.exec(sectionText);
	while (match !== null) {
		let depth = 1;
		let quote = "";
		const start = match.index + match[0].length;
		let i = start;
		for (; i < sectionText.length && depth > 0; i += 1) {
			const ch = sectionText[i];
			if (quote === '"') {
				if (ch === "\\") i += 1;
				else if (ch === '"') quote = "";
			} else if (quote === "'") {
				if (ch === "'") quote = "";
			} else if (ch === '"' || ch === "'") {
				quote = ch;
			} else if (ch === "[") {
				depth += 1;
			} else if (ch === "]") {
				depth -= 1;
			}
		}
		if (depth === 0) {
			blocks.push(sectionText.slice(start, i - 1));
		}
		match = keyRe.exec(sectionText);
	}
	return blocks;
}

function parseTopLevelQuotedAssign(sectionText, keyName) {
	for (const line of sectionText.split("\n")) {
		const match = new RegExp(`^\\s*${escapeRegExp(keyName)}\\s*=\\s*(['"])`).exec(line);
		if (!match) continue;
		const quoteIdx = line.indexOf(match[1], match.index + match[0].length - 1);
		const parsed = readTomlQuotedString(line, quoteIdx);
		if (parsed.value !== undefined) return parsed.value;
	}
	return undefined;
}

function parseInlineTableEntries(blockText) {
	const entries = [];
	for (const body of scanInlineTables(blockText)) {
		const fields = parseInlineTableFields(body);
		const file = typeof fields.file === "string" ? fields.file : undefined;
		if (!file) continue;
		const pattern = typeof fields.pattern === "string" ? fields.pattern : undefined;
		const key = typeof fields.key === "string" ? fields.key : undefined;
		const whereName =
			typeof fields.where === "object" && fields.where && typeof fields.where.name === "string"
				? fields.where.name
				: undefined;
		const field = typeof fields.field === "string" ? fields.field : undefined;
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

/** Parses `[release]` (`prefix`, `versions`, `released`) from a TOML string. */
export function parseReleaseTomlConfig(tomlText) {
	const { directText, allText } = splitReleaseTomlSections(tomlText);
	if (!allText) return { prefix: undefined, versions: [], released: [] };
	const prefix = directText ? parseTopLevelQuotedAssign(directText, "prefix") : undefined;
	const versionBlocks = extractTomlArrayBlocks(allText, "versions");
	const releasedBlocks = extractTomlArrayBlocks(allText, "released");
	return {
		prefix,
		versions: versionBlocks.flatMap((block) => parseInlineTableEntries(block)),
		released: releasedBlocks.flatMap((block) => parseInlineTableEntries(block)),
	};
}

function parseExtraVersionFilesInput(extraInput) {
	if (!extraInput?.trim()) return [];
	const entries = [];
	const rawItems = extraInput.includes("\n")
		? extraInput.split(/\r?\n/)
		: extraInput.includes(":")
			? [extraInput]
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
	return entries;
}

/** Loads `[release]` configuration (`prefix`, `versions`, `released`) from root `*.toml` files and extra inputs. */
export function loadReleaseConfig(root, options = {}) {
	const versions = [];
	const released = [];
	let configuredPrefix;

	if (existsSync(root)) {
		const rootTomls = readdirSync(root)
			.filter((name) => name.endsWith(".toml"))
			.sort();
		for (const name of rootTomls) {
			const full = join(root, name);
			try {
				if (lstatSync(full).isSymbolicLink()) continue;
				const parsed = parseReleaseTomlConfig(readFileSync(full, "utf8"));
				if (configuredPrefix === undefined && parsed.prefix !== undefined) {
					configuredPrefix = parsed.prefix;
				}
				versions.push(...parsed.versions);
				released.push(...parsed.released);
			} catch {
				// Ignore unreadable files
			}
		}
	}

	const envVersionFiles =
		options.extraVersionFiles ??
		process.env["INPUT_VERSION-FILES"] ??
		process.env.INPUT_VERSION_FILES;
	versions.push(...parseExtraVersionFilesInput(envVersionFiles));

	const envTagPrefix = (
		process.env["INPUT_TAG-PREFIX"] ??
		process.env.INPUT_TAG_PREFIX ??
		""
	).trim();
	const tagPrefix =
		options.tagPrefix !== undefined
			? options.tagPrefix
			: envTagPrefix !== ""
				? envTagPrefix
				: (configuredPrefix ?? "v");

	return { tagPrefix, versions, released };
}

/** Locates all capture-group-1 version spans in `text` for `pattern` using RegExp match indices (`/gmd`). */
export function locateVersionByPattern(text, pattern) {
	const re = new RegExp(pattern, "gmd");
	const hits = [];
	for (const match of text.matchAll(re)) {
		const span = match.indices?.[1];
		if (!span) {
			throw new Error(
				`version pattern "${pattern}" must include a capture group for the version`,
			);
		}
		const [start, end] = span;
		const raw = text.slice(start, end);
		const trimmed = raw.trim();
		if (trimmed) {
			hits.push({ start, end, version: trimmed });
		}
	}
	return hits;
}

function spliceVersionSpans(text, spans, newVersion) {
	if (spans.length === 0) return text;
	let out = text;
	for (let i = spans.length - 1; i >= 0; i -= 1) {
		const { start, end } = spans[i];
		out = `${out.slice(0, start)}${newVersion}${out.slice(end)}`;
	}
	return out;
}

function replaceVersionByPattern(text, pattern, newVersion) {
	return spliceVersionSpans(text, locateVersionByPattern(text, pattern), newVersion);
}

function scanJsonStringEnd(content, startQuote) {
	let idx = startQuote + 1;
	while (idx < content.length) {
		const ch = content[idx];
		if (ch === "\\") {
			idx += 2;
			continue;
		}
		if (ch === '"') return idx;
		idx += 1;
	}
	return -1;
}

function nextJsonObjectPathKey(top) {
	if (!top) return "root";
	if (top.kind !== "obj" || top.step !== "val") return null;
	if (top.pathKey === "root" && top.lastKey === "packages") return "packages";
	if (top.pathKey === "packages" && top.lastKey === "") return "packages_self";
	return null;
}

function recordJsonStringToken(content, startQuote, endQuote, top, includePackagesRoot, spans) {
	if (top?.kind !== "obj") return;
	const literal = content.slice(startQuote, endQuote + 1);
	let parsedStr;
	try {
		parsedStr = JSON.parse(literal);
	} catch {
		parsedStr = content.slice(startQuote + 1, endQuote);
	}
	if (top.step === "key") {
		top.lastKey = parsedStr;
		top.step = "colon";
		return;
	}
	if (top.step === "val") {
		const isRootVer = top.pathKey === "root" && top.lastKey === "version";
		const isLockSelfVer =
			includePackagesRoot && top.pathKey === "packages_self" && top.lastKey === "version";
		if (isRootVer || isLockSelfVer) {
			spans.push({ start: startQuote + 1, end: endQuote, value: parsedStr });
		}
		top.step = "comma";
	}
}

function scanJsonVersionSpans(content, { includePackagesRoot = false } = {}) {
	const spans = [];
	const stack = [];
	let i = 0;

	while (i < content.length) {
		const ch = content[i];
		if (/\s/.test(ch)) {
			i += 1;
			continue;
		}
		const top = stack[stack.length - 1];
		if (ch === "{") {
			stack.push({ kind: "obj", pathKey: nextJsonObjectPathKey(top), step: "key", lastKey: null });
			i += 1;
			continue;
		}
		if (ch === "[") {
			stack.push({ kind: "arr" });
			i += 1;
			continue;
		}
		if (ch === "}" || ch === "]") {
			stack.pop();
			const parent = stack[stack.length - 1];
			if (parent?.kind === "obj" && parent.step === "val") parent.step = "comma";
			i += 1;
			continue;
		}
		if (ch === ":") {
			if (top?.kind === "obj" && top.step === "colon") top.step = "val";
			i += 1;
			continue;
		}
		if (ch === ",") {
			if (top?.kind === "obj") {
				top.step = "key";
				top.lastKey = null;
			}
			i += 1;
			continue;
		}
		if (ch === '"') {
			const endQuote = scanJsonStringEnd(content, i);
			if (endQuote < 0) break;
			recordJsonStringToken(content, i, endQuote, top, includePackagesRoot, spans);
			i = endQuote + 1;
			continue;
		}
		while (i < content.length && !/[\s,:\]{}"]/.test(content[i])) i += 1;
		if (top?.kind === "obj" && top.step === "val") top.step = "comma";
	}
	return spans;
}

function updateJsonRootVersion(content, newVersion, options = {}) {
	return spliceVersionSpans(content, scanJsonVersionSpans(content, options), newVersion);
}

function extractEntryVersions(entry, text) {
	if (entry.whereName) {
		const val = locateTomlArrayPackageField(
			text.split(/\r?\n/),
			entry.whereName,
			entry.field ?? "version",
			entry.key ?? "package",
		)?.value;
		return val ? [val] : [];
	}
	if (entry.key || (entry.file.endsWith(".toml") && !entry.pattern)) {
		const { section, field } = splitKeySectionAndField(entry.key);
		const hits = locateTomlKeyLines(text.split(/\r?\n/), section, field);
		if (hits.length === 0) return [];
		if (entry.pattern) {
			return hits
				.flatMap((hit) => locateVersionByPattern(hit.value, entry.pattern).map((m) => m.version))
				.filter(Boolean);
		}
		return hits.map((h) => h.value);
	}
	if (entry.pattern) {
		return locateVersionByPattern(text, entry.pattern).map((m) => m.version);
	}
	if (entry.file.endsWith("package-lock.json")) {
		return scanJsonVersionSpans(text, { includePackagesRoot: true }).map((s) => s.value);
	}
	if (entry.file.endsWith("package.json")) {
		const parsed = JSON.parse(text);
		return typeof parsed?.version === "string" ? [parsed.version] : [];
	}
	if (entry.file.endsWith("VERSION.txt")) {
		const trimmed = text.trim();
		return trimmed ? [trimmed] : [];
	}
	if (entry.file.endsWith(".py")) {
		const val = /^VERSION\s*=\s*"([^"]+)"/m.exec(text)?.[1];
		return val ? [val] : [];
	}
	return [];
}

function updateEntryContent(entry, content, newVersion) {
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	if (entry.whereName) {
		const field = entry.field ?? "version";
		const lines = content.split(/\r?\n/);
		const hit = locateTomlArrayPackageField(
			lines,
			entry.whereName,
			field,
			entry.key ?? "package",
		);
		if (!hit) return content;
		const fieldRe = new RegExp(`^(\\s*${escapeRegExp(field)}\\s*=\\s*")([^"]+)(")`);
		lines[hit.index] = lines[hit.index].replace(
			fieldRe,
			(_, p1, _cur, p3) => `${p1}${newVersion}${p3}`,
		);
		return lines.join(eol);
	}
	if (entry.key || (entry.file.endsWith(".toml") && !entry.pattern)) {
		const { section, field } = splitKeySectionAndField(entry.key);
		const lines = content.split(/\r?\n/);
		const hits = locateTomlKeyLines(lines, section, field);
		if (hits.length === 0) return content;
		const fieldRe = new RegExp(`^(\\s*${escapeRegExp(field)}\\s*=\\s*")([^"]+)(")`);
		for (const hit of hits) {
			const nextValue = entry.pattern
				? replaceVersionByPattern(hit.value, entry.pattern, newVersion)
				: newVersion;
			lines[hit.index] = lines[hit.index].replace(
				fieldRe,
				(_, p1, _cur, p3) => `${p1}${nextValue}${p3}`,
			);
		}
		return lines.join(eol);
	}
	if (entry.pattern) {
		return replaceVersionByPattern(content, entry.pattern, newVersion);
	}
	if (entry.file.endsWith("package-lock.json")) {
		return updateJsonRootVersion(content, newVersion, { includePackagesRoot: true });
	}
	if (entry.file.endsWith("package.json")) {
		return updateJsonRootVersion(content, newVersion);
	}
	if (entry.file.endsWith("VERSION.txt")) {
		return `${newVersion}${eol}`;
	}
	if (entry.file.endsWith(".py")) {
		return content.replace(
			/^(VERSION\s*=\s*")([^"]+)(")/m,
			(_, p1, _cur, p3) => `${p1}${newVersion}${p3}`,
		);
	}
	return content;
}

function formatEntryDetail(entry) {
	const parts = [];
	if (entry.key) parts.push(entry.key);
	if (entry.whereName) parts.push(`name=${entry.whereName}`);
	if (entry.field && entry.field !== "version") parts.push(`field=${entry.field}`);
	if (entry.pattern) parts.push(entry.pattern);
	return parts.join(", ");
}

function allocateUniqueLabel(map, baseLabel) {
	if (!map.has(baseLabel)) return baseLabel;
	let n = 2;
	while (map.has(`${baseLabel} (${n})`)) n += 1;
	return `${baseLabel} (${n})`;
}

function detectRootCargoPackageName(root) {
	const cargoPath = join(root, "Cargo.toml");
	try {
		if (!existsSync(cargoPath) || lstatSync(cargoPath).isSymbolicLink()) return undefined;
		const lines = readFileSync(cargoPath, "utf8").split(/\r?\n/);
		return locateTomlKeyLines(lines, "package", "name")[0]?.value;
	} catch {
		return undefined;
	}
}

function discoverAutoLockfileEntries(root, foundFiles, configuredVersions) {
	const autoEntries = [];
	if (
		foundFiles.includes("package.json") &&
		!configuredVersions.some((e) => e.file === "package-lock.json")
	) {
		const lockPath = join(root, "package-lock.json");
		if (
			existsSync(lockPath) &&
			!lstatSync(lockPath).isSymbolicLink() &&
			!isGitIgnored(root, "package-lock.json")
		) {
			const lockSpans = scanJsonVersionSpans(readFileSync(lockPath, "utf8"), {
				includePackagesRoot: true,
			});
			if (lockSpans.length > 0) {
				autoEntries.push({ file: "package-lock.json", isAutoLockfile: true });
			}
		}
	}

	if (foundFiles.includes("Cargo.toml")) {
		const pkgName = detectRootCargoPackageName(root);
		const alreadyConfigured =
			pkgName &&
			configuredVersions.some(
				(e) => e.file === "Cargo.lock" && (!e.whereName || e.whereName === pkgName),
			);
		const lockPath = join(root, "Cargo.lock");
		if (
			pkgName &&
			!alreadyConfigured &&
			existsSync(lockPath) &&
			!lstatSync(lockPath).isSymbolicLink() &&
			!isGitIgnored(root, "Cargo.lock")
		) {
			const hit = locateTomlArrayPackageField(
				readFileSync(lockPath, "utf8").split(/\r?\n/),
				pkgName,
				"version",
				"package",
			);
			if (hit && !hit.hasSource) {
				autoEntries.push({
					file: "Cargo.lock",
					key: "package",
					whereName: pkgName,
					field: "version",
					isAutoLockfile: true,
				});
			}
		}
	}
	return autoEntries;
}

function recordDetectedManifestEntry(root, entry, state) {
	const abs = resolveSafeRepoPath(root, entry.file);
	const detail = formatEntryDetail(entry);
	const hasSeenFile = state.seenFiles.has(entry.file);
	const rawBaseLabel =
		!entry.isDefaultCandidate && hasSeenFile && detail
			? `${entry.file} (${detail})`
			: entry.file;

	if (!existsSync(abs)) {
		if (!entry.isDefaultCandidate) {
			state.seenFiles.add(entry.file);
			state.versionsByFile.set(
				allocateUniqueLabel(state.versionsByFile, rawBaseLabel),
				"<missing file>",
			);
		}
		return;
	}
	const matches = extractEntryVersions(entry, readFileSync(abs, "utf8"));
	if (matches.length === 0) {
		if (!entry.isDefaultCandidate) {
			state.seenFiles.add(entry.file);
			state.versionsByFile.set(
				allocateUniqueLabel(state.versionsByFile, rawBaseLabel),
				"<unmatched>",
			);
		}
		return;
	}
	state.seenFiles.add(entry.file);
	if (
		!entry.isAutoLockfile &&
		!state.foundFiles.includes(entry.file) &&
		matches.some((v) => Boolean(parseSemver(v)))
	) {
		state.foundFiles.push(entry.file);
	}
	const baseLabel =
		matches.length === 1
			? allocateUniqueLabel(state.versionsByFile, rawBaseLabel)
			: rawBaseLabel;
	for (const [idx, ver] of matches.entries()) {
		const label =
			matches.length > 1
				? allocateUniqueLabel(state.versionsByFile, `${baseLabel} #${idx + 1}`)
				: baseLabel;
		if (!entry.isDefaultCandidate || parseSemver(ver)) {
			state.versionsByFile.set(label, ver);
		}
		if (parseSemver(ver)) {
			state.detectedVersion ??= ver;
		}
	}
}

function collectReleasedVersionChecks(root, releasedEntries) {
	const checks = [];
	const usedLabels = new Set();
	for (const entry of releasedEntries) {
		const abs = resolveSafeRepoPath(root, entry.file);
		const detail = formatEntryDetail(entry) || "version";
		let label = `${entry.file} [released: ${detail}]`;
		let suffix = 2;
		while (usedLabels.has(label)) {
			label = `${entry.file} [released: ${detail} #${suffix}]`;
			suffix += 1;
		}
		usedLabels.add(label);
		if (!existsSync(abs)) {
			checks.push({ label, version: "<missing file>" });
			continue;
		}
		const ver = extractEntryVersions(entry, readFileSync(abs, "utf8"))[0];
		checks.push({ label, version: ver ?? "<unmatched>" });
	}
	return checks;
}

function resolveFallbackGitTagVersion(root, tagPrefix, fallbackTagVersion) {
	if (typeof fallbackTagVersion === "function") {
		return fallbackTagVersion(tagPrefix);
	}
	if (!existsSync(join(root, ".git"))) return undefined;
	const res = spawnSync("git", ["tag", "-l"], {
		cwd: root,
		encoding: "utf8",
		timeout: 5_000,
	});
	if (res.status !== 0 || !res.stdout) return undefined;
	return res.stdout
		.split(/\r?\n/)
		.map((t) => stripTagPrefix(t.trim(), tagPrefix))
		.filter((v) => Boolean(v && parseSemver(v)))
		.sort((a, b) => compareSemver(b, a))[0];
}

/** Reads the current version from the repository's manifests, configured `[release]` entries, or `fallbackTagVersion`. */
export function detectRepoVersion(root, options = {}) {
	const config = loadReleaseConfig(root, options);
	const state = {
		foundFiles: [],
		versionsByFile: new Map(),
		seenFiles: new Set(),
		detectedVersion: undefined,
	};

	for (const file of MANIFEST_CANDIDATES) {
		recordDetectedManifestEntry(root, { file, isDefaultCandidate: true }, state);
	}
	for (const entry of config.versions) {
		recordDetectedManifestEntry(root, entry, state);
	}
	for (const autoEntry of discoverAutoLockfileEntries(root, state.foundFiles, config.versions)) {
		recordDetectedManifestEntry(root, autoEntry, state);
	}

	const releasedChecks = collectReleasedVersionChecks(root, config.released);
	const version =
		state.detectedVersion ??
		resolveFallbackGitTagVersion(root, config.tagPrefix, options.fallbackTagVersion) ??
		"0.1.0";

	return {
		version,
		files: state.foundFiles,
		versionsByFile: state.versionsByFile,
		releasedChecks,
		tagPrefix: config.tagPrefix,
	};
}

function targetsPrimaryManifestField(entry) {
	if (entry.whereName) return false;
	if (!entry.key) return true;
	return (
		entry.key === "version" ||
		entry.key === "package.version" ||
		entry.key === "workspace.package.version" ||
		entry.key === "project.version" ||
		entry.key === "tool.poetry.version"
	);
}

/** Stages updated file contents (`Map<relPath, newContent>`) for bumping all version sources to `newVersion` without writing to disk. */
export function stageRepoVersionBumps(root, newVersion, detectedFiles, options = {}) {
	const config = loadReleaseConfig(root, options);
	const files = detectedFiles ?? detectRepoVersion(root, options).files;
	const entriesByFile = new Map();

	const addEntry = (entry) => {
		const list = entriesByFile.get(entry.file) ?? [];
		list.push(entry);
		entriesByFile.set(entry.file, list);
	};

	for (const entry of config.versions) {
		addEntry(entry);
	}
	for (const rel of files) {
		const existing = entriesByFile.get(rel);
		if (!existing) {
			entriesByFile.set(rel, [{ file: rel }]);
		} else if (MANIFEST_CANDIDATES.includes(rel) && !existing.some(targetsPrimaryManifestField)) {
			existing.unshift({ file: rel });
		}
	}
	for (const autoEntry of discoverAutoLockfileEntries(root, files, config.versions)) {
		addEntry(autoEntry);
	}

	const updates = new Map();
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
			updates.set(rel, after);
		}
	}
	return updates;
}

/** Updates all detected version sources in `root` on disk and returns the modified relative paths. */
export function bumpRepoVersionFiles(root, newVersion, detectedFiles, options = {}) {
	const updates = stageRepoVersionBumps(root, newVersion, detectedFiles, options);
	const modified = [];
	for (const [rel, content] of updates.entries()) {
		const abs = resolveSafeRepoPath(root, rel);
		writeFileSync(abs, content);
		modified.push(rel);
	}
	return modified;
}

/** Validates that every detected version source matches `currentVersion` and `[release].released` entries are stable SemVer. */
export function validateVersionConsistency(
	currentVersion,
	versionsByFile,
	{ releasedChecks = [], tagPrefix = "v" } = {},
) {
	for (const [file, ver] of versionsByFile.entries()) {
		if (ver !== currentVersion) {
			throw new Error(
				`manifest version mismatch: ${file} has ${ver}, expected ${currentVersion}`,
			);
		}
	}
	for (const { label, version: ver } of releasedChecks) {
		const parsed = parseSemver(ver);
		if (!parsed || parsed.prerelease) {
			throw new Error(
				`manifest version mismatch: ${label} has ${ver}, expected a released semver version`,
			);
		}
	}
	const refName = process.env.GITHUB_REF_NAME;
	const expectedTag = formatTag(currentVersion, tagPrefix);
	const isSemverTagRef =
		process.env.GITHUB_REF_TYPE === "tag" ||
		(Boolean(refName) &&
			tagPrefix !== "" &&
			refName.startsWith(tagPrefix) &&
			Boolean(parseSemver(refName.slice(tagPrefix.length))));
	if (isSemverTagRef && refName && refName !== expectedTag) {
		throw new Error(
			`git tag (${refName}) does not match manifest version (${expectedTag})`,
		);
	}
}
