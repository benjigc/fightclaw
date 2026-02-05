# apps/sim — offline tournament runner (drop-in)

This package runs **offline** matches using your local engine (no Workers, no Durable Objects, no OpenClaw).
It's meant to answer: *"Does the game loop work and do rules behave over many games?"*

## What you need to implement (one-time)

Update `src/engineAdapter.ts` to call into your real engine package.

The harness expects these minimal concepts:

- `MatchState` type (your engine state)
- `AgentId` type (string/number)
- `Move` type (your move schema)
- `createInitialState(seed?, config?, players?)`
- `currentPlayer(state)` -> AgentId
- `isTerminal(state)` -> `{ ended, winner?, reason }`
- `winner(state)` -> AgentId | null
- `listLegalMoves(state)` -> Move[]  (include Pass)
- `applyMove(state, move)` -> `{ ok, state, engineEvents, reason?, error? }`

If you don't have `listLegalMoves` yet, add it. This runner becomes dramatically more useful once
it can generate legal moves deterministically.

## Run

From repo root (pnpm workspaces):

```bash
pnpm -C apps/sim install
pnpm -C apps/sim sim:single
pnpm -C apps/sim sim:tourney
pnpm -C apps/sim sim:single -- --log --logFile ./match.json
pnpm -C apps/sim tsx src/cli.ts replay --logFile ./match.json
```

## Output

The tournament runner prints JSON summaries (easy to pipe into other tools).
`--log` prints a compact one-line match log to stdout.
