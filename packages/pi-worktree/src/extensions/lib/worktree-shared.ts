import * as fs from "node:fs";
import * as path from "node:path";

export interface WorktreeInfo {
	path: string;
	branch: string;
	repoRoot: string;
	pid: number;
	/**
	 * Commit SHA the worktree branch was created from. Used at shutdown to
	 * count commits made inside the worktree without misattributing
	 * pre-existing base-branch history. Optional for backwards compatibility
	 * with markers written before this field existed.
	 */
	base?: string;
}

export function worktreeMarkerFile(
	repoRoot: string,
	pid: number = process.pid,
): string {
	return path.join(repoRoot, ".pi", `worktree-active-${pid}.json`);
}

export function isWorktreeInfo(value: unknown): value is WorktreeInfo {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.path === "string" &&
		typeof candidate.branch === "string" &&
		typeof candidate.repoRoot === "string" &&
		candidate.pid === process.pid &&
		(candidate.base === undefined || typeof candidate.base === "string")
	);
}

export function readWorktreeMarker(repoRoot: string): WorktreeInfo | null {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(worktreeMarkerFile(repoRoot), "utf-8"),
		);
		const info = isWorktreeInfo(parsed) ? parsed : null;
		return info?.repoRoot === repoRoot ? info : null;
	} catch {
		return null;
	}
}

export function saveWorktreeMarker(
	repoRoot: string,
	info: WorktreeInfo,
): void {
	const markerPath = worktreeMarkerFile(repoRoot);
	fs.mkdirSync(path.dirname(markerPath), { recursive: true });
	fs.writeFileSync(markerPath, JSON.stringify(info, null, 2));
}

export function removeWorktreeMarker(repoRoot: string): void {
	try {
		fs.unlinkSync(worktreeMarkerFile(repoRoot));
	} catch {}
}
