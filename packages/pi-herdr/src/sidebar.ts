import { runHerdr } from './herdr-cli.js';
import { observeWorkers, type WorkerRecord } from './owned-workers.js';

const REFRESH_MS = 30_000;
const TTL_MS = 90_000;
const WRITE_TIMEOUT_MS = 3_000;

function displayAgent(agent: string, record: WorkerRecord): string | undefined {
  const prefix = `${agent} · #${record.id}`;
  const budget = 40 - [...prefix].length;
  if (budget < 0) return undefined;
  const task = [...(record.task ?? '')];
  if (task.length === 0 || budget < 2) return prefix;
  return `${prefix} ${
    task.length <= budget - 1 ? task.join('') : `${task.slice(0, budget - 2).join('')}…`
  }`;
}

/** Serializes bounded writes and cleanup; a clear always follows any already-started write. */
export class SidebarReconciler {
  private readonly source: string;
  private revision = 0;
  private timer: NodeJS.Timeout | undefined;
  private lookup: AbortController | undefined;
  private queue: Promise<void> = Promise.resolve();
  // Remember attempted writes too: timeout/error does not prove Herdr rejected them.
  private readonly targets = new Map<number, Set<string>>();

  constructor(
    sessionId: string,
    private readonly current: () => boolean,
    private readonly records: () => WorkerRecord[],
  ) {
    this.source = `pi-herdr:${sessionId}`;
  }

  private invalidate(): number {
    this.revision += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.lookup?.abort();
    return this.revision;
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    // Presentation is best-effort; a failed step must not block later cleanup.
    this.queue = this.queue.then(work).catch(() => undefined);
    return this.queue;
  }

  private active(revision: number): boolean {
    return revision === this.revision && this.current();
  }

  refresh(): Promise<void> {
    const revision = this.invalidate();
    return this.enqueue(() => this.pass(revision));
  }

  release(worker: number): Promise<void> {
    const revision = this.invalidate();
    const clearing = this.enqueue(() => this.clear(worker));
    void this.enqueue(() => this.pass(revision));
    return clearing;
  }

  stop(): Promise<void> {
    this.invalidate();
    return this.enqueue(() => this.clear());
  }

  private async clear(worker?: number): Promise<void> {
    const groups =
      worker === undefined ? [...this.targets] : [[worker, this.targets.get(worker)] as const];
    for (const [id, targets] of groups) {
      for (const paneId of targets ?? []) {
        await runHerdr(
          ['pane', 'report-metadata', paneId, '--source', this.source, '--clear-display-agent'],
          { timeoutMs: WRITE_TIMEOUT_MS },
        );
      }
      this.targets.delete(id);
    }
  }

  private async pass(revision: number): Promise<void> {
    if (!this.active(revision)) return;
    let records: WorkerRecord[];
    try {
      records = this.records();
    } catch {
      // A retired Pi context may reject reads; cleanup must still be runnable.
      return;
    }
    if (!records.some((record) => !record.released)) return;
    const controller = new AbortController();
    this.lookup = controller;
    try {
      const observed = await observeWorkers(records, controller.signal);
      for (const worker of observed.workers) {
        if (!this.active(revision)) return;
        if (worker.observation !== 'match' || !worker.live?.agent) continue;
        const agent = worker.live.agent;
        const label = displayAgent(agent, worker.record);
        if (label === undefined) continue;
        const paneId = worker.live.identity.paneId;
        const targets = this.targets.get(worker.record.id) ?? new Set<string>();
        targets.add(paneId);
        this.targets.set(worker.record.id, targets);
        // Do not abort writes: drain them before cleanup so a late write cannot undo a clear.
        await runHerdr(
          [
            'pane',
            'report-metadata',
            paneId,
            '--source',
            this.source,
            '--agent',
            agent,
            '--display-agent',
            label,
            '--ttl-ms',
            String(TTL_MS),
          ],
          { timeoutMs: WRITE_TIMEOUT_MS },
        );
      }
    } finally {
      if (this.lookup === controller) this.lookup = undefined;
      // Claim/release invalidates this revision; no second potentially stale read needed.
      if (this.active(revision)) {
        this.timer = setTimeout(() => {
          void this.refresh();
        }, REFRESH_MS);
        this.timer.unref();
      }
    }
  }
}
