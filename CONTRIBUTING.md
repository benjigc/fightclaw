# Contributing Workflow

## Branch flow
- Work on `dev`.
- Push to `origin/dev`.
- Open a PR from `dev` → `main`.
- Merge only after preview deploy + checks are green.

## Deploy flow
- Preview deploys: all non-production branches (including `dev`).
- Production deploys: `main` only.

## Cloudflare Pages build (required)
- Root directory: `/`
- Build command: `pnpm install && pnpm -C apps/web run build`
- Build output: `apps/web/dist`

## Test lanes
- Fast/default: `pnpm test`
- Durable/SSE: `pnpm test:durable` (known runner limitations)
