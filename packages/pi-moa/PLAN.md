# pi-moa: Mixture of Agents (MoA) Implementation Plan for Pi

Date: 2026-06-30
Status: Plan complete, ready for Tier 1 implementation
Confidence: High — key pi seams were verified by source inspection and a live throwaway spike.

This plan records how to add Mixture of Agents support to `packages/coding-agent` without losing the details discovered during planning.

## 1. Goal

Implement MoA as a pi provider extension.

The user should be able to select a synthetic model like:

```bash
./pi-test.sh -e packages/pi-moa --model moa/default -p "Say exactly: ok"
```

At runtime, the `moa` provider should:

1. Fan out privately to multiple reference models.
2. Collect concise advisory responses.
3. Insert those advisory responses as a new synthetic user message in the aggregator model's context.
4. Stream the aggregator as the acting model.
5. Preserve normal pi tool execution behavior.

## 2. Architecture Decision

Implement MoA as a provider extension, not as a tool, hook, or immediate core feature.

The extension registers a synthetic provider named `moa`. Each MoA preset becomes a synthetic model:

- `moa/default`
- `moa/fast`
- `moa/coding`

The provider's `streamSimple` function performs all MoA orchestration internally.

### Why provider extension

- `pi.registerProvider()` already supports custom providers.
- Custom provider `streamSimple` receives the full `Context`, including messages and tools.
- Extensions can access `ctx.modelRegistry` from event context.
- `modelRegistry.getApiKeyAndHeaders(model)` is the correct auth resolver.
- `custom-provider-gitlab-duo` is precedent for a synthetic provider delegating to lower-level model/provider APIs.

### Why not a tool

- Tools invert the design: references become something the acting model asks for, instead of private advisors to the acting model.
- Reference outputs would become part of the visible tool loop.
- It increases recursion and tool-access risk.

### Why not `before_provider_request`

Hooks can augment a payload, but they are not the right abstraction for:

- fanning out to multiple models;
- replacing/proxying the stream cleanly;
- stripping tools from references while preserving tools for the aggregator.

### Why not core first

Extension-first is lower risk and matches the existing architecture. Add a core helper only after the extension proves where the current extension API is insufficient.

## 3. Key Source References

| File | Relevance |
| --- | --- |
| `packages/coding-agent/src/core/model-registry.ts` | Provider registration, `getApiKeyAndHeaders`, `registerApiProvider` |
| `packages/coding-agent/src/core/extensions/types.ts` | `ExtensionAPI`, `ExtensionContext`, `modelRegistry` access |
| `packages/coding-agent/src/core/sdk.ts` | Normal provider call pattern and auth resolution |
| `packages/ai/src/compat.ts` | `completeSimple`, `streamSimple`, `registerApiProvider`, `registerFauxProvider` |
| `packages/ai/src/types.ts` | `Context`, `SimpleStreamOptions`, `AssistantMessageEventStream` |
| `packages/ai/src/providers/faux.ts` | Faux provider helpers for tests |
| `packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/index.ts` | Synthetic-provider precedent |
| `packages/coding-agent/examples/extensions/summarize.ts` | Extension-side `ctx.modelRegistry.getApiKeyAndHeaders` precedent |
| `packages/coding-agent/docs/custom-provider.md` | Official custom provider docs |
| `packages/coding-agent/docs/extensions.md` | Extension system docs |

## 4. File Plan

Create this directory:

```text
packages/pi-moa/
```

Files:

```text
moa/
├── package.json          # Extension entrypoint metadata
├── index.ts              # registerProvider, turn_start capture, delegation
├── types.ts              # ModelSlot, MoAPreset, MoAConfig, ReferenceOutput
├── config.ts             # Load, validate, and resolve preset configuration
├── messages.ts           # Build reference context, inject guidance
├── orchestrator.ts       # Model resolution, auth, fan-out, stream proxy
├── test.ts               # Unit + integration-style tests
└── PLAN.md               # This plan
```

## 5. Config Shape

Use dedicated config first. Prefer project-local config:

```text
.pi/moa.json
```

Example:

```json
{
  "defaultPreset": "default",
  "presets": {
    "default": {
      "enabled": true,
      "referenceModels": [
        { "provider": "openrouter", "model": "anthropic/claude-haiku-latest" },
        { "provider": "openrouter", "model": "google/gemini-3-flash-preview" },
        { "provider": "zai", "model": "glm-5.2" }
      ],
      "aggregator": {
        "provider": "openrouter",
        "model": "anthropic/claude-sonnet-latest"
      },
      "referenceConcurrency": 4,
      "maxReferences": 8,
      "maxReferenceOutputChars": 2000,
      "referenceTemperature": 0.6,
      "aggregatorTemperature": 0.4,
      "failOnReferenceError": false
    }
  }
}
```

Config rules:

- `defaultPreset` must exist in `presets`.
- each preset must have at least one reference model.
- each preset must have one aggregator model.
- no slot may use `provider: "moa"`.
- `referenceModels.length <= maxReferences`.
- default `maxReferences` to `8`.
- default `referenceConcurrency` to `4`.
- default `maxReferenceOutputChars` to `2000`.
- default `failOnReferenceError` to `false`.
- Tier 1 uses project config only; do not deep-merge user/global config.

## 6. Shared Types

`types.ts` should define the public internal types used across the extension.

```ts
import type { Context, Model, Usage } from "@earendil-works/pi-ai/compat";

export interface ModelSlot {
	provider: string;
	model: string;
}

export interface MoAPreset {
	enabled: boolean;
	referenceModels: ModelSlot[];
	aggregator: ModelSlot;
	referenceConcurrency?: number;
	maxReferences?: number;
	maxReferenceOutputChars?: number;
	referenceTemperature?: number;
	aggregatorTemperature?: number;
	failOnReferenceError?: boolean;
}

export interface MoAConfig {
	defaultPreset: string;
	presets: Record<string, MoAPreset>;
}

export interface ReferenceOutput {
	slot: ModelSlot;
	success: boolean;
	text: string;
	usage?: Usage;
	errorMessage?: string;
}

export interface ResolvedMoAPreset {
	name: string;
	preset: MoAPreset;
	referenceModels: Model<any>[];
	aggregatorModel: Model<any>;
}

export interface OrchestrationResult {
	referenceOutputs: ReferenceOutput[];
	guidanceBlock: string;
	aggregatorContext: Context;
}
```

Adjust imports to match the actual exported types when implementing. Do not use `any` unless the generic API type forces it and there is no narrower local type.

## 7. `index.ts` Plan

Responsibilities:

1. Load config.
2. Build synthetic model definitions from enabled presets.
3. Register provider `moa`.
4. Capture `ctx.modelRegistry` on `turn_start`.
5. Delegate `streamSimple` to `streamMoA`.

Sketch:

```ts
import { streamMoA } from "./orchestrator.ts";
import { loadMoAConfig } from "./config.ts";

export default function setup(pi: ExtensionAPI): void {
	let registry: ModelRegistry | undefined;
	const config = loadMoAConfig(pi.cwd);

	pi.on("turn_start", (_event, ctx) => {
		registry = ctx.modelRegistry;
	});

	pi.registerProvider("moa", {
		name: "Mixture of Agents",
		baseUrl: "https://moa.invalid",
		apiKey: "moa-synthetic",
		api: "moa-api",
		models: buildSyntheticModels(config),
		streamSimple: (model, context, options) => {
			if (!registry) {
				throw new Error("MoA model registry is not available yet");
			}
			return streamMoA(model, context, options, registry, config);
		},
	});
}
```

Synthetic model metadata:

Use conservative static fallback values at registration time. Do not make `moa` provider registration depend on provider load order or runtime model discovery. Resolve the real aggregator model metadata at call time with `registry.find()`.

- `id`: preset name, e.g. `default`.
- `name`: `MoA Default`.
- `reasoning`: `false` for the synthetic wrapper; the real aggregator may support reasoning and is resolved at call time.
- `input`: `["text"]` for Tier 1.
- `contextWindow`: `200000` static fallback.
- `maxTokens`: `8192` static fallback.
- `cost`: all zeros on the synthetic wrapper; real cost belongs to underlying calls.

## 8. `config.ts` Plan

Exports:

```ts
export function loadMoAConfig(cwd: string): MoAConfig;
export function validateMoAConfig(config: MoAConfig): void;
export function getPreset(config: MoAConfig, name: string): MoAPreset;
```

Load behavior:

Tier 1 uses project config only:

1. `${cwd}/.pi/moa.json`
2. built-in default config if no project file exists

Do not deep-merge user/global config in Tier 1. Tier 2 may add user/global config and explicit merge semantics after the provider extension is proven.

Validation rules:

- config is an object.
- `defaultPreset` is a non-empty string.
- `presets` is a non-empty object.
- `presets[defaultPreset]` exists.
- each preset has `referenceModels` array.
- each preset has at least one reference model.
- each preset has `aggregator`.
- every `ModelSlot` has non-empty `provider` and `model`.
- no slot has `provider === "moa"`.
- `referenceModels.length <= (preset.maxReferences ?? 8)`.
- `maxReferenceOutputChars >= 200` if provided.
- `referenceConcurrency >= 1` if provided.
- `referenceConcurrency <= maxReferences` if provided.
- disabled presets may be loaded but should not produce synthetic models.

Use clear validation errors that name the preset and field.

## 9. `messages.ts` Plan

Exports:

```ts
export function buildReferenceContext(context: Context, preset: MoAPreset): Context;
export function stripPriorMoAGuidanceMessages(context: Context): Context;
export function injectGuidance(context: Context, guidanceBlock: string): Context;
export function buildGuidanceBlock(args: {
	presetName: string;
	preset: MoAPreset;
	referenceOutputs: ReferenceOutput[];
}): string;
export function renderToolResult(content: unknown, maxChars: number): string;
export function extractAssistantText(message: AssistantMessage): string;
```

### 9.1 Build reference context

Reference models are private advisors. They should not receive tools.

`buildReferenceContext` should:

- remove `tools` from context;
- preserve relevant conversation history;
- render assistant tool calls as plain text;
- render tool results as plain text;
- truncate large tool results;
- replace the original system prompt entirely with a reference-advisor system prompt.

References are advisors, not acting agents. Do not pass the original system prompt through as system instructions or quote it as authoritative instructions. If domain orientation is needed, describe the transcript neutrally in the reference prompt.

Reference prompt template:

```text
You are a private reference model in a Mixture of Agents pipeline.

Below is a conversation between a user and an AI assistant. Your job is to advise the aggregator model about that conversation, not to act as the assistant.

Your role:
- Analyze the conversation below.
- Provide concise, actionable advice for the aggregator model.
- Point out what the aggregator might miss.
- Suggest alternative approaches.
- Identify risks and edge cases.
- Offer concrete improvements.

Rules:
- Do NOT produce a final user-facing answer. The aggregator will do that.
- Do NOT call tools. You have none.
- Do NOT assume you are the acting model.
- Be concise; the aggregator will read multiple reference outputs.
- Format your response as a clear advisory note.
```

### 9.2 Render message history for references

Rules:

- User text: preserve as text.
- Assistant text: preserve as text.
- Assistant thinking: omit or summarize as `[assistant thinking omitted]`; do not leak hidden/private chain-of-thought style content if present.
- Assistant tool calls: render as `[Tool call: name({args})]`.
- Tool result messages: render as `[Tool result: name -> rendered/truncated content]`.
- Image blocks: render as `[image:<mimeType>:<size>]` unless image passthrough is intentionally supported later.

Tool result truncation:

- head: 2000 characters;
- tail: 500 characters;
- marker: `...[truncated {totalChars} chars]...`.

### 9.3 Strip stale guidance and inject new guidance

`stripPriorMoAGuidanceMessages` should run before both reference-context construction and new guidance injection. It should remove prior synthetic MoA guidance messages so old reference context does not accumulate across multi-turn conversations.

Rules:

- only remove messages with `role: "user"` whose text content starts with `[Mixture of Agents reference context]`;
- do not remove real user messages that merely mention MoA later in the text;
- keep this marker stable and covered by tests;
- run this at the top of `streamMoA` before building reference context.

`injectGuidance` should:

- clone context/messages rather than mutating input in place;
- find the latest user message;
- insert a new synthetic user message immediately after the latest user message;
- never append guidance to the original user message;
- preserve the original user turn untouched, including multimodal or mixed-content payloads;
- preserve the original system prompt for the aggregator;
- preserve original tools for the aggregator;
- preserve older messages exactly where practical.

The synthetic message shape should be:

```ts
{
	role: "user",
	content: guidanceBlock,
	timestamp: Date.now(),
}
```

Guidance wrapper:

```text
[Mixture of Agents reference context]
Preset: {presetName}
Aggregator/acting model: {aggregator.provider}/{aggregator.model}
References: {n} models provided private analysis below.

Use the reference responses below as private context. You are the aggregator and acting model: answer the user directly or call tools as needed.

--- Reference 1 ({provider}/{model}) ---
{text capped to maxReferenceOutputChars}

--- Reference 2 ({provider}/{model}) FAILED ---
Error: {redacted error capped to 200 chars}

[End reference context]
```

If no user message exists, append the synthetic guidance message as the only user message with a short instruction for the aggregator.

Consecutive user messages are an explicit Tier 1 design choice, but must be validated before the full orchestrator is built. If pi-ai compat or a provider rejects consecutive `role: "user"` messages, fallback to appending a text block to the latest user message in the aggregator call only, while still never mutating the original stored context.

### 9.4 Reference output truncation

Reference output truncation is separate from tool-result truncation.

- Tool-result truncation happens while building reference context before sending data to references.
- Reference-output truncation happens while building the guidance block before sending data to the aggregator.

Tier 1 defaults:

- successful reference output cap: `preset.maxReferenceOutputChars ?? 2000` characters;
- failed reference error cap: `200` characters;
- truncation marker: `...[truncated, {totalChars} chars total]...`.

Apply the cap in `buildGuidanceBlock`, not in `buildReferenceContext`, so raw reference messages can still carry full text/usage internally if needed.

## 10. `orchestrator.ts` Plan

Exports:

```ts
export function streamMoA(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	registry: ModelRegistry,
	config: MoAConfig,
): AssistantMessageEventStream;

export async function runReferences(args: {
	presetName: string;
	preset: MoAPreset;
	referenceModels: Model<any>[];
	refContext: Context;
	options: SimpleStreamOptions | undefined;
	registry: ModelRegistry;
}): Promise<ReferenceOutput[]>;
```

### 10.1 `streamMoA` flow

0. Strip prior synthetic MoA guidance messages from `context.messages` using the stable `[Mixture of Agents reference context]` marker.
1. Create an outer stream with `createAssistantMessageEventStream()`.
2. Start an async task to do the work.
3. Resolve preset from `model.id`.
4. Validate preset and recursion guards.
5. Resolve reference models with `registry.find(provider, model)`.
6. Resolve aggregator model with `registry.find(provider, model)`.
7. Build reference context from the stripped context.
8. Run references with `runReferences`.
9. Build guidance block with per-reference truncation.
10. Insert guidance into aggregator context as a new synthetic user message immediately after the latest original user message.
11. Resolve aggregator auth with `registry.getApiKeyAndHeaders(aggregatorModel)`.
12. Stream aggregator through `streamSimple(aggregatorModel, augmentedContext, authOptions)`.
13. Proxy aggregator events verbatim to the outer stream.
14. End outer stream.
15. On fatal error, push an error event and end with an error assistant message.

### 10.2 Model resolution

Rules:

- `registry.find(slot.provider, slot.model)` must return a model.
- if missing reference model and `failOnReferenceError` is false, treat that reference as failed output;
- if missing aggregator model, fatal;
- reject `slot.provider === "moa"` before lookup.

### 10.3 Auth resolution

For every underlying model:

```ts
const auth = await registry.getApiKeyAndHeaders(model);
```

Pass through:

- `apiKey`
- `headers`
- `env`

Reference auth failure:

- default: non-fatal `ReferenceOutput` failure;
- if `failOnReferenceError` is true: fatal.

Aggregator auth failure:

- always fatal.

Never log or persist keys.

### 10.4 Reference fan-out

Use `Promise.allSettled` with a concurrency limit.

Default concurrency: `4`.

Preserve output order to match config order.

Reference call:

```ts
const message = await completeSimple(refModel, refContext, {
	...options,
	apiKey: auth.apiKey,
	headers: auth.headers,
	env: auth.env,
	signal: options?.signal,
	temperature: preset.referenceTemperature,
});
```

Defensively ensure `refContext.tools` is undefined.

### 10.5 Aggregator stream proxy

Aggregator call:

```ts
const innerStream = streamSimple(aggregatorModel, augmentedContext, {
	...options,
	apiKey: aggAuth.apiKey,
	headers: aggAuth.headers,
	env: aggAuth.env,
	temperature: preset.aggregatorTemperature,
});

for await (const event of innerStream) {
	outerStream.push(event);
}
outerStream.end();
```

Proxy these events verbatim:

- `start`
- `text_start`
- `text_delta`
- `text_end`
- `thinking_start`
- `thinking_delta`
- `thinking_end`
- `toolcall_start`
- `toolcall_delta`
- `toolcall_end`
- `done`
- `error`

Aggregator `error` is fatal for the turn.

### 10.6 Abort behavior

- Pass `options?.signal` to every reference call.
- Pass `options?.signal` to the aggregator stream.
- If signal is already aborted before references start, return an aborted message.
- If aborted during references, stop scheduling new references and end aborted.
- If aborted during aggregation, proxy aggregator abort behavior.

### 10.7 Error redaction

Before embedding reference errors in guidance:

- remove credential-like substrings;
- remove bearer tokens;
- remove API key patterns;
- avoid dumping full provider response bodies if they may include request headers.

Use concise messages:

```text
Authentication required for provider "openrouter". Run /login openrouter.
```

## 11. Failure Matrix

| Scenario | Behavior |
| --- | --- |
| Reference auth fails | Non-fatal by default; note in guidance |
| Reference stream errors | Non-fatal by default; note in guidance |
| Reference timeout | Non-fatal by default; note in guidance |
| All references fail | Run aggregator alone; note failures |
| Aggregator auth fails | Fatal; clear error |
| Aggregator model missing | Fatal; clear error |
| Aggregator stream errors | Fatal; surface error |
| Abort during references | End aborted, do not call aggregator |
| Abort during aggregation | Proxy aggregator abort/error behavior |
| `failOnReferenceError: true` | Any reference failure is fatal |

## 12. Cost and Usage Accounting

Tier 1:

- Aggregator usage should be visible because its stream is the main stream.
- Reference usage may not be reflected in normal session accounting.
- Document this limitation. Do not block Tier 1 on perfect accounting.

Tier 2:

- collect reference `usage` objects;
- sum reference usage;
- surface a concise MoA usage/cost summary in status/TUI;
- consider adding extension event metadata for nested usage.

## 13. Streaming UX

Tier 1:

- Wait for references to complete.
- Then stream aggregator.

This increases time-to-first-token, but it is simple and matches the MoA quality-first design.

Optional Tier 1.5:

- emit a status notification: `MoA: querying 3 reference models...`;
- do not stream reference text to the user by default.

## 14. Tests

Create `packages/pi-moa/test.ts`.

Use faux/synthetic providers where practical.

### 14.1 Config tests

- valid config loads all presets;
- missing `defaultPreset` throws;
- unknown `defaultPreset` throws;
- recursive `moa` provider in references throws;
- recursive `moa` provider in aggregator throws;
- reference count exceeding `maxReferences` throws;
- missing aggregator throws;
- empty reference list throws;
- disabled presets do not produce synthetic models.

### 14.2 Message shaping tests

- `buildReferenceContext` preserves user text;
- `buildReferenceContext` strips tools;
- `buildReferenceContext` renders assistant tool calls as descriptive text;
- `buildReferenceContext` renders tool results with truncation;
- `buildReferenceContext` omits/sanitizes thinking blocks;
- `stripPriorMoAGuidanceMessages` removes stale synthetic guidance messages from previous MoA turns;
- `stripPriorMoAGuidanceMessages` does not remove normal user messages that mention MoA later in the text;
- `injectGuidance` inserts a synthetic user message immediately after the latest user message;
- `injectGuidance` never mutates the original user message;
- `injectGuidance` handles multimodal/mixed-content latest user messages without modifying them;
- `injectGuidance` does not mutate system prompt;
- `injectGuidance` does not mutate older user messages;
- `buildGuidanceBlock` includes all successful references;
- `buildGuidanceBlock` marks failed references clearly;
- `buildGuidanceBlock` redacts sensitive error content;
- `buildGuidanceBlock` caps successful reference output at `maxReferenceOutputChars`;
- `buildGuidanceBlock` caps failed-reference error notes at 200 chars.

### 14.3 Orchestration tests

- resolves all configured reference models;
- resolves aggregator model;
- resolves auth for every model;
- runs references concurrently with limit;
- reference context has no tools;
- aggregator context has original tools;
- all reference outputs appear in aggregator context;
- aggregator context uses consecutive user messages successfully, or the fallback path is tested if provider compatibility rejects it;
- stale guidance messages from prior turns are stripped before reference and aggregator contexts are built;
- one failed reference does not block aggregator by default;
- all references failed still runs aggregator by default;
- `failOnReferenceError` makes reference failures fatal;
- aggregator missing gives clear error;
- aggregator auth failure gives clear error;
- abort signal propagates to references;
- aggregator text events pass through unmodified;
- aggregator tool call events pass through unmodified;
- aggregator error event is fatal.

### 14.4 Manual smoke tests

First verification should use a cheap/fast local project `.pi/moa.json`. Run the real default preset once only after tests and cheap smoke pass.

Before implementing the full orchestrator, run a tiny validation/spike that sends two consecutive `role: "user"` messages through the aggregator provider path. If that fails, implement the documented fallback that appends a text block to the latest user message for the aggregator call only.

Example cheap smoke config:

```json
{
  "defaultPreset": "smoke",
  "presets": {
    "smoke": {
      "enabled": true,
      "referenceModels": [
        { "provider": "openrouter", "model": "anthropic/claude-haiku-latest" },
        { "provider": "openrouter", "model": "google/gemini-3-flash-preview" }
      ],
      "aggregator": {
        "provider": "openrouter",
        "model": "anthropic/claude-haiku-latest"
      },
      "referenceConcurrency": 2,
      "maxReferences": 2,
      "maxReferenceOutputChars": 1000,
      "failOnReferenceError": false
    }
  }
}
```

Basic text response:

```bash
./pi-test.sh -e packages/pi-moa \
  --model moa/smoke -p "Say exactly: ok"
```

Tool usage:

```bash
./pi-test.sh -e packages/pi-moa \
  --model moa/smoke -p "List files in the current directory, then summarize what you found"
```

Real preset smoke after tests pass:

```bash
./pi-test.sh -e packages/pi-moa \
  --model moa/default -p "Say exactly: ok"
```

Abort test:

```bash
./pi-test.sh -e packages/pi-moa --model moa/smoke
# Start a prompt, then abort during reference phase.
```

### 14.5 Verification after code changes

Per repo rules:

- run the specific test file created/modified;
- run `npm run check`;
- do not run full `npm test` unless explicitly requested;
- do not run `npm run build` unless explicitly requested.

## 15. Implementation Checklist

- [ ] Scaffold `packages/pi-moa/package.json`.
- [ ] Keep this `PLAN.md` in the extension directory.
- [ ] Implement `types.ts`.
- [ ] Implement `config.ts`.
- [ ] Add config validation and recursion guards.
- [ ] Implement `messages.ts` `stripPriorMoAGuidanceMessages`.
- [ ] Implement `messages.ts` `buildReferenceContext`.
- [ ] Implement `messages.ts` `injectGuidance`.
- [ ] Implement `messages.ts` `buildGuidanceBlock`.
- [ ] Implement `messages.ts` tool-result rendering/truncation.
- [ ] Implement `orchestrator.ts` model resolution via `registry.find`.
- [ ] Implement `orchestrator.ts` auth resolution via `registry.getApiKeyAndHeaders`.
- [ ] Implement reference concurrency helper.
- [ ] Implement `runReferences` with `Promise.allSettled` semantics.
- [ ] Implement reference failure handling.
- [ ] Implement error redaction.
- [ ] Validate consecutive user messages through the aggregator provider path.
- [ ] Implement aggregator context construction.
- [ ] Implement aggregator stream proxy.
- [ ] Implement abort propagation.
- [ ] Implement `index.ts` provider registration.
- [ ] Implement synthetic model generation from presets.
- [ ] Cache `ctx.modelRegistry` on `turn_start`.
- [ ] Add tests for config validation.
- [ ] Add tests for message shaping.
- [ ] Add tests for orchestration.
- [ ] Add tests for tool passthrough.
- [ ] Add tests for failure behavior.
- [ ] Run the specific MoA test file.
- [ ] Run `npm run check`.
- [ ] Run manual smoke test.
- [ ] Add README if the extension is meant to remain user-facing.

## 16. Tier Roadmap

### Tier 1 — Provider Extension

Implement now.

Scope:

- synthetic `moa` provider;
- presets as synthetic models;
- one-layer reference fan-out;
- one aggregator;
- references without tools;
- aggregator with tools;
- auth via `modelRegistry.getApiKeyAndHeaders`;
- model dispatch via `completeSimple` and `streamSimple`;
- wait-then-stream UX;
- robust validation and failure handling;
- tests.

### Tier 2 — Polish

Add later:

- `/moa list`;
- `/moa preset <name>`;
- `/moa off`;
- TUI status for reference progress;
- reference usage/cost reporting;
- per-preset model validation at load time;
- multiple preset examples;
- optional multi-layer MoA.

### Tier 3 — Core Helper

Only if Tier 1 proves it is needed.

Possible helper:

```ts
ctx.models.complete(model, context, options)
ctx.models.stream(model, context, options)
```

or:

```ts
ctx.modelRegistry.call(model, context, options)
```

The helper should:

- resolve auth;
- apply provider retry settings;
- preserve session/cache options;
- call the right pi-ai dispatch path;
- avoid extensions importing compat directly.

Do not start with this.

## 17. Known Remaining Uncertainty

One material uncertainty remains:

Cross-extension synthetic-provider composition may depend on compat API registry load order.

Tier 1 should officially support built-in/API-backed providers first and fail clearly if a referenced model's API is not registered.

Safe:

- MoA calling built-in/API-backed providers.

Not guaranteed in Tier 1:

- MoA calling another extension-defined synthetic provider.

## 18. Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Cross-extension provider composition fails | Tier 1 supports built-in/API-backed providers; fail clearly otherwise |
| Reference usage not tracked | Document limitation; add reporting in Tier 2 |
| Slow time-to-first-token | Accept for Tier 1; add status UX later |
| Reference models hallucinate bad advice | Use private advisor prompt; aggregator remains acting model |
| Large tool results bloat context | Truncate in `buildReferenceContext` |
| Auth leakage in errors | Redact before embedding; never log keys |
| Config drift from available models | Validate models on use; optionally validate at load later |
| Recursive MoA calls | Reject `provider: "moa"` everywhere in config |
| Stale MoA guidance accumulates across turns | Strip prior synthetic guidance messages at the start of every MoA turn |
| Consecutive user messages are rejected by a provider | Validate early; fallback to aggregator-only text-block append without mutating stored context |

## 19. Do Not

- Do not implement MoA as a tool.
- Do not use `before_provider_request` as the main mechanism.
- Do not store API keys in MoA config.
- Do not let reference models call tools.
- Do not stream reference outputs directly to the user by default.
- Do not mutate the aggregator system prompt.
- Do not pass the original system prompt to reference models.
- Do not append guidance to the original user message; insert a separate synthetic user message.
- Do not allow stale synthetic MoA guidance messages to accumulate in history.
- Do not append guidance to old history.
- Do not allow recursive `moa` references.
- Do not hide reference failures silently.
- Do not overbuild core changes before the extension proves itself.
- Do not run full `npm test` or `npm run build` unless explicitly requested.

## 20. Next Concrete Step

Start Tier 1 implementation in this directory:

```text
packages/pi-moa/
```

Build in this order:

1. `package.json`
2. `types.ts`
3. `config.ts`
4. `messages.ts`
5. `orchestrator.ts`
6. `index.ts`
7. `test.ts`
8. manual smoke
9. `npm run check`

## 21. Resolved Design Decisions

These decisions are pinned for Tier 1 implementation.

1. Guidance injection shape

   Use a new synthetic user message inserted immediately after the latest original user message. Do not append MoA guidance to the original user message.

   Rationale:
   - preserves the user's original turn untouched;
   - handles multimodal and mixed-content user messages cleanly;
   - keeps prompt-cache-stable content stable;
   - makes the guidance clearly distinguishable from the user's words.

2. Reference system prompt

   Replace the original system prompt entirely for reference models. References receive only the reference-advisor system prompt plus rendered conversation context.

   Rationale:
   - references are advisors, not acting agents;
   - original agent/tool instructions can confuse references;
   - references should not inherit instructions to use tools or behave as the main assistant.

3. Config merge behavior

   Tier 1 uses project config only: `${cwd}/.pi/moa.json`, with built-in defaults only when no project file exists. Do not deep-merge user/global config.

   Rationale:
   - predictable behavior;
   - no ambiguous array merge semantics for `referenceModels`;
   - avoids surprising cross-project behavior.

4. Reference output truncation

   Cap each successful reference response at `preset.maxReferenceOutputChars ?? 2000` characters before injecting it into the aggregator guidance block. Cap failed-reference error notes at 200 characters.

   Rationale:
   - bounds aggregator context growth;
   - keeps several references readable;
   - separates reference-output truncation from tool-result truncation.

5. Synthetic model metadata

   Use conservative static metadata for `moa/*` models during provider registration:

   - `reasoning`: `false`
   - `input`: `["text"]`
   - `contextWindow`: `200000`
   - `maxTokens`: `8192`
   - `cost`: zeros

   Resolve the real aggregator model and its capabilities at call time with `registry.find()`.

   Rationale:
   - provider registration should not depend on underlying provider load order;
   - model lists stay available even if a referenced provider is temporarily unavailable;
   - runtime resolution can produce clearer preset-specific errors.

6. Manual smoke sequence

   First smoke with a cheap/fast local `.pi/moa.json` config. After tests and cheap smoke pass, run the real preset once.

   Rationale:
   - faster iteration;
   - lower cost;
   - avoids debugging implementation bugs against slow or expensive models.

7. Stale guidance messages

   Strip prior synthetic MoA guidance messages at the start of every MoA turn before building either the reference context or aggregator context.

   Rationale:
   - prevents old reference advice from accumulating;
   - avoids stale private context influencing later turns;
   - avoids phantom user messages building up in the transcript.

8. Consecutive user messages

   Tier 1 intentionally inserts the guidance as a synthetic user message, which creates consecutive user messages. Validate this provider path before building the full orchestrator. If it is rejected, fallback to appending guidance as a text block to the latest user message in the aggregator call only, without mutating the original stored context.

   Rationale:
   - the synthetic-message shape is cleaner and preserves the original turn;
   - provider compatibility should be proven rather than assumed;
   - the fallback preserves the core behavior if a provider rejects consecutive user roles.
