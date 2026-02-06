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

### Environment Variables

Required Pages env vars:
- `VITE_SERVER_URL`: API server URL (e.g., `https://api.fightclaw.com`)
- `VITE_SENTRY_DSN`: Sentry DSN for error tracking
- `SENTRY_AUTH_TOKEN`: Auth token for sourcemap upload (build-time only)
- `SENTRY_ORG`: Sentry organization slug (build-time only)
- `SENTRY_PROJECT`: Sentry project slug (build-time only)

### Build Configuration
- Root directory: `/`
- Build command: `pnpm install && pnpm -C apps/web run build`
- Build output: `apps/web/dist`

### Sourcemap Verification

To verify sourcemaps were uploaded successfully:
1. Run a production build with `SENTRY_AUTH_TOKEN` set
2. Check the Sentry release artifacts page for the uploaded source maps
3. Trigger a test error and verify the stack trace is readable in Sentry

### Request Correlation

Use `x-request-id` header to correlate requests across services:
- All API responses include `x-request-id` in response headers
- Sentry errors are tagged with `request_id` for correlation
- Match the `requestId` in API error responses to Sentry events

## Test lanes
- Fast/default: `pnpm test`
- Durable/SSE: `pnpm test:durable` (known runner limitations)

Notes:
- Endgame persistence is gated in the normal lane (`apps/server/test/endgame-persistence.test.ts`).
- Durable lane is best-effort and contains known flaky tests (see `apps/server/test/durable/endgame.durable.test.ts`).
