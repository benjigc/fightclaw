# Repository Guidelines

Fightclaw is a pnpm + Turborepo monorepo (web, server, sim, engine, db, infra).

## Essentials

- Use workspace scripts from repo root and keep changes scoped to the relevant app/package.
- Package manager is `pnpm`.
- Core commands: `pnpm run dev`, `pnpm run build`, `pnpm run check`, `pnpm run check-types`, `pnpm run test`, `pnpm run test:durable`.
- Formatting/linting uses Biome (tabs + double quotes).
- Branch flow is `dev -> PR -> main`; never push directly to `main`.
- Keep secrets out of git; use `.env.example` as the env template.

## Detailed Guidance

- [Architecture and Runtime Map](.claude/instructions/architecture.md)
- [Testing and Commands](.claude/instructions/testing.md)
- [Style and Workflow](.claude/instructions/style-and-workflow.md)
- [Contracts, Rules, and Environment](.claude/instructions/contracts-and-env.md)

## Current Status (2026-02-18)

- API graduation contract is currently passing and considered complete for this phase.
- `api_smoke` and `api_full` both achieved 2 consecutive passes under the minimal contract.
- API phase is intentionally scope-frozen: avoid adding new API thresholds/optimization work unless production issues appear.
- Primary API reliability targets in force:
  - illegal moves remain zero
  - high completion rate
  - bounded max-turn endings
  - acceptable p95 match wall-clock

## Dev Replay Workflow (Implemented)

- `/dev` now supports both:
  - `Sandbox` mode (local random/burst simulation)
  - `API Replay` mode (replay real API lane artifacts)
- Replay export bridge:
  - Script: `apps/sim/scripts/export-web-replay.ts`
  - Output: `apps/web/public/dev-replay/latest.json`
- Useful commands:
  - `pnpm -C apps/sim run export:web-replay`
  - `pnpm -C apps/sim run benchmark:v2:api_full:viz`
  - `pnpm -C apps/sim run benchmark:v2:api_smoke:viz`
- Recommended local loop:
  1. `pnpm run dev:web`
  2. Open `http://localhost:3001/dev`
  3. Run one of the `*:viz` commands (or `export:web-replay`) to refresh replay data

## Notes

- Keep generated replay artifacts out of code commits unless explicitly requested.
