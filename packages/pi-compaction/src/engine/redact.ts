/**
 * Best-effort redaction of obvious secrets before text leaves the machine.
 * This is not comprehensive secret detection; it removes recognizable credential shapes.
 */

const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
	{ pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: "private-key" },
	{ pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, label: "api-key" },
	{ pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, label: "github-token" },
	{ pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: "github-token" },
	{ pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: "aws-key" },
	{ pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, label: "slack-token" },
	{ pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: "jwt" },
	{ pattern: /(\b(?:authorization|bearer)\b\s*[:=]?\s*)(?:bearer\s+)?[A-Za-z0-9._~+/-]{16,}=*/gi, label: "bearer" },
	{
		pattern: /(\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\b\s*[:=]\s*)["']?[^\s"'&;]{6,}["']?/gi,
		label: "assignment",
	},
];

/** File names whose contents are treated as sensitive when they appear as tool arguments. */
export const SENSITIVE_PATH_PATTERN = /(^|[\\/])(\.env(\.[^\\/]*)?|\.netrc|\.npmrc|\.pypirc|id_(rsa|ed25519|ecdsa)(\.pub)?|credentials(\.json)?|\.git-credentials|.*\.pem|.*\.key|.*\.p12|.*\.pfx)$/i;

export interface RedactionResult {
	text: string;
	/** Number of replacements made. */
	redactions: number;
}

export function redactSecrets(text: string): RedactionResult {
	let redactions = 0;
	let output = text;
	for (const { pattern, label } of SECRET_PATTERNS) {
		output = output.replace(pattern, (match, prefix?: string) => {
			redactions++;
			return typeof prefix === "string" && match.startsWith(prefix) ? `${prefix}[redacted:${label}]` : `[redacted:${label}]`;
		});
	}
	return { text: output, redactions };
}

export function isSensitivePath(value: unknown): boolean {
	return typeof value === "string" && SENSITIVE_PATH_PATTERN.test(value.trim());
}
