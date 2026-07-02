# Agentic References Design Spike

Status: implemented on branch `feat/moa-smart` in commit `461fe2f`; [README.md](./README.md) is now the user-facing documentation.

This note covers the future `moa/smart` preset: reference models may run read-only tools in a bounded private loop before returning their final advice to the aggregator. The current package behavior must stay byte-identical when the new knobs are unset.

## Recommendation

Use a small in-package loop around `@earendil-works/pi-ai` `streamSimple()` and `Context.tools`, and reuse `pi-coding-agent` read-only tool factories through a thin adapter.

That is the smallest coherent fit with `orchestrator.ts`: the reference path already resolves auth, builds `SimpleStreamOptions`, consumes pi-ai assistant event streams, applies reference-specific routing/reasoning/cache options, records reference telemetry, aborts streams for quorum/timeouts, and returns a `ReferenceOutput` for the existing guidance builders.

## (a) Loop Mechanism Choice

### Option 1: `@earendil-works/pi-agent-core` `agentLoop` / `runAgentLoop`

Pros:

- It already knows how to continue while an assistant stops with `toolUse`.
- It validates tool arguments, executes tools, emits tool execution events, and appends pi-ai `toolResult` messages.
- It has built-in `AbortSignal` plumbing and a tested event model.

Costs in this package:

- `@earendil-works/pi-agent-core` is installed at `0.74.0`, but `pi-moa` does not list it as a peer. `pi-moa` currently peers only `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` in [package.json](./package.json). Adding a direct peer is part of the integration cost.
- `agentLoop` works in `AgentMessage` space and emits `AgentEvent`s, not pi-ai assistant events. Its public shape is in `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.d.ts:5-23` and `node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:95-219`.
- The low-level loop streams assistant responses internally and appends the assistant/tool-result messages to its own context in `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:151-229` and `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:230-457`. `pi-moa` would still need an adapter to recover per-round assistant messages, final advice text, usage, tool-call counts, and stop causes.
- `orchestrator.ts` already has reference-specific lifecycle behavior that `agentLoop` does not know about: quorum resolution, reference output char budgets, `referenceMaxTokens`, reference-only cache retention, provider routing, and metadata-only telemetry.

### Option 2: Minimal `streamSimple()` Loop In Package

Pros:

- It uses the same event stream primitive the orchestrator already consumes: `streamSimple()` and `createAssistantMessageEventStream` are imported at `orchestrator.ts:1-13`, the outer stream is created at `orchestrator.ts:149-157`, and reference streams are consumed directly at `orchestrator.ts:1087-1135`.
- It keeps `buildSubRequestOptions()` as the single place that strips caller hooks and injects sub-request auth/signal, preserving the current no-leak rule at `orchestrator.ts:1312-1334`.
- It lets agentic references reuse the current reference option layering exactly: reasoning at `orchestrator.ts:898-911`, per-round max tokens at `orchestrator.ts:927-935`, max retries at `orchestrator.ts:936-958`, cache retention at `orchestrator.ts:959-982`, and provider routing at `orchestrator.ts:983-997`.
- It is easy to unit test with the existing faux provider style. The current suite already imports `registerFauxProvider` and `fauxToolCall` at `test/moa.test.ts:5-19`, builds faux registries at `test/moa.test.ts:96-125`, and drives `streamMoA()` directly at `test/moa.test.ts:180-186`.

Recommended shape:

1. Keep the existing non-agentic path untouched when `preset.referenceTools` is unset.
2. When `referenceTools` is set, replace the single `streamReferenceUntilBudget()` call in `runSingleReference()` with a `runAgenticReference()` helper.
3. The helper owns a private reference `Context` whose messages grow append-only: reference context, assistant tool-use message, tool-result messages, next assistant round, and so on.
4. Each model round calls `streamSimple(referenceStreamModel, roundContext, referenceOptions)`.
5. While the assistant stops with `toolUse` and tool rounds remain, execute allowed read-only tools, append pi-ai `toolResult` messages, and continue.
6. If the round cap is reached after a tool-use round, append those tool results and force exactly one final request with `tools` withheld.
7. Return only the final advice text as `ReferenceOutput.text`.

## (b) Tool Reuse

Standalone reuse is practical, with an adapter.

### Import Paths

The files exist under `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/{read,grep,find,ls}.js`, but the package has an `exports` map that exposes only `"."` and `"./hooks"` in `node_modules/@earendil-works/pi-coding-agent/package.json`. Do not import deep package paths like:

```ts
import { createReadTool } from "@earendil-works/pi-coding-agent/dist/core/tools/read.js";
```

Use the package root exports instead:

```ts
import {
	createReadOnlyTools,
	createReadTool,
	createGrepTool,
	createFindTool,
	createLsTool,
	createReadToolDefinition,
	createGrepToolDefinition,
	createFindToolDefinition,
	createLsToolDefinition,
} from "@earendil-works/pi-coding-agent";
```

Evidence:

- The internal tool index exports factories at `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.d.ts:1-9`.
- Root exports include the concrete tool factories through the SDK at `node_modules/@earendil-works/pi-coding-agent/dist/index.js:16-20`.
- Root exports include individual tool definitions at `node_modules/@earendil-works/pi-coding-agent/dist/index.js:26-27`.

### Construction And CWD Wiring

Use:

```ts
const tools = createReadOnlyTools(cwd);
```

or, for a config allowlist:

```ts
const toolFactories = {
	read: createReadTool,
	grep: createGrepTool,
	find: createFindTool,
	ls: createLsTool,
};
const tools = preset.referenceTools.map((name) => toolFactories[name](cwd));
```

`cwd` is the base for relative paths. The path helpers expand `~`, accept absolute paths, and otherwise resolve against `cwd` in `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js:33-53`. Coordinator decision for v1: there is no cwd jail; references get the same read scope as the main agent's read-only tools, so read-only access is the security boundary.

### Execute Signature

The root factories return `AgentTool`s. The execute contract is:

```ts
execute(toolCallId, params, signal?, onUpdate?) => Promise<AgentToolResult>
```

That signature is defined at `node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:280-304`. A `ToolDefinition` has the same core signature plus an optional extension context, and `wrapToolDefinition()` adapts it at `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/tool-definition-wrapper.js:1-11`.

Adapter outline:

```ts
import { validateToolArguments } from "@earendil-works/pi-ai";

const tool = tools.find((candidate) => candidate.name === toolCall.name);
const preparedCall = tool.prepareArguments
	? { ...toolCall, arguments: tool.prepareArguments(toolCall.arguments) }
	: toolCall;
const params = validateToolArguments(tool, preparedCall);
const result = await tool.execute(toolCall.id, params, signal);
```

### Truncation Behavior

The shared truncation defaults are `2000` lines and `50KB` in `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/truncate.js:1-12`.

- `read` truncates text files to 2000 lines or 50KB and emits continuation notices at `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js:225-257`.
- `grep` defaults to 100 matches, 50KB total output, and 500 characters per matching line at `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/grep.js:72-80` and `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/grep.js:256-280`.
- `find` defaults to 1000 results and 50KB total output at `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/find.js:69-77` and `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/find.js:249-269`.
- `ls` defaults to 500 entries and 50KB total output at `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/ls.js:56-64` and `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/ls.js:124-145`.

`grep` and `find` use local `rg` / `fd` paths and may try `ensureTool()` if absent; see `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/grep.js:93-99` and `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/find.js:157-166`. That is acceptable for the Pi runtime, but tests should prefer faux tool calls or inject minimal deterministic operations where possible.

### Mapping To pi-ai Tool Results

`pi-ai` tool results are `ToolResultMessage`s with `role`, `toolCallId`, `toolName`, `content`, optional `details`, `isError`, and `timestamp` at `node_modules/@earendil-works/pi-ai/dist/types.d.ts:158-166`.

For a successful tool:

```ts
{
	role: "toolResult",
	toolCallId: toolCall.id,
	toolName: toolCall.name,
	content: result.content,
	details: result.details,
	isError: false,
	timestamp: Date.now(),
}
```

For an execution or validation error, produce the same shape with `content: [{ type: "text", text: errorMessage }]` and `isError: true`. This matches `pi-agent-core`'s own creation path at `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:428-453`.

## (c) Collision Analysis

### 1. `maxReferenceOutputChars` Must Budget Final Advice Only

Current behavior counts every `text_delta` in a single reference stream and aborts when `keptTextChars >= keptOutputChars` at `orchestrator.ts:1077-1133`. In agentic mode, early model rounds may include tool-call preambles or commentary. That text must not consume the advice budget.

Change: apply the existing budget only to the final advice-producing stream. A tool-use round should be consumed to its final assistant message without char-budget abort, then rejected or continued based on `toolUse`. The final forced no-tools request can reuse a renamed `streamFinalReferenceAdviceUntilBudget()` helper.

### 2. `referenceMaxTokens` Becomes Per-Round

Current code lowers `referenceOptions.maxTokens` once before the single reference call at `orchestrator.ts:927-935`. In agentic mode, reuse the same cap on every model round. Do not reinterpret it as a loop-total budget. The loop-total bound is the round cap plus `referenceTimeoutMs`.

### 3. `referenceTimeoutMs` Must Span The Whole Loop

Current timeout is local to `streamReferenceUntilBudget()` and races one provider stream at `orchestrator.ts:1142-1169`; it is passed from `runSingleReference()` at `orchestrator.ts:998-1004`. In agentic mode, start one deadline before round 1 and link every model stream and every tool execution to that same controller.

On timeout:

- Abort the active model stream or tool execution.
- Return final advice only if final advice text has already started.
- Otherwise fail the reference gracefully, matching today's no-output timeout behavior.

### 4. `referenceQuorum` Must Abort An In-Flight Loop Cleanly

The reference phase already creates a phase-level controller and passes its signal through `phaseOptions` at `orchestrator.ts:782-793`. When quorum is reached, it aborts that controller and resolves early at `orchestrator.ts:827-840`.

Change: the agentic loop must use `args.options.signal` as its parent signal for every child round and tool execution. A loop superseded by quorum should stop without writing a failed `ReferenceOutput`; `runReferenceTasks()` already leaves slots empty for superseded workers at `orchestrator.ts:818-824`.

### 5. `streamReferences` Reveal

The current progressive stream starts the header immediately when `streamReferences` is enabled and quorum is unset at `orchestrator.ts:348-360`. It reveals each settled reference in slot order and keeps the accumulated text byte-identical to the atomic block at `orchestrator.ts:1439-1507`.

V1 agentic behavior should keep the same contract:

- Header emits immediately.
- No tool-call commentary is revealed.
- The advice section is revealed only when the agentic reference settles with final advice.
- `ReferenceOutput.text` remains exactly the final advice text used by `buildReferenceThinkingText()`, so accumulated progressive text remains byte-identical to the final thinking block.

### 6. Telemetry Gains Round And Tool Metadata, Never Text

Current telemetry records per-reference lifecycle timings, stop cause, kept chars, and usage at `telemetry.ts:34-44`, `telemetry.ts:56-61`, and `telemetry.ts:115-137`. Emission writes metadata only at `telemetry.ts:232-247`.

Add reference fields such as:

```ts
rounds?: number;
toolCalls?: Array<{
	round: number;
	name: "read" | "grep" | "find" | "ls";
	isError: boolean;
}>;
roundUsage?: Array<{
	round: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
}>;
```

Do not record prompt text, assistant text, tool arguments, paths, grep patterns, or tool output. Tool names and counts are enough to answer latency/cost questions without leaking code or user content.

### 7. `referenceCacheRetention` Across Loop Rounds

Current code applies reference cache retention to a reference request after caller options are layered at `orchestrator.ts:959-982`. In agentic mode, each round re-prefills the reference's own growing context, so the same retention hint should be applied to every round.

The private reference context is append-only within the loop: original reference context, tool-use assistant message, tool results, next round. That gives providers a stable prefix to cache between rounds. This may make `referenceCacheRetention: "long"` more valuable for long tool runs, but it also means more reference cache writes during a single MoA turn. When unset, no new cache hint is sent, preserving current behavior.

## (d) Proposed Config Surface

Add to `MoAPreset`:

```ts
referenceTools?: Array<"read" | "grep" | "find" | "ls">;
referenceToolRounds?: number;
```

Validation changes:

- `referenceTools` is optional.
- When present, it must be a non-empty array.
- Each entry must be exactly one of `"read"`, `"grep"`, `"find"`, or `"ls"`.
- Prefer rejecting duplicates, because duplicate tool schemas do not add capability and make telemetry ambiguous.
- `referenceToolRounds` is optional only when `referenceTools` is present.
- When `referenceTools` is present and `referenceToolRounds` is unset, default to `3`.
- When `referenceToolRounds` is present without `referenceTools`, throw a validation error.
- `referenceToolRounds` must be an integer `>= 1`.

The current validation home is `validatePreset()` in `config.ts:130-234`, with helper patterns for minimum integers at `config.ts:155-167` and `config.ts:259-270`. The type home is `types.ts:16-43`.

Loop semantics:

1. If `referenceTools` is unset, run today's `runSingleReference()` path unchanged.
2. If set, expose only the configured read-only tools to the reference context.
3. While the model stops with `toolUse` and tool rounds remain, execute tools and continue.
4. If the configured tool-round cap is reached after a tool-use round, append those tool results, then force exactly one final request with tools withheld.
5. If the model stops without `toolUse`, treat that message as final advice and apply `maxReferenceOutputChars`.
6. If the forced final no-tools request still fails to produce text, fail the reference gracefully unless `failOnReferenceError` escalates it.

Byte-identical default guarantee:

- Do not add fields to default presets.
- Do not attach `Context.tools` unless `referenceTools` is set.
- Keep the current `args.refContext.tools !== undefined` invariant at `orchestrator.ts:879-882` for the non-agentic path.
- Keep the current tool-attempt rejection at `orchestrator.ts:1011-1017` for the non-agentic path.
- Keep telemetry disabled unless `telemetryPath` is set, matching `telemetry.ts:257-266`.

## Spike

The spike lives under [spike/](./spike/), outside `tsconfig.json`'s `include` (`src/**/*.ts` only), so package build output is unaffected.

Run the no-network faux preview:

```bash
node packages/pi-moa/spike/agentic-reference-spike.ts --faux
```

Run the OpenRouter preview:

```bash
OPENROUTER_API_KEY=... node packages/pi-moa/spike/agentic-reference-spike.ts --openrouter
```

With no arguments, the script runs the faux preview and then runs or skips the OpenRouter preview depending on `OPENROUTER_API_KEY`.
