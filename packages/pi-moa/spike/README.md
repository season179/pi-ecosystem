# pi-moa Agentic Reference Spike

This directory is intentionally outside `packages/pi-moa/tsconfig.json` (`include` is `src/**/*.ts`), so it does not affect package build output.

Run the no-network faux-provider variant:

```bash
node packages/pi-moa/spike/agentic-reference-spike.ts --faux
```

Run the OpenRouter variant:

```bash
OPENROUTER_API_KEY=... node packages/pi-moa/spike/agentic-reference-spike.ts --openrouter
```

With no flags, the script runs the faux variant first and then runs the OpenRouter variant only when `OPENROUTER_API_KEY` is present.
