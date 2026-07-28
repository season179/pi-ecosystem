# Fix batch 3 — runtime orchestrator promotion. Owner: builder

Season's real workflow: start a plain pi in a herdr pane and ASK it to
be the orchestrator, mid-conversation. A launch-time env var can't
express that, so replace the static guard with runtime promotion using
pi's dynamic-tool API. Touch ONLY `src/extensions/herdr.ts`.

API facts (verified in node_modules/@earendil-works/pi-coding-agent):
- `pi.registerTool()` works during load AND after startup; new tools
  are usable immediately (docs/extensions.md ~line 1332).
- `pi.setActiveTools(names)` / `pi.getActiveTools()` toggle active
  tools at runtime (~line 1615). During a tool's execute, changes must
  be ADDITIVE; outside execution (session_start, command handlers) any
  set is fine (~line 2254 "Dynamic Tool Loading").
- Tools registered via registerTool are active by default; there is no
  initial-inactive flag — deactivate by subtracting in session_start.
- `promptGuidelines` bullets only appear while the tool is active.

## Changes

1. **Factory guard**: back to `HERDR_ENV === "1"` && `HERDR_PANE_ID`
   only (delete the PI_HERDR_ORCHESTRATOR check from the guard).
2. **State**: `let promoted = process.env.PI_HERDR_ORCHESTRATOR === "1"`
   (env var becomes an auto-promote signal, sticky for the process).
3. **New always-active tool `herdr_orchestrate`** (register it FIRST,
   no params — `Type.Object({})`):
   - description: "Enable herdr orchestrator mode: activates the
     herdr_watch/herdr_unwatch/herdr_watches tools for supervising
     other herdr agents. Call this ONLY when the user explicitly asks
     you to act as the orchestrator (e.g. 'you are the orchestrator',
     'dispatch this to workers'). Do not call it on your own
     initiative."
   - no promptGuidelines (keep the dormant footprint minimal).
   - execute: if already promoted → return "orchestrator mode already
     enabled". Else set promoted = true, ADDITIVELY activate the three
     watch tools (`pi.setActiveTools([...new Set([...pi.getActiveTools(),
     ...WATCH_TOOL_NAMES])])`), update footer, return "orchestrator
     mode enabled — herdr_watch, herdr_unwatch and herdr_watches are
     now available. Prompt workers WITHOUT --wait, then herdr_watch
     them; never block in bash."
4. **session_start**: after the existing manager rebuild, reconcile
   tool activity with `promoted`: when false, set active =
   current active minus WATCH_TOOL_NAMES (never touch other tools —
   always derive from getActiveTools, never build absolute lists);
   when true, additively ensure they're present.
5. **`/orchestrate` command** (registerCommand): no/any-arg → promote
   (same path as the tool) + ctx.ui.notify; arg "off" → demote:
   `await manager.stop("all")`, promoted = false, subtract
   WATCH_TOOL_NAMES from active tools, clear footer, notify. (Command
   handlers run between turns — non-additive changes are fine there.)
6. The three watch tools stay registered at factory exactly as now —
   only their ACTIVE state is managed. Their execute guards
   (`manager === undefined`) stay unchanged. Keep the wake path,
   policy, and everything else as is.

## Done

`npm run build -w @season179/pi-herdr` + `npx vitest run
packages/pi-herdr` green. Report under 12 lines: what changed +
anything you had to reconcile against the real API types.
