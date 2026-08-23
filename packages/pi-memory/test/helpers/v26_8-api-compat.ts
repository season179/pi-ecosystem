import type { Memory, MutationResult } from "../../dist/store.js";

declare const memory: Memory;

// A 26.8 consumer could construct this exported result shape in a mock or adapter.
// Keep that source compiling when hardened mutations add fields to their result.
const legacyResult: MutationResult = {
	memories: [memory],
	tokens: { details: 1, index: 1 },
};

void legacyResult;
