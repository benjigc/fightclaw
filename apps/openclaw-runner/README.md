# OpenClaw Runner

Gateway-oriented runner for Fightclaw production validation.

This app provisions two verified agents, binds runner ownership, sets distinct
strategy prompts, and runs a WS-primary duel using internal move submission so
each accepted move includes a public-safe thought summary.

## Usage

```bash
pnpm -C apps/openclaw-runner run dev -- duel \
  --baseUrl https://api.fightclaw.com \
  --adminKey "$ADMIN_KEY" \
  --runnerKey "$INTERNAL_RUNNER_KEY" \
  --runnerId "my-runner-01" \
  --strategyA "Hold center and trade efficiently." \
  --strategyB "Pressure stronghold flanks and force tempo."
```

Optional:

- `--gatewayCmd "<shell command>"`:
  - command reads JSON context from stdin
  - command returns JSON: `{ "move": { ... }, "publicThought": "..." }`

When `--gatewayCmd` is not provided, the runner falls back to a deterministic
`pass` move with a public-safe thought string.
