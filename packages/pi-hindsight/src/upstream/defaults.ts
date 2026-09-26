// Config dependencies extracted from official 0.7.0; no setup effects.
export const DEFAULT_SEED_LIMIT = 300;
export const DEFAULT_PAGE_SEARCH_LIMIT = 10;
export type ObservationScopes = "shared" | "combined" | "per_tag" | "all_combinations" | "per_source" | string[][];
export const DEFAULT_OBSERVATION_SCOPES: ObservationScopes = "shared";
export const RETAIN_EXTRACTION_MODES = ["concise", "verbose", "verbatim", "chunks"] as const;
export type RetainExtractionMode = (typeof RETAIN_EXTRACTION_MODES)[number];
export const DEFAULT_RETAIN_EXTRACTION_MODE: RetainExtractionMode = "concise";
export const DEFAULT_PAGE_TRIGGER_CRON = "H * * * *";
export type PagesConfig = Record<string, false | { source_query?: string }>;
export type CustomPagesConfig = Record<string, { source_query: string; tags?: string[] }>;
export const PAGE_NAMES: readonly string[] = ["Component map", "Core concepts", "Conventions and patterns", "Key decisions and rationale", "Initiatives and enhancements"];
const CRON_FIELD_RANGES: readonly (readonly [number, number])[] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week
];

const HASHED_FIELD = /^H(?:\((\d+)-(\d+)\))?$/;

/**
 * Does this expression ask for hashing at all? Plain crons take every path below unchanged.
 *
 * Any field STARTING with `H` counts, not just a well-formed one: no standard cron field begins
 * with `H` (values are digits, `*`, `,`, `-`, `/`, and the JAN-DEC/SUN-SAT names), so `"Hx"` is a
 * typo in this package's syntax rather than something the server was going to accept. Claiming it
 * here is what gets it reported as a malformed hashed field instead of an opaque cron parse error.
 */
export function isHashedCron(cron: string): boolean {
  return /(^|\s)H/.test(cron);
}

/**
 * The five fields of `cron` when every `H` in it is well-formed, else `undefined`.
 *
 * Only the `H` fields are checked. The rest are the server's to validate, as they already are —
 * this package does not own cron syntax, only the extension it adds to it.
 */
export function parseHashedCron(cron: string): string[] | undefined {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== CRON_FIELD_RANGES.length) return undefined;
  for (const [i, field] of fields.entries()) {
    if (!field.startsWith("H")) continue;
    const m = HASHED_FIELD.exec(field);
    if (!m) return undefined;
    if (m[1] === undefined) continue;
    const [lo, hi] = [Number(m[1]), Number(m[2])];
    const [min, max] = CRON_FIELD_RANGES[i];
    if (lo > hi || lo < min || hi > max) return undefined;
  }
  return fields;
}

