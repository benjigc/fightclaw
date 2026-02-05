# Repository Guidelines

This repo is a pnpm + Turborepo monorepo for Fightclaw (web, server, and simulation). Use the root scripts and keep changes scoped to the relevant app/package.

## Project Structure & Module Organization

- `apps/web/`: React + TanStack Router frontend.
- `apps/server/`: Hono API worker and backend tests.
- `apps/sim/`: simulation harness and engine tests.
- `packages/engine/`, `packages/db/`, `packages/infra/`, `packages/env/`, `packages/config/`: shared libraries and infrastructure tooling.
- `scripts/` and `project docs/`: repo tooling and notes.

## Build, Test, and Development Commands

- `pnpm install`: install dependencies for the workspace.
- `pnpm run dev`: run all apps in dev mode (Turbo).
- `pnpm run dev:web`: start only the web app.
- `pnpm run dev:server`: start only the server app.
- `pnpm run build`: build all packages/apps.
- `pnpm run check`: format + lint with Biome.
- `pnpm run check-types`: TypeScript typecheck across the repo.
- `pnpm run db:push`: push Drizzle schema changes.
- `pnpm run test`: default Node-based test lane.
- `pnpm run test:durable`: Durable Objects/SSE test lane (best-effort).

## Coding Style & Naming Conventions

- Formatting/linting is handled by Biome (`biome.json`). Indent with tabs and use double quotes.
- TypeScript is ESM (`"type": "module"`). Keep imports explicit and organized.
- Test file naming: `*.test.ts` for general tests, `*.unit.test.ts` for unit, `*.durable.test.ts` for Durable lanes.

## Testing Guidelines

- Tests use Vitest (see `apps/server/vitest*.config.ts`).
- Workers/Miniflare tests must run under Node; use `pnpm run test` and `pnpm run test:durable`.
- Durable lane can be flaky; do not gate releases on it without confirmation.

## Commit & Pull Request Guidelines

- Branch flow: work on `dev`, push to `origin/dev`, and open a PR to `main`.
- Do not push directly to `main` (blocked by `lefthook.yml`).
- Commit messages are short and imperative; optional scope prefixes are common (e.g., `docs: ...`, `server: ...`, `test(server): ...`).
- PRs should include a summary, test commands run, and screenshots for UI changes. Merge after preview deploy + checks are green.

## Configuration & Secrets

- Use `.env.example` as the template for local env vars and keep secrets out of git.
- `packages/infra/alchemy.run.ts` reads env vars for deploys; verify required keys before running `pnpm run deploy`.
