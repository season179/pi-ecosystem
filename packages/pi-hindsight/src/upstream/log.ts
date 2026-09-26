// Local safety replacement: no files, transcript/config values, or HTTP bodies in logs.
export const log = { warn(..._args: unknown[]): void {} };
