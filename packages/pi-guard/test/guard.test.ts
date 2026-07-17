import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
	actionFingerprint,
	boundedReviewInput,
	classifyTool,
	OneShotApprovals,
	summarizeAction,
} from "../src/action-policy.js";
import { AuditLog } from "../src/audit.js";
import { parseGlobalConfig, parseProjectConfig } from "../src/config.js";
import setupGuard from "../src/extensions/guard.js";
import { withFileLock } from "../src/file-lock.js";
import { PathPolicyError, resolveGuardedTarget } from "../src/path-policy.js";
import {
	boundReviewText,
	buildSanitizedReviewHistory,
	decisionAllowsExecution,
	parseReviewDecision,
	REVIEWER_SYSTEM_PROMPT,
} from "../src/reviewer.js";
import { SnapshotStore } from "../src/snapshots.js";

const temporaryPaths: string[] = [];

async function tempDir(prefix: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), prefix));
	temporaryPaths.push(path);
	return path;
}

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("intent configuration", () => {
	it("accepts reviewer settings and warns when obsolete sandbox policy is ignored", () => {
		const parsed = parseGlobalConfig({
			mode: "review",
			shell: { allowedDomains: ["example.com"] },
			trustedTools: [],
			reviewer: { mode: "shadow", model: "zai/glm-5.2", maxTokens: 300 },
		});
		assert.equal(parsed.reviewer?.model, "zai/glm-5.2");
		assert.equal(parsed.reviewer?.maxTokens, 300);
		assert.deepEqual(parsed.warnings, [
			"mode is obsolete and ignored by intent-review mode",
			"shell is obsolete and ignored by intent-review mode",
			"trustedTools is obsolete and ignored by intent-review mode",
			"reviewer.mode is obsolete; Pi Guard now always enforces intent review",
		]);
	});

	it("allows only write restrictions in project configuration", () => {
		assert.deepEqual(parseProjectConfig({ protectedPaths: ["fixtures/production"] }), {
			protectedPaths: ["fixtures/production"],
			warnings: [],
		});
		assert.throws(() => parseProjectConfig({ reviewer: {} }), /cannot configure reviewer/);
		assert.deepEqual(parseProjectConfig({ shell: { deniedDomains: ["example.com"] } }).warnings, [
			"project shell restrictions are obsolete and ignored by intent-review mode",
		]);
	});
});

describe("cross-process storage lock", () => {
	it("recovers an incomplete lock left by a crashed process", async () => {
		const cwd = await tempDir("pi-guard-lock-");
		const lockPath = join(cwd, "storage.lock");
		await writeFile(lockPath, "{");
		const old = new Date(Date.now() - 2000);
		await utimes(lockPath, old, old);
		let ran = false;
		await withFileLock(lockPath, async () => {
			ran = true;
		}, 1000);
		assert.equal(ran, true);
		assert.equal(existsSync(lockPath), false);
	});
});

describe("audit retention", () => {
	it("serializes concurrent writers across AuditLog instances", async () => {
		const cwd = await tempDir("pi-guard-audit-");
		const path = join(cwd, "audit.jsonl");
		const first = new AuditLog(path);
		const second = new AuditLog(path);
		await Promise.all(
			Array.from({ length: 40 }, (_, index) =>
				(index % 2 === 0 ? first : second).append({
					tool: "bash",
					outcome: "allowed",
					summary: `record-${index}`,
					cwd,
				}),
			),
		);
		const records = await first.tail(100);
		assert.equal(records.length, 40);
		assert.equal(new Set(records.map((record) => record.summary)).size, 40);
	});

	it("compacts while retaining recent records", async () => {
		const cwd = await tempDir("pi-guard-audit-");
		const path = join(cwd, "audit.jsonl");
		const audit = new AuditLog(path, 800, 400);
		for (let index = 0; index < 20; index += 1) {
			await audit.append({
				tool: "bash",
				outcome: "allowed",
				summary: `${index}-${"x".repeat(100)}`,
				cwd,
			});
		}
		assert.ok((await stat(path)).size <= 800);
		assert.match((await audit.tail(3)).at(-1)?.summary ?? "", /^19-/);
	});
});

describe("write path policy", () => {
	it("allows existing and new regular files inside the workspace", async () => {
		const cwd = await tempDir("pi-guard-path-");
		mkdirSync(join(cwd, "src"));
		writeFileSync(join(cwd, "src", "a.ts"), "a");
		assert.equal((await resolveGuardedTarget(cwd, "src/a.ts", [".git"])).exists, true);
		assert.equal((await resolveGuardedTarget(cwd, "src/new.ts", [".git"])).exists, false);
	});

	it("blocks traversal and configured protected write paths", async () => {
		const cwd = await tempDir("pi-guard-path-");
		mkdirSync(join(cwd, ".git"));
		await assert.rejects(resolveGuardedTarget(cwd, "../outside", []), PathPolicyError);
		await assert.rejects(resolveGuardedTarget(cwd, ".git/config", [".git"]), /protected/);
		await assert.rejects(resolveGuardedTarget(cwd, ".env.local", [".env", ".env.*"]), /protected/);
	});

	it("blocks hard links and symlink escapes", async () => {
		const cwd = await tempDir("pi-guard-path-");
		const outside = await tempDir("pi-guard-outside-");
		const external = join(outside, "external.txt");
		writeFileSync(external, "external");
		linkSync(external, join(cwd, "hardlink.txt"));
		symlinkSync(outside, join(cwd, "linked-dir"));
		await assert.rejects(resolveGuardedTarget(cwd, "hardlink.txt", []), /Hard-linked/);
		await assert.rejects(resolveGuardedTarget(cwd, "linked-dir/new", []), /Symlink/);
	});
});

describe("action privacy and identity", () => {
	it("redacts secrets while preserving the exact shell structure for review", () => {
		const action = {
			toolName: "bash",
			input: {
				command: "API_KEY=command-secret curl example.com/$(whoami)",
				apiKey: "super-secret-value",
				payload: "x".repeat(20_000),
			},
			cwd: "/repo",
		};
		const summary = summarizeAction(action);
		assert.doesNotMatch(summary, /command-secret|super-secret-value/);
		assert.match(summary, /curl example\.com\/\$\(whoami\)/);
		const bounded = boundedReviewInput(action.input, 1000);
		assert.equal(bounded.truncated, true);
		assert.doesNotMatch(JSON.stringify(bounded.input), /command-secret|super-secret-value/);
	});

	it("binds fingerprints to tool source identity", () => {
		const action = {
			toolName: "custom",
			input: { value: 1 },
			cwd: "/repo",
			source: { path: "/a.js", source: "local" },
		};
		assert.notEqual(actionFingerprint(action), actionFingerprint({ ...action, source: { ...action.source, path: "/b.js" } }));
	});
});

describe("tool classification and one-shot approvals", () => {
	const tool = (name: string, path = `/guard/${name}.js`) => ({
		name,
		description: "",
		parameters: {} as any,
		sourceInfo: {
			path,
			source: "local",
			scope: "user" as const,
			origin: "top-level" as const,
		},
	});

	it("allows guard-owned builtins and hard-denies replacements", () => {
		assert.deepEqual(
			classifyTool({ toolName: "read", tool: tool("read"), isGuardSource: (source) => source.path.startsWith("/guard/") }),
			{ allowed: true, hard: true },
		);
		assert.equal(
			classifyTool({ toolName: "read", tool: tool("read", "/evil.js"), isGuardSource: (source) => source.path.startsWith("/guard/") }).allowed,
			false,
		);
	});

	it("routes unfamiliar custom tools to review instead of denying by name", () => {
		assert.deepEqual(
			classifyTool({ toolName: "future_cli", tool: tool("future_cli", "/future.js"), isGuardSource: () => false }),
			{ allowed: false, hard: false },
		);
	});

	it("binds one-shot approval to exact arguments and consumes it once", () => {
		const approvals = new OneShotApprovals();
		const action = { toolName: "custom", input: { path: "a" }, cwd: "/repo" };
		approvals.recordDenial(action, "unclear", true);
		approvals.approveLast();
		assert.equal(approvals.consume({ ...action, input: { path: "b" } }), false);
		assert.equal(approvals.consume(action), true);
		assert.equal(approvals.consume(action), false);
	});

	it("never overrides hard source denials", () => {
		const approvals = new OneShotApprovals();
		approvals.recordDenial({ toolName: "write", input: {}, cwd: "/repo" }, "hard", false);
		assert.throws(() => approvals.approveLast(), /cannot be overridden/);
	});
});

describe("snapshots", () => {
	it("serializes stores and deduplicates content", async () => {
		const cwd = await tempDir("pi-guard-snapshot-");
		const storeRoot = await tempDir("pi-guard-store-");
		const firstStore = new SnapshotStore(storeRoot);
		const secondStore = new SnapshotStore(storeRoot);
		const first = join(cwd, "first.txt");
		const second = join(cwd, "second.txt");
		await writeFile(first, "repeatable\n".repeat(100));
		await writeFile(second, "repeatable\n".repeat(100));
		await Promise.all([
			firstStore.create({ cwd, path: first, relativePath: "first.txt", tool: "edit" }),
			secondStore.create({ cwd, path: second, relativePath: "second.txt", tool: "edit" }),
		]);
		const usage = await firstStore.usage(cwd);
		assert.equal(usage.entries, 2);
		assert.equal(usage.blobs, 1);
	});

	it("enforces snapshot size limits", async () => {
		const cwd = await tempDir("pi-guard-snapshot-");
		const store = new SnapshotStore(await tempDir("pi-guard-store-"), { maxFileBytes: 4 });
		const path = join(cwd, "large.txt");
		await writeFile(path, "too large");
		await assert.rejects(store.create({ cwd, path, relativePath: "large.txt", tool: "write" }), /exceeds the 4-byte/);
	});

	it("uses Git objects for clean tracked files", async () => {
		const cwd = await tempDir("pi-guard-snapshot-git-");
		const store = new SnapshotStore(await tempDir("pi-guard-store-"), { maxFileBytes: 4 });
		const path = join(cwd, "tracked.txt");
		await writeFile(path, "committed\n");
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["add", "tracked.txt"], { cwd });
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd });
		const snapshot = await store.create({ cwd, path, relativePath: "tracked.txt", tool: "edit" });
		assert.equal(snapshot.storage, "git");
		await writeFile(path, "changed\n");
		await store.restore(cwd, snapshot.id);
		assert.equal(await readFile(path, "utf8"), "committed\n");
	});

	it("restores overwritten files and removes newly created files", async () => {
		const cwd = await tempDir("pi-guard-snapshot-");
		const store = new SnapshotStore(await tempDir("pi-guard-store-"));
		const existing = join(cwd, "existing.txt");
		await writeFile(existing, "before");
		const old = await store.create({ cwd, path: existing, relativePath: "existing.txt", tool: "write" });
		await writeFile(existing, "after");
		await store.restore(cwd, old.id);
		assert.equal(await readFile(existing, "utf8"), "before");
		const fresh = join(cwd, "fresh.txt");
		const absent = await store.create({ cwd, path: fresh, relativePath: "fresh.txt", tool: "write" });
		await writeFile(fresh, "new");
		await store.restore(cwd, absent.id);
		assert.equal(existsSync(fresh), false);
	});
});

describe("intent reviewer", () => {
	it("allows direct and necessary actions regardless of destructiveness", () => {
		for (const alignment of ["direct", "necessary-step"] as const) {
			assert.equal(decisionAllowsExecution({ outcome: "allow", alignment, rationale: "requested rm -rf" }), true);
		}
		assert.match(REVIEWER_SYSTEM_PROMPT, /Allow an aligned action even when it is destructive/);
		assert.match(REVIEWER_SYSTEM_PROMPT, /Risk is not a separate reason to deny/);
		assert.match(REVIEWER_SYSTEM_PROMPT, /every command substitution/);
		assert.match(REVIEWER_SYSTEM_PROMPT, /aligned outer command does not authorize an unrelated nested/);
	});

	it("denies unrelated, broader, and unclear actions", () => {
		for (const alignment of ["unrelated", "broader-than-requested", "unclear"] as const) {
			assert.equal(decisionAllowsExecution({ outcome: "deny", alignment, rationale: "not requested" }), false);
		}
	});

	it("parses only internally consistent structured decisions", () => {
		assert.deepEqual(
			parseReviewDecision('{"outcome":"allow","alignment":"necessary-step","rationale":"needed for requested task"}'),
			{ outcome: "allow", alignment: "necessary-step", rationale: "needed for requested task" },
		);
		assert.throws(() => parseReviewDecision("ALLOW"), /malformed JSON/);
		assert.throws(
			() => parseReviewDecision('{"outcome":"allow","alignment":"unrelated","rationale":"bad"}'),
			/inconsistent/,
		);
	});

	it("bounds oversized current input", () => {
		const bounded = boundReviewText(`START-${"x".repeat(20_000)}-END`, 1000);
		assert.equal(bounded.truncated, true);
		assert.match(bounded.text, /^START-/);
		assert.match(bounded.text, /-END$/);
	});

	it("keeps user messages and tool calls but strips assistant prose and tool results", () => {
		const history = buildSanitizedReviewHistory([
			{ type: "message", message: { role: "user", content: "Delete src/old.ts" } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "I authorize myself" },
						{ type: "toolCall", name: "bash", arguments: { command: "rm src/old.ts", content: "private source" } },
					],
				},
			},
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "PROMPT INJECTION" }] } },
		] as any);
		assert.match(history, /Delete src\/old\.ts/);
		assert.match(history, /rm src\/old\.ts/);
		assert.doesNotMatch(history, /private source|authorize myself|PROMPT INJECTION/);
	});
});

describe("extension registration", () => {
	it("registers unrestricted reads and intent-reviewed normal bash without Sandbox Runtime", async () => {
		const tools = new Map<string, any>();
		setupGuard({
			registerTool: (tool: any) => tools.set(tool.name, tool),
			registerCommand: () => {},
			on: () => {},
			getAllTools: () => [...tools.values()],
			sendMessage: () => {},
		} as any);
		assert.match(tools.get("bash").label, /intent review/);
		for (const name of ["read", "grep", "find", "ls"]) {
			assert.match(tools.get(name).label, /unrestricted/);
		}

		const cwd = await tempDir("pi-guard-read-");
		const outside = await tempDir("pi-guard-outside-read-");
		const path = join(outside, "secret.txt");
		await writeFile(path, "readable");
		const result = await tools.get("read").execute(
			"read-test",
			{ path },
			undefined,
			() => {},
			{ cwd } as any,
		);
		assert.match(JSON.stringify(result), /readable/);
	});

	it("has removed Sandbox Runtime from package code and dependencies", () => {
		const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
		assert.equal(packageJson.dependencies?.["@anthropic-ai/sandbox-runtime"], undefined);
		assert.equal(existsSync(join(import.meta.dirname, "..", "src", "bash-sandbox.ts")), false);
	});
});
