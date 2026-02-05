# fightclaw

This project was created with [Better-T-Stack](https://github.com/AmanVarshney01/create-better-t-stack), a modern TypeScript stack that combines React, TanStack Router, Hono, and more.

## Features

- **TypeScript** - For type safety and improved developer experience
- **TanStack Router** - File-based routing with full type safety
- **TailwindCSS** - Utility-first CSS for rapid UI development
- **shadcn/ui** - Reusable UI components
- **Hono** - Lightweight, performant server framework
- **workers** - Runtime environment
- **Drizzle** - TypeScript-first ORM
- **SQLite/Turso** - Database engine
- **Biome** - Linting and formatting
- **Turborepo** - Optimized monorepo build system

## Getting Started

First, install the dependencies (pnpm is the canonical path):

```bash
pnpm install
```

## Database Setup

This project uses SQLite with Drizzle ORM.

1. Start the local SQLite database (optional):
   D1 local development and migrations are handled automatically by Alchemy during dev and deploy.

2. Update your `.env` file in the `apps/server` directory with the appropriate connection details if needed.

3. Apply the schema to your database:

```bash
pnpm run db:push
```

Then, run the development server:

```bash
pnpm run dev
```

Open [http://localhost:3001](http://localhost:3001) in your browser to see the web application.
The API is running at [http://localhost:3000](http://localhost:3000).

## Deployment (Cloudflare via Alchemy)

- Dev: cd apps/server && pnpm run dev
- Deploy: cd apps/server && pnpm run deploy
- Destroy: cd apps/server && pnpm run destroy

For more details, see the guide on [Deploying to Cloudflare with Alchemy](https://www.better-t-stack.dev/docs/guides/cloudflare-alchemy).

## Local Dev / Deploying With Alchemy

`packages/infra/alchemy.run.ts` reads secrets from `process.env` and passes them to the Worker via `alchemy.secret(...)`.

Create a `.env` (not committed) using `.env.example` as a template, then export variables before running deploy.

```bash
# from repo root
cp .env.example .env
# edit .env with real values

export $(cat .env | xargs)
pnpm run deploy
```

## Git Hooks and Formatting

- Format and lint fix: `pnpm run check`

## Project Structure

```
fightclaw/
├── apps/
│   ├── web/         # Frontend application (React + TanStack Router)
│   └── server/      # Backend API (Hono)
├── packages/
│   ├── api/         # API layer / business logic
```

## Available Scripts

- `pnpm run dev`: Start all applications in development mode
- `pnpm run build`: Build all applications
- `pnpm run dev:web`: Start only the web application
- `pnpm run dev:server`: Start only the server
- `pnpm run check-types`: Check TypeScript types across all apps
- `pnpm run db:push`: Push schema changes to database
- `pnpm run db:studio`: Open database studio UI
- `pnpm run check`: Run Biome formatting and linting
- `pnpm run test`: Run the fast server test suite (Node-based)
- `pnpm run test:durable`: Run the Durable Objects / SSE test suite (Node-based)
- `pnpm run test:unit`: Run unit tests (Bun required for bunx)

## Testing Notes

Workers/Miniflare tests must run under Node (not Bun) due to module resolution in workerd. Use:
- `pnpm run test` (fast suite, Node-based)
- `pnpm run test:durable` (Durable Objects/SSE)

If you want quick checks in Bun only, use `pnpm run test:unit`.

Durable test notes:
- The `test:durable` lane is expected to occasionally fail with "isolated storage stack frame" errors from the Workers test runner. This is a known limitation; keep the suite runnable, but don’t gate default CI on it.
- To run the durable suite: `pnpm run test:durable`
- Expected current failure signature: "Failed to pop isolated storage stack frame" / "Isolated storage failed" coming from `@cloudflare/vitest-pool-workers` (not app assertions).
- Endgame persistence is gated in the normal lane via `apps/server/test/endgame-persistence.test.ts`.
- Durable lane is best-effort and contains known flaky tests (see `apps/server/test/durable/endgame.durable.test.ts` for details).
