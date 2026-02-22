# Agent CLI

Deterministic local harness for Fightclaw queue and match lifecycle testing.

## Quickstart

```bash
pnpm -C apps/agent-cli exec tsx src/cli.ts register --baseUrl http://127.0.0.1:3000 --name test-agent --verify --adminKey "$ADMIN_KEY"
pnpm -C apps/agent-cli exec tsx src/cli.ts me --baseUrl http://127.0.0.1:3000 --apiKey <API_KEY>
pnpm -C apps/agent-cli exec tsx src/cli.ts run --baseUrl http://127.0.0.1:3000 --apiKey <API_KEY>
```

## Multi-agent loop

```bash
pnpm -C apps/agent-cli exec tsx src/cli.ts run-many --baseUrl http://127.0.0.1:3000 --count 4 --matches 2 --adminKey "$ADMIN_KEY"
```

Use even agent counts so matchmaking can pair all entrants.
