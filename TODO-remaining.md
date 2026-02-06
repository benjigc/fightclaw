# Remaining Tasks — Unified Onboarding + Observability Plan

> Derived from the original plan (`plan.md`) cross-referenced against the working tree on `codex/parallel-safe-onboarding-observability`. Server-side core for both workstreams is in place; these are the gaps.

---

## Config / Infra (deploy blockers)

### 1. Add `Sentry.captureException` to `app.onError` handler
**File:** `apps/server/src/index.ts` (lines 29-34)

The plan (Observability §6) requires the global error handler to call `Sentry.captureException(err, { tags: { request_id, agent_id } })` so errors reach the Sentry dashboard with correlation tags. Currently it only does `console.error`. The `withSentry` wrapper catches unhandled rejections but won't tag them with request/agent context.

### 2. Add missing Alchemy bindings: `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`, `CF_VERSION_METADATA`
**File:** `packages/infra/alchemy.run.ts`

The plan (Observability §2) specifies three additional bindings beyond `SENTRY_DSN` and `OBS` (which are already present):
- `SENTRY_ENVIRONMENT: app.stage`
- `SENTRY_TRACES_SAMPLE_RATE` (string, from env or hardcoded by stage)
- `CF_VERSION_METADATA: VersionMetadata()` (import from `alchemy/cloudflare`) — used by `sentry.ts` to set the Sentry `release` tag

Without these, `obs/sentry.ts` reads `undefined` for environment/rate/release in production.

### 3. Add `wrangler.toml` local dev bindings for observability
**File:** `apps/server/wrangler.toml`

The plan (Observability §3) specifies adding:
- `[[analytics_engine_datasets]]` with `binding = "OBS"` and `dataset = "FIGHTCLAW_OBS"`
- `[version_metadata]` with `binding = "CF_VERSION_METADATA"`
- Under `[vars]`: `SENTRY_ENVIRONMENT = "local"` and `SENTRY_TRACES_SAMPLE_RATE = "0"`

Currently none of these exist, so `wrangler dev` runs without the OBS binding.

---

## Metric Instrumentation

### 4. Add MatchmakerDO metrics emission (`queue_join`, `match_created`, `match_found`)
**File:** `apps/server/src/do/MatchmakerDO.ts`

The plan (Observability §5) requires emitting Analytics Engine events at queue join, match creation, and match found. The `emitMetric()` function and all event types already exist in `obs/metrics.ts`. MatchmakerDO's env type also needs `OBS` and `SENTRY_ENVIRONMENT` added so it can call `emitMetric`.

### 5. Add MatchDO metrics for `match_started` and `match_ended`
**File:** `apps/server/src/do/MatchDO.ts`

The plan (Observability §5) requires:
- `match_started` emitted on init/first state creation
- `match_ended` emitted with reason code on terminal end (forfeit, illegal_move, invalid_move, etc.)

MatchDO already emits `turn_timeout_forfeit`, `agent_model_seen`, and `agent_inference` — the lifecycle bookend events are the gap.

---

## Script Fix

### 6. Update `create-agent.ts` for new schema
**File:** `apps/server/scripts/create-agent.ts`

The plan (Onboarding §3.4) requires the seeding script to:
- Insert into `api_keys` table (not just `agents`)
- Set `verified_at` to current time so seeded agents can play immediately
- Generate a `key_prefix` from the API key

Currently it only outputs `INSERT INTO agents (id, name, api_key_hash)` — agents created this way won't authenticate through the new `api_keys`-based auth middleware.

---

## Tests

### 7. Add auth onboarding tests (register, verify, me, gating)
**Dir:** `apps/server/test/`

The plan (Onboarding §6) specifies:
- `auth.onboarding.test.ts`: register returns apiKey + claimCode; unverified agent gets 403 on queue; admin verify enables queue; `/v1/auth/me` reflects verified status
- `auth.apikeys.test.ts`: auth succeeds via `api_keys` table; revoked key (set `revoked_at`) returns 401

### 8. Add prompt strategy tests (encrypt, decrypt, versions, activate)
**Dir:** `apps/server/test/`

The plan (Onboarding §6) specifies:
- `prompts.strategy.test.ts`: create prompt encrypts in DB (ciphertext != plaintext); GET active returns decrypted; versions list shows correct `isActive`; activate flips pointer
- `match.prompt-version-id.test.ts` (integration): two verified agents with active prompts queue a match; assert `match_players.prompt_version_id` is populated for both

### 9. Add observability safety tests (Sentry disabled, metrics no-op)
**Dir:** `apps/server/test/`

The plan (Observability §Test Cases) specifies:
- Sentry disabled with no DSN — worker and DO code paths don't throw
- Metrics emitter safe — omit OBS binding, calls are no-ops
- Internal runner model headers forwarded — `x-fc-*` headers persist to `match_players` columns
- Match ended emits metrics and persists results

---

## Web / Pages (entirely unstarted)

### 10. Add Web (Pages) Sentry integration
**Dir:** `apps/web/`

The plan (Observability — Web §1-4) specifies:
1. Add `@sentry/react` + `@sentry/vite-plugin` to `apps/web/package.json`
2. Type env: `VITE_SENTRY_DSN`, `VITE_SENTRY_ENVIRONMENT`, `VITE_SENTRY_RELEASE`
3. Initialize Sentry in `main.tsx` with browser tracing + `ErrorBoundary` around `<RouterProvider>`; `tracePropagationTargets` includes `api.fightclaw.com`; `tracesSampleRate` 0.05 prod / 1.0 preview
4. Add `sentryVitePlugin` to `vite.config.ts` for sourcemap upload (`build.sourcemap = true`); reads `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` from build env

### 11. Add Pages guardrails: `_redirects` and `_headers`
**Dir:** `apps/web/public/`

The plan (Observability — Pages Guardrails) specifies:
- `_redirects`: `/* /index.html 200` (SPA fallback)
- `_headers`: strong security headers for `/*`, long-cache immutable for `/assets/*` (Vite hashed), short/no-cache for `/index.html`

---

## Documentation

### 12. Update `CONTRACTS.md` with auth + prompt endpoint docs
**File:** `CONTRACTS.md`

The plan (Onboarding §7) requires documenting:
- `/v1/auth/register`, `/v1/auth/verify`, `/v1/auth/me` request/response shapes
- Prompt endpoints under `/v1/agents/me/strategy/...`
- Statement that verification is required for gameplay endpoints
- Statement that private strategy is never exposed in public/spectator responses

### 13. Update `CONTRIBUTING.md` with Pages env vars and sourcemap checklist
**File:** `CONTRIBUTING.md`

The plan (Observability — Pages Guardrails §Document) requires:
- Required Pages env vars: `VITE_SERVER_URL`, `VITE_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`
- How to verify sourcemaps uploaded
- How to correlate requests using `x-request-id`
