import { openSync, closeSync, unlinkSync } from 'node:fs';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { History } from './history.js';
import { HISTORY_BYTES } from './history.js';
import { fingerprintTurns, planRetain, type RetainCursor } from './upstream/retain-cursor.js';
import { renderSessionJsonl } from './upstream/chat.js';
import type { HindsightClient } from './upstream/client.js';
import type { RetainStamp } from './upstream/retain-stamp.js';
import { uuidV5 } from './upstream/uuid.js';

export const CURSOR_TYPE = 'pi-hindsight-cursor-v1';

export interface Checkpoint {
  version: 1;
  sessionId: string;
  endpoint: string;
  bank: string;
  cursor: RetainCursor;
  operationId?: string;
  blocked?: boolean;
}

export function latestCheckpoint(entries: SessionEntry[]): Checkpoint | undefined {
  const entry = [...entries]
    .reverse()
    .find((e) => e.type === 'custom' && e.customType === CURSOR_TYPE);
  if (!entry || entry.type !== 'custom') return undefined;

  const data = entry.data as Checkpoint;
  if (
    data?.version !== 1 ||
    typeof data.sessionId !== 'string' ||
    typeof data.endpoint !== 'string' ||
    typeof data.bank !== 'string' ||
    !Number.isSafeInteger(data.cursor?.turns) ||
    data.cursor.turns < 0 ||
    typeof data.cursor.fingerprint !== 'string' ||
    data.cursor.bank !== data.bank ||
    (data.operationId !== undefined && typeof data.operationId !== 'string')
  )
    throw new Error('Hindsight cursor is invalid; capture blocked');

  return data;
}

export function lockSession(file: string): () => void {
  const path = `${file}.pi-hindsight.lock`;
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch {
    throw new Error(
      'Hindsight session capture is locked; another writer or interrupted run needs review',
    );
  }

  return () => {
    closeSync(fd);
    unlinkSync(path);
  };
}

/** Official cursor/payload identity, persisted as small non-context Pi custom entries.
 * No pending payload store, retry loop, replacement, or recovery daemon. A pending
 * operation must be verifiably completed before the cursor permits another append.
 */
export async function retainHistory(options: {
  history: History;
  client: HindsightClient;
  checkpoint?: Checkpoint;
  stamp: RetainStamp;
  guard: () => void;
  save: (value: Checkpoint) => void;
}): Promise<string> {
  const { history: h, client, stamp, guard, save } = options;
  const endpoint = client.options.apiUrl;
  const bank = client.options.bank;
  let checkpoint = options.checkpoint;
  const documentId = `conversation:${h.sessionId}`;

  if (
    checkpoint &&
    (checkpoint.sessionId !== h.sessionId ||
      checkpoint.endpoint !== endpoint ||
      checkpoint.bank !== bank)
  ) {
    throw new Error(
      'Hindsight session destination changed; capture blocked rather than copying history across banks',
    );
  }
  if (checkpoint?.blocked)
    throw new Error('Hindsight source replay is blocked after curation in this session');

  if (checkpoint?.operationId) {
    const operation = await client.operation(checkpoint.operationId);
    guard();
    if (operation?.status === 'pending' || operation?.status === 'processing')
      return 'accepted; extraction still pending';
    if (operation?.status !== 'completed')
      throw new Error(
        'Hindsight prior write is failed, missing or uncertain; capture blocked, not retried',
      );

    checkpoint = { ...checkpoint, operationId: undefined };
    save(checkpoint);
  }

  if (!checkpoint) {
    // A missing local cursor must never trigger official's cumulative REPLACE.
    if ((await client.document(documentId)) !== undefined)
      throw new Error(
        'Hindsight document already exists without a trusted cursor; capture blocked to preserve evidence and curation',
      );
    guard();

    if (!(await client.supportsIdempotentRetain()))
      throw new Error('Hindsight safe append needs verified server idempotency (API >=0.8.6)');
    guard();

    checkpoint = {
      version: 1,
      sessionId: h.sessionId,
      endpoint,
      bank,
      cursor: { turns: 0, fingerprint: fingerprintTurns([], 0), bank, appendSupported: true },
    };
  }

  const plan = planRetain(h.turns, checkpoint.cursor, { appendSupported: true, bank });
  if (plan.mode === 'replace')
    throw new Error(
      'Hindsight branch or earlier source changed; capture blocked rather than overwriting retained evidence',
    );
  if (plan.mode === 'skip') return 'unchanged; no write';

  if (checkpoint.cursor.turns > 0) {
    const document = await client.document(documentId);
    guard();

    const expected = renderSessionJsonl(
      documentId,
      h.turns.slice(0, checkpoint.cursor.turns),
      h.start,
    );
    const original =
      typeof document?.original_text === 'string'
        ? document.original_text
            .split('\n')
            .filter((line: string) => line.trim())
            .join('\n')
        : undefined;
    if (document?.id !== documentId || document.bank_id !== bank || original !== expected) {
      throw new Error(
        'Hindsight remote source no longer matches the retained prefix; capture blocked, never repaired by replacement',
      );
    }

    // Curation from ANY session (another Pi session, Claude, an operator) marks this source's facts;
    // an append re-extracts the whole document and would resurrect them. Refuse and remember.
    const curation = await client.documentCuration(documentId);
    guard();
    if (curation.edited || curation.invalidated) {
      save({ ...checkpoint, blocked: true });
      throw new Error(
        'Hindsight source has curated facts; automatic capture blocked to avoid resurrecting them',
      );
    }
  }

  const content =
    checkpoint.cursor.turns === 0
      ? renderSessionJsonl(documentId, h.turns, h.start)
      : h.turns
          .slice(plan.fromTurn)
          .map((turn) => JSON.stringify(turn))
          .join('\n');
  if (Buffer.byteLength(content) > HISTORY_BYTES)
    throw new Error('Hindsight payload exceeds capture limit; no partial replacement');

  const operationId = uuidV5(`${bank}\n${documentId}\nappend\n${content}`);
  const next: Checkpoint = {
    ...checkpoint,
    cursor: {
      turns: h.turns.length,
      fingerprint: fingerprintTurns(h.turns, h.turns.length),
      bank,
      appendSupported: true,
    },
    operationId,
  };

  guard();
  save(next); // Small claim BEFORE sending: unknown writes cannot be resent on resume.

  await client.retain(
    content,
    'coding agent session',
    documentId,
    [...new Set([...stamp.tags, 'source:chat', 'harness:pi'])],
    'conversation',
    {
      timestamp: h.start,
      operationId,
      metadata: {
        ...stamp.metadata,
        source: 'chat',
        session_id: h.sessionId,
        ref_id: documentId,
        harness: 'pi',
      },
    },
  );
  guard();

  return `accepted ${operationId}; extraction/consolidation not yet verified`;
}
