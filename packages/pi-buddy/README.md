# @season179/pi-buddy

Gives [pi](https://github.com/badlogic/pi-mono) a sparring partner: a separate
model that discusses, debates, pushes back, and fact-checks — like a candid
senior colleague. The buddy sees the full session transcript and has
**read-only** repository access (`read`, `grep`, `find`, `ls`). It can verify
claims against actual files but can never write.

## How it works

**Pull** — the main agent calls the `consult_buddy` tool with a stance:

| Stance | Behavior |
|---|---|
| `discuss` | Open exploration: tradeoffs, alternatives, second-order effects |
| `debate` | Steelmans the case *against* the proposal before giving a verdict |
| `fact_check` | Verifies claims against real files; cites VERIFIED / CONTRADICTED / UNVERIFIABLE |
| `review` | Quality review of recent work, ordered by severity |

**Human pull** — `/buddy <question>` asks the buddy directly.

**Push (watchdog)** — if the agent works 3 turns without consulting the buddy,
the buddy quietly reviews recent work. If it finds nothing, it replies `PASS`
and nothing happens (no noise). If it finds a real problem, the concern is
injected as a steering message the agent must address — you see it too.

**Memory** — the buddy is stateless per call, but because it receives the full
transcript (including its own past consultations), it has continuity: "I
flagged this two turns ago."

## Configuration

- Default buddy model: `zai/glm-5.2`. Override: `pi --buddy-model provider/id`.
- The buddy model must exist in your pi model registry with a valid API key.

## Development

```bash
npm run build   # compile
npm test        # build + node --test (pure logic: transcript, trimming, PASS detection)
```

Smoke test in a scratch directory:

```bash
pi -e packages/pi-buddy/src/extensions/buddy.ts
```

See `PLAN.md` for the full design rationale.
