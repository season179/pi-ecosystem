import { spawn } from 'node:child_process';

const MAX_CAPTURE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
/** After a kill, stop waiting for pipes a surviving descendant may still hold. */
const KILL_SETTLE_MS = 250;

class TailBuffer {
  private value: Buffer = Buffer.alloc(0);

  append(chunk: Buffer | string): void {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (incoming.length >= MAX_CAPTURE_BYTES) {
      this.value = incoming.subarray(incoming.length - MAX_CAPTURE_BYTES);
      return;
    }

    const combined = Buffer.concat([this.value, incoming]);
    this.value =
      combined.length > MAX_CAPTURE_BYTES
        ? combined.subarray(combined.length - MAX_CAPTURE_BYTES)
        : combined;
  }

  toString(): string {
    return this.value.toString('utf8');
  }
}

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    const lastLine = text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (lastLine === undefined) return undefined;
    try {
      return JSON.parse(lastLine);
    } catch {
      return undefined;
    }
  }
}

export interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  json?: unknown;
  errorJson?: unknown;
}

export function herdrCommand(): string {
  return process.env.PI_HERDR_COMMAND ?? 'herdr';
}

export function runHerdr(
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    const stdout = new TailBuffer();
    const stderr = new TailBuffer();
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;
    // Set once timeout/abort fires; every later settlement is non-success, even if
    // the parent already exited 0 while a descendant still holds the pipes.
    let interrupted = false;
    let abort = (): void => undefined;

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      opts.signal?.removeEventListener('abort', abort);

      const stdoutText = stdout.toString();
      const stderrText = stderr.toString();
      const json = parseJson(stdoutText);
      const errorJson = parseJson(stderrText);
      resolve({
        exitCode: interrupted ? null : exitCode,
        stdout: stdoutText,
        stderr: stderrText,
        ...(json === undefined ? {} : { json }),
        ...(errorJson === undefined ? {} : { errorJson }),
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(herdrCommand(), args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      stderr.append(error instanceof Error ? error.message : String(error));
      finish(null);
      return;
    }

    const kill = (): void => {
      interrupted = true;
      // Timeout and abort are hard bounds: settle even if a descendant keeps the pipes open.
      settleTimer ??= setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(child.exitCode);
      }, KILL_SETTLE_MS);
      try {
        child.kill('SIGKILL');
      } catch (error) {
        stderr.append(
          `${stderr.toString() ? '\n' : ''}${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        finish(child.exitCode);
      }
    };
    abort = (): void => kill();

    child.stdout?.on('data', (chunk: Buffer | string) => stdout.append(chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => stderr.append(chunk));
    child.once('error', (error) => {
      stderr.append(`${stderr.toString() ? '\n' : ''}${error.message}`);
      finish(null);
    });
    child.once('close', (code) => finish(code));

    timeout = setTimeout(kill, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.signal?.aborted) abort();
  });
}
