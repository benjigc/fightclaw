# Test Suite Revision Recommendations

Current state: 43 tests across 13 files (40 active, 3 skipped). Heavy integration bias (~30 durable tests) with an underutilized unit lane (~10 tests).

## Priority 1: Bulk Up Engine Unit Tests

The engine package (`packages/engine`) is pure TS with zero I/O — the cheapest, fastest, most reliable tests in the repo. Currently only 4 tests cover move legality, terminal detection, combat, and determinism.

**Add tests for:**
- Hex grid boundary conditions (out-of-bounds coordinates, wrapping behavior)
- Unit stacking and movement constraints
- Invalid move shapes (malformed input, wrong player's units)
- All terminal state paths (not just the one currently tested)
- Edge cases in combat resolution (ties, multi-unit engagements)
- State determinism across varied game seeds

**Run with:** `cd packages/engine && bun test`

## Priority 2: Extract Shared Test Helpers

Three patterns are duplicated across multiple durable test files.

### `pollUntil()`
Defined separately in `e2e.durable.test.ts`, `featured.durable.test.ts`, and `endgame-persistence.test.ts`. Move to `test/helpers.ts`.

```ts
// test/helpers.ts
export async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (result: T) => boolean,
  intervalMs = 100,
  timeoutMs = 10_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const result = await fn();
    if (predicate(result)) return result;
    if (Date.now() - start > timeoutMs) throw new Error("pollUntil timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
```

### `setupMatch()`
The queue-join → poll-until-matched → extract-match-id sequence appears in 15+ tests but is only abstracted in a few files. Add a shared version to `test/helpers.ts`:

```ts
// test/helpers.ts
export async function setupMatch(
  agentA: { id: string; key: string },
  agentB: { id: string; key: string },
): Promise<{ matchId: string }> {
  // join both agents, poll queue status, return matchId
}
```

### `readSseFrames()`
SSE parsing logic in `readSseUntil` is solid but several tests do ad-hoc text parsing on SSE responses. Standardize on the helper for all SSE assertions.

## Priority 3: Move Logic Out of the Durable Lane

Anything that doesn't need Miniflare/Workers runtime should run in the unit lane (`vitest.unit.config.ts`, Node environment). Candidates:

| What | Currently | Move to |
|------|-----------|---------|
| Zod schema validation (movePayloadSchema, finishPayloadSchema, matchIdSchema) | Untested | `*.unit.test.ts` |
| Crypto utils (`src/utils/crypto.ts`) — SHA-256 hashing, random generation | Untested | `*.unit.test.ts` |
| Request context helpers (`src/appContext.ts` — `createIdentity`) | Untested | `*.unit.test.ts` |
| Event builder functions | `events.unit.test.ts` | Already there |
| Auth header parsing logic (extract bearer token, hash comparison) | Tested only via integration | Add `auth.unit.test.ts` |

These tests run instantly under Node, never flake, and cover the same logic the durable tests cover indirectly but with much less overhead.

## Priority 4: Resolve Skipped SSE Tests

Three tests in `sse.durable.test.ts` are skipped due to workerd teardown instability:

1. Stream isolation (per-agent filtering)
2. `game_ended` event delivery via match stream
3. `game_ended` event delivery via events stream

**Options:**
- **Fix them** — if the underlying Miniflare issue is resolved in a newer `@cloudflare/vitest-pool-workers` version, re-enable and verify.
- **Delete and track** — remove the skipped tests, open a GitHub issue with the expected behavior. Skipped tests are invisible debt; issues are visible.
- **Rewrite as unit tests** — extract the SSE serialization/filtering logic into a testable function and test that in the unit lane. The integration test then only needs to verify "DO sends SSE response" (which `sse.durable.test.ts` test #1 already covers).

Recommend option 3: unit-test the SSE logic, keep only the one working integration test as a smoke check.

## Priority 5: Add Coverage for Untested Routes

These routes exist in the codebase with zero test coverage:

| Route | File | Risk |
|-------|------|------|
| `POST /v1/auth/register` | `routes/auth.ts` | Agent registration — core onboarding flow |
| `POST /v1/auth/verify` | `routes/auth.ts` | Agent verification — gates queue access |
| `GET /v1/agents/:id/prompts` | `routes/prompts.ts` | Prompt retrieval |
| `PUT /v1/agents/:id/prompts` | `routes/prompts.ts` | Prompt update |
| `POST /v1/internal/agents/:id/prompt` | `routes/prompts.ts` | Runner prompt injection |
| `GET /v1/leaderboard` | `index.ts` | Direct D1 query, no DO layer |
| `GET /v1/live` | `index.ts` | Proxies to MatchmakerDO |

The auth registration and verification routes are the highest priority — they're the entry point for every agent.

## Priority 6: Trim Auth Integration Tests

The 8 auth durable tests verify that every protected endpoint rejects unauthenticated requests. This is thorough but redundant — they're all testing the same Hono middleware wiring.

**Keep:**
- 1 test for bearer token auth (agent endpoint)
- 1 test for admin key auth (finish endpoint)
- 1 test for runner key auth (internal endpoint)
- 1 test for verified-agent gating (queue endpoint)

**Remove or collapse** the remaining 4 that verify the same middleware on different route paths. If the middleware is applied correctly to one route, it works on all of them. The risk of a route missing its `use()` call is low and better caught by a linter rule or code review.

## Summary

| Action | Tests Added | Tests Removed | Net Effort |
|--------|-------------|---------------|------------|
| Engine unit tests | +10–15 | 0 | Low (pure functions) |
| Shared helpers refactor | 0 | 0 | Low (move existing code) |
| Unit-lane expansion | +5–8 | 0 | Low (no infra needed) |
| SSE test resolution | +2–3 unit | -3 skipped | Medium |
| Untested routes | +5–7 | 0 | Medium (need Miniflare for auth routes) |
| Auth test consolidation | 0 | -4 | Low (delete) |

**Target state:** ~60–70 tests. Ratio shifts from 75% integration / 25% unit to roughly 50/50. The unit lane becomes the primary place to write new tests; the durable lane is reserved for behavior that genuinely requires Workers runtime.
