import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseWorkflowRunsResponse, waitForCiWorkflows } from "../src/github.mjs";
import { gitCommit, initGitRepo, withEnv, withTempDir } from "./helpers.mjs";

const silentLog = () => {};

describe("CI workflow polling (waitForCiWorkflows)", () => {
	test("parses workflow_runs responses and filters schedule / cancelled pull_request runs", () => {
		assert.deepEqual(parseWorkflowRunsResponse(""), { status: "none", conclusion: "none" });
		assert.deepEqual(parseWorkflowRunsResponse(JSON.stringify({ workflow_runs: [] })), {
			status: "none",
			conclusion: "none",
		});
		assert.deepEqual(
			parseWorkflowRunsResponse(
				JSON.stringify({
					workflow_runs: [
						{ run_number: 10, status: "completed", conclusion: "failure" },
						{ run_number: 11, status: "completed", conclusion: "success" },
					],
				}),
			),
			{ status: "completed", conclusion: "success" },
		);
		assert.deepEqual(
			parseWorkflowRunsResponse(
				JSON.stringify({
					workflow_runs: [
						{
							run_number: 1,
							event: "push",
							status: "completed",
							conclusion: "success",
						},
						{
							run_number: 2,
							event: "pull_request",
							status: "completed",
							conclusion: "cancelled",
						},
						{
							run_number: 3,
							event: "schedule",
							status: "completed",
							conclusion: "failure",
						},
					],
				}),
			),
			{ status: "completed", conclusion: "success" },
		);
	});

	test("matches GitHub branch-protection conclusions, scopes push strictly to event=push, URL-encodes names, and paginates", () => {
		withTempDir((dir) => {
			initGitRepo(dir);
			gitCommit(dir, "feat: initial");

			withEnv({}, () => {
				// Empty input is a no-op
				waitForCiWorkflows(dir, "https://github.com/owner/pkg", "  , \n ", 5, {
					log: silentLog,
				});

				// Missing slug throws
				assert.throws(
					() =>
						waitForCiWorkflows(dir, "", "ci.yml", 5, {
							execGh: () => undefined,
							sleepSync: () => {},
							log: silentLog,
						}),
					/cannot wait for CI without repository slug and HEAD SHA/,
				);

				// Accepts success, neutral, and skipped; URL-encodes workflow name; keeps event=push strict even after 3+ empty polls
				const queries = [];
				const responses = [
					JSON.stringify({ workflow_runs: [] }),
					JSON.stringify({ workflow_runs: [] }),
					JSON.stringify({ workflow_runs: [] }),
					JSON.stringify({
						workflow_runs: [{ run_number: 1, status: "in_progress", conclusion: null }],
					}),
					JSON.stringify({
						workflow_runs: [{ run_number: 1, status: "completed", conclusion: "skipped" }],
					}),
					JSON.stringify({
						workflow_runs: [{ run_number: 2, status: "completed", conclusion: "neutral" }],
					}),
				];
				let sleepCount = 0;
				waitForCiWorkflows(
					dir,
					"https://github.com/owner/pkg",
					"CI Check.yml, lint.yml",
					5,
					{
						execGh: (args) => {
							queries.push(args[1]);
							return responses.shift();
						},
						sleepSync: () => {
							sleepCount += 1;
						},
						log: silentLog,
					},
				);
				assert.equal(sleepCount, 4);
				assert.ok(
					queries.every((q) => q.includes("per_page=100") && q.includes("event=push")),
					`expected all push queries to keep event=push & per_page=100, got: ${queries.join(", ")}`,
				);
				assert.ok(queries[0].includes("workflows/CI%20Check.yml/runs"));

				// Fails on failure, cancelled, timed_out, and action_required
				for (const badConclusion of [
					"failure",
					"cancelled",
					"timed_out",
					"action_required",
				]) {
					assert.throws(
						() =>
							waitForCiWorkflows(dir, "https://github.com/owner/pkg", "ci.yml", 5, {
								execGh: () =>
									JSON.stringify({
										workflow_runs: [
											{
												run_number: 1,
												status: "completed",
												conclusion: badConclusion,
											},
										],
									}),
								sleepSync: () => {},
								log: silentLog,
							}),
						new RegExp(`concluded "${badConclusion}"`),
					);
				}

				// Retries transient API errors (< 8) and fails at 8
				let attempts = 0;
				waitForCiWorkflows(dir, "https://github.com/owner/pkg", "ci.yml", 5, {
					execGh: () => {
						attempts += 1;
						return attempts < 4
							? undefined
							: JSON.stringify({
									workflow_runs: [
										{ run_number: 1, status: "completed", conclusion: "success" },
									],
								});
					},
					sleepSync: () => {},
					log: silentLog,
				});
				assert.equal(attempts, 4);

				assert.throws(
					() =>
						waitForCiWorkflows(dir, "https://github.com/owner/pkg", "ci.yml", 5, {
							execGh: () => undefined,
							sleepSync: () => {},
							log: silentLog,
						}),
					/after 8 consecutive gh api errors/,
				);

				// Fails after 20 empty responses
				assert.throws(
					() =>
						waitForCiWorkflows(dir, "https://github.com/owner/pkg", "ci.yml", 5, {
							execGh: () => JSON.stringify({ workflow_runs: [] }),
							sleepSync: () => {},
							log: silentLog,
						}),
					/no CI workflow run found for "ci\.yml".*after 5 minutes/,
				);
			});

			// workflow_dispatch omits event=push so manual dispatch / tag runs match any event on head_sha
			withEnv({ GITHUB_EVENT_NAME: "workflow_dispatch" }, () => {
				let queriedEndpoint = "";
				waitForCiWorkflows(dir, "https://github.com/owner/pkg", "ci.yml", 5, {
					execGh: (args) => {
						queriedEndpoint = args[1];
						return JSON.stringify({
							workflow_runs: [
								{ run_number: 1, status: "completed", conclusion: "success" },
							],
						});
					},
					sleepSync: () => {},
					log: silentLog,
				});
				assert.ok(!queriedEndpoint.includes("event=push"));
				assert.ok(queriedEndpoint.includes("per_page=100"));
			});
		});
	});
});
