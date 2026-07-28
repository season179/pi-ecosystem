# Brief: scaffold worker

Read `briefs/COMMON.md` first. You own EXACTLY these files under
`packages/pi-herdr/`:

- `package.json`
- `tsconfig.json`
- `README.md`
- `src/types.ts`
- `src/config.ts`
- `src/telemetry.ts`
- `test/config.test.ts`
- `test/telemetry.test.ts`

## package.json

Mirror `packages/pi-skills-status/package.json` field-for-field, adapted:

- name `@season179/pi-herdr`, version `26.7.0`
- description: "Non-blocking herdr watches so a pi orchestrator inside herdr is woken when workers settle."
- keywords: pi, pi-package, pi-extension, herdr, orchestrator, watch
- `"pi": { "extensions": ["./dist/extensions/herdr.js"] }`
- scripts: clean/build/prepack/prepublishOnly like the sibling, plus
  `"test": "vitest run"`
- Copy the `peerDependencies`/`peerDependenciesMeta` block style from
  `packages/pi-buddy/package.json` (optional peers on
  @earendil-works/pi-ai, pi-coding-agent, pi-tui).

## tsconfig.json

Same as `packages/pi-skills-status/tsconfig.json` (extends base,
rootDir src, outDir dist, include src/**/*.ts).

## src/types.ts

Exactly the contract block from COMMON.md §"src/types.ts" — verbatim,
plus brief doc comments. Nothing more.

## src/config.ts

Per contract. Details:

- `DEFAULT_CONFIG`: maxWatches 8, wakeBudget 20, includeTailLines 20,
  toastOn ["blocked"], telemetryPath "~/.pi/agent/herdr-telemetry.jsonl".
- Read `<agentDir>/herdr.json`. Missing file → deep copy of defaults.
- Invalid JSON → ConfigError naming the file.
- Unknown top-level key → ConfigError naming the key.
- Type checks: maxWatches/wakeBudget/includeTailLines must be
  non-negative integers; toastOn an array of strings; telemetryPath a
  string. Violations → ConfigError naming key and expected type.
- Expand leading `~/` in telemetryPath using `os.homedir()`.

## src/telemetry.ts

Per contract. Append `JSON.stringify(record) + "\n"`. Create parent
directory recursively. Wrap everything in try/catch — this function must
never throw or reject; on failure do nothing.

## Tests (vitest, hermetic — use `fs.mkdtempSync(os.tmpdir())` dirs)

test/config.test.ts:
- missing file → defaults (and result is not the same object reference
  as DEFAULT_CONFIG)
- valid partial file (e.g. `{"wakeBudget": 5}`) → merged with defaults
- unknown key → ConfigError, message contains the key name
- wrong type (`{"maxWatches": "8"}`) → ConfigError
- invalid JSON → ConfigError
- `~/` expansion in telemetryPath

test/telemetry.test.ts:
- appends two records → file has two parseable JSON lines
- creates missing parent directories
- path "" → writes nothing, does not throw
- unwritable path (e.g. path whose parent is a file) → does not throw

## Done

Build must pass with ONLY your files present — other workers' files may
not exist yet; that's expected (tsconfig includes src/**, so just ensure
YOUR files compile; if the full build fails on missing teammate files,
run `npx tsc --noEmit` scoped to your files and say so).
Run your two test files. Report per COMMON.md.
