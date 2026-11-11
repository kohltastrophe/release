import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export function withTempDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), "release-test-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export function withEnv(overrides, fn) {
	const prevEnv = { ...process.env };
	try {
		// Clear ambient GitHub Actions env vars unless explicitly set in overrides
		for (const key of Object.keys(process.env)) {
			if (
				key.startsWith("INPUT_") ||
				key.startsWith("GITHUB_") ||
				key === "GH_TOKEN" ||
				key === "PR_TITLE"
			) {
				delete process.env[key];
			}
		}
		for (const [key, val] of Object.entries(overrides)) {
			if (val === undefined) delete process.env[key];
			else process.env[key] = val;
		}
		return fn();
	} finally {
		for (const key of Object.keys(process.env)) {
			if (!(key in prevEnv)) delete process.env[key];
		}
		for (const [key, val] of Object.entries(prevEnv)) {
			process.env[key] = val;
		}
	}
}

export function initGitRepo(dir, branch = "main") {
	execFileSync("git", ["init", "-b", branch], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["config", "tag.gpgSign", "false"], { cwd: dir, stdio: "pipe" });
}

export function gitCommit(dir, message, file = "README.md", content = message) {
	writeFileSync(join(dir, file), content.endsWith("\n") ? content : `${content}\n`);
	execFileSync("git", ["add", "--", file], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["commit", "--no-gpg-sign", "-m", message], { cwd: dir, stdio: "pipe" });
}

export function makeRemotePair(baseDir) {
	const remoteDir = join(baseDir, "remote.git");
	const repoDir = join(baseDir, "repo");
	const binDir = join(baseDir, "bin");
	mkdirSync(remoteDir, { recursive: true });
	mkdirSync(repoDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: remoteDir, stdio: "pipe" });
	initGitRepo(repoDir);
	execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir, stdio: "pipe" });
	return { remoteDir, repoDir, binDir };
}

export function installFakeGh(binDir, handlerSourceLines) {
	const captureFile = join(binDir, "gh-calls.jsonl");
	const scriptPath = join(binDir, "fake-gh.mjs");
	const binPath = join(binDir, "gh");
	writeFileSync(
		scriptPath,
		[
			"import { appendFileSync } from 'node:fs';",
			"const args = process.argv.slice(2);",
			`appendFileSync(${JSON.stringify(captureFile)}, JSON.stringify({ args, token: process.env.GH_TOKEN || '' }) + "\\n");`,
			...handlerSourceLines,
		].join("\n"),
	);
	writeFileSync(
		binPath,
		`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`,
	);
	chmodSync(binPath, 0o755);

	const readCalls = () => {
		try {
			const raw = readFileSync(captureFile, "utf8").trim();
			return raw ? raw.split("\n").map((line) => JSON.parse(line)) : [];
		} catch {
			return [];
		}
	};
	return {
		captureFile,
		scriptPath,
		pathEnv: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
		readCalls,
	};
}

export function sha256Hex(filePath) {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function parseGitHubOutputs(outputFilePath) {
	const map = {};
	const text = readFileSync(outputFilePath, "utf8").trim();
	if (!text) return map;
	for (const line of text.split(/\r?\n/)) {
		const eq = line.indexOf("=");
		if (eq > 0) {
			map[line.slice(0, eq)] = line.slice(eq + 1);
		}
	}
	return map;
}

export function captureStdout(fn) {
	const chunks = [];
	const origWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk, encoding, cb) => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk, encoding).toString("utf8"));
		if (typeof encoding === "function") encoding();
		else if (typeof cb === "function") cb();
		return true;
	};
	try {
		fn();
	} finally {
		process.stdout.write = origWrite;
	}
	return chunks.join("");
}

export function captureStderr(fn) {
	const origError = console.error;
	const lines = [];
	console.error = (...args) => {
		lines.push(args.join(" "));
	};
	try {
		fn();
	} finally {
		console.error = origError;
	}
	return lines.join("\n");
}
