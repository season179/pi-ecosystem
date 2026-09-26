// Derived from core/chat.ts, official 0.7.0 (MIT).
export interface TransportTurn {
  role: string;
  content: string;
  timestamp?: string;
}

/** Prepend the REF-ID system turn to a set of already-normalized turns. */
export function withRefId(refId: string, turns: TransportTurn[], baseTs: string): TransportTurn[] {
  return [{ role: "system", content: `REF-ID: ${refId}`, timestamp: baseTs }, ...turns];
}

/**
 * Render normalized turns as a JSONL transcript (ONE turn per line) — the same shape everywhere:
 * live write-back and backfilled chats alike. JSONL beats a JSON array on both ends: appending a
 * turn never rewrites the document, and the server's structured chunker treats each line as an
 * atomic unit (`retain_structured_chunk_size`), so a turn is never split mid-thought. The REF-ID
 * system turn leads; tool activity is already compacted into `role:"action"` turns.
 */
export function renderSessionJsonl(refId: string, turns: TransportTurn[], baseTs: string): string {
  return withRefId(refId, turns, baseTs)
    .map((t) => JSON.stringify(t))
    .join("\n");
}

