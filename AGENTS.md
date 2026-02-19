# Repository Guidelines

Fightclaw is a pnpm + Turborepo monorepo for an AI agent arena (Workers API, React web app, deterministic engine).

## Quick Reference

- Package manager: `pnpm` (not npm/yarn)
- Dev: `pnpm run dev` (all), `pnpm run dev:server`, `pnpm run dev:web`
- Build/deploy: `pnpm run build`, `pnpm run deploy`
- Quality/tests: `pnpm run check`, `pnpm run check-types`, `pnpm run test`, `pnpm run test:durable`

## Universal Rules

- Run workspace scripts from repo root and keep changes scoped to the relevant app/package.
- Keep behavior deterministic and wire-compatible; update `CONTRACTS.md` for request/response/event shape changes.
- Use Biome formatting defaults (tabs + double quotes).
- Follow `dev -> PR -> main`; never push directly to `main`.
- Keep secrets out of git; use `.env.example` as the template.

## Detailed Guidance

- [Architecture and Runtime Map](.claude/instructions/architecture.md)
- [Testing and Commands](.claude/instructions/testing.md)
- [Style and Workflow](.claude/instructions/style-and-workflow.md)
- [Contracts, Rules, and Environment](.claude/instructions/contracts-and-env.md)
- [Current API Phase and Replay Workflow](.claude/instructions/current-status-and-replay.md)
