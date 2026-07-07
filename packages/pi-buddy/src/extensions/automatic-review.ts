// Shared heuristics for automatic watchdog/run-end review suppression.
// Keep benign negations broad enough to erase phrases like "No factual errors"
// before the concern marker sees words such as "error".

const STANDALONE_PASS_LINE = /^[*_`"'\s]*PASS[*_`"'.!\s]*$/i;

const BENIGN_PASSISH_PATTERNS = [
	/no real (?:problem|issue)s?/gi,
	/nothing to flag/gi,
	/no correctness (?:defects|issues?)/gi,
	/no factual or technical errors?(?: spotted)?/gi,
	/no (?:issues?|blockers?|blocking problems?)/gi,
	/no security (?:issues?|problems?|defects?)/gi,
	/no regressions?/gi,
	/not (?:a )?blocker/gi,
];

const CONCERN_FORCE_PATTERN =
	/\b(?:failed|failing|broken|missing|missed|wrong|incorrect|security|vulnerability|regression|bug|error|blocked|blocking|critical)\b|\bdata loss\b|\bmust fix\b|\brequired fix\b|\bneed(?:s|ed)? to fix\b|\bdoes not\b|\bdoesn't\b|\bnot working\b|\bwrong direction\b|\bwon't scale\b|\bwill not scale\b/i;

export function isStandalonePassLine(text: string): boolean {
	return STANDALONE_PASS_LINE.test(text.trim());
}

export function hasAutomaticConcernMarker(text: string): boolean {
	let normalized = text.toLowerCase();
	for (const pattern of BENIGN_PASSISH_PATTERNS) {
		normalized = normalized.replace(pattern, " ");
	}
	return CONCERN_FORCE_PATTERN.test(normalized);
}
