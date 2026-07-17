import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface ResolvedTarget {
	/** Canonical target path (or canonical ancestor plus missing suffix). */
	absolutePath: string;
	workspacePath: string;
	relativePath: string;
	exists: boolean;
}

export class PathPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PathPolicyError";
	}
}

export function isPathInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function globPattern(pattern: string): RegExp {
	let source = "";
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];
		if (char === "*" && pattern[index + 1] === "*") {
			source += ".*";
			index += 1;
		} else if (char === "*") {
			source += "[^/]*";
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${source}(?:/.*)?$`);
}

function isProtected(target: string, root: string, protectedPaths: readonly string[]): string | undefined {
	const relativeTarget = relative(root, target).split(sep).join("/");
	for (const configured of protectedPaths) {
		if (!isAbsolute(configured) && /[*?]/.test(configured)) {
			const normalized = configured.split(sep).join("/").replace(/^\.\//, "");
			if (globPattern(normalized).test(relativeTarget)) return configured;
			continue;
		}
		const protectedPath = isAbsolute(configured)
			? resolve(configured)
			: resolve(root, configured);
		if (isPathInside(protectedPath, target)) return configured;
	}
	return undefined;
}

/**
 * Resolve and validate a write/edit target.
 *
 * Existing symlinks anywhere below the workspace root are rejected rather than
 * followed. For a new target, the nearest existing ancestor is realpathed and
 * the missing suffix is appended. The check is repeated immediately before the
 * built-in tool executes, but cannot make in-process Node fs operations immune
 * to a malicious concurrent TOCTOU swap.
 */
export async function resolveGuardedTarget(
	cwd: string,
	inputPath: string,
	protectedPaths: readonly string[],
): Promise<ResolvedTarget> {
	if (!inputPath || inputPath.includes("\0")) {
		throw new PathPolicyError("File path is empty or contains a NUL byte");
	}
	const lexicalRoot = resolve(cwd);
	const lexicalTarget = resolve(lexicalRoot, inputPath);
	if (!isPathInside(lexicalRoot, lexicalTarget)) {
		throw new PathPolicyError(`Path is outside the workspace: ${inputPath}`);
	}

	const canonicalRoot = await realpath(lexicalRoot);
	const rel = relative(lexicalRoot, lexicalTarget);
	const parts = rel === "" ? [] : rel.split(sep);
	let lexicalCursor = lexicalRoot;
	let canonicalCursor = canonicalRoot;
	let exists = true;

	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index];
		lexicalCursor = resolve(lexicalCursor, part);
		try {
			const stat = await lstat(lexicalCursor);
			if (stat.isSymbolicLink()) {
				throw new PathPolicyError(
					`Symlink components are not writable through guarded write/edit: ${inputPath}`,
				);
			}
			if (index === parts.length - 1 && stat.isFile() && stat.nlink > 1) {
				throw new PathPolicyError(
					`Hard-linked files are not writable through guarded write/edit: ${inputPath}`,
				);
			}
			canonicalCursor = await realpath(lexicalCursor);
		} catch (error) {
			if (error instanceof PathPolicyError) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			exists = false;
			canonicalCursor = resolve(canonicalCursor, ...parts.slice(index));
			break;
		}
	}

	if (!isPathInside(canonicalRoot, canonicalCursor)) {
		throw new PathPolicyError(`Canonical path escapes the workspace: ${inputPath}`);
	}
	const protectedMatch = isProtected(canonicalCursor, canonicalRoot, protectedPaths);
	if (protectedMatch) {
		throw new PathPolicyError(
			`Path is protected by pi-guard (${protectedMatch}): ${inputPath}`,
		);
	}
	return {
		absolutePath: canonicalCursor,
		workspacePath: canonicalRoot,
		relativePath: relative(canonicalRoot, canonicalCursor) || ".",
		exists,
	};
}
