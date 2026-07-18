# Organize Buddy around domain capabilities

Buddy will use capability-first Modules for Consultation, Automatic Review,
session lifecycle, and memory, with Pi and external systems represented by
Adapters at their seams. We rejected wrapping the existing extension closure in
one runtime class because that would preserve its mixed responsibilities without
increasing Depth or Locality; stateful domain behavior belongs in focused
objects, while stateless policies remain plain functions.

## Consequences

- The default Pi extension export remains the composition root and contains only Pi registration, input mapping, rendering, and adapter wiring.
- Domain Modules do not import Pi, TUI, filesystem, browser, or telemetry types.
- Existing external behavior and persisted formats remain compatible throughout the migration.
- New seams require two meaningful Adapters or an immediate testability need; speculative factories and repositories are out of scope.
