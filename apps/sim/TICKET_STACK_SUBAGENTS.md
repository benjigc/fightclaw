# Fightclaw Roadmap Ticket Stack (Sub-agent Ready)

## Parallel Tracks
- Track A (Metrics + Benchmark): T1, T2
- Track B (Policy + Archetypes): T3, T4
- Track C (Economy + Terrain): T5, T6
- Track D (API Lane Reliability): T7, T8
- Track E (Spectator Explainability): T9

## T1 - Benchmark v2 script + scenario lock + mirrored pairings
- Owner: Agent-A-Metrics
- Status: Done
- Files:
  - `apps/sim/scripts/benchmark-v2.ts`
- Tasks:
  - Ensure fixed seed sets and mirrored pairings per scenario.
  - Emit benchmark summary + gate outputs.
  - Add API lane orchestration switches.
- Acceptance tests:
  - `pnpm -C apps/sim exec tsx scripts/benchmark-v2.ts --dryRun`
  - Output includes `gates`, `metaDiversity`, `behaviorByMatchup` in summary JSON.

## T2 - Behavior metrics expansion (archetype/macro/terrain/fortify)
- Owner: Agent-A-Metrics
- Status: Done
- Files:
  - `apps/sim/src/reporting/behaviorMetrics.ts`
  - `apps/sim/test/behaviorMetrics.test.ts`
- Tasks:
  - Add `archetypeSeparation`, `macroIndex`, `terrainLeverage`, `fortifyROI`.
  - Parse prompt state telemetry for terrain/macro signals.
  - Compute spend-curve and action-mix signals.
- Acceptance tests:
  - `pnpm -C apps/sim test -- --runInBand`
  - `test/behaviorMetrics.test.ts` passes and asserts non-zero metric fields.

## T3 - Mock policy refactor to utility terms
- Owner: Agent-B-Policy
- Status: Done
- Files:
  - `apps/sim/src/bots/mockLlmBot.ts`
  - `apps/sim/src/bots/mockLlmArchetypes.ts`
  - `apps/sim/test/mockLlmBot.test.ts`
- Tasks:
  - Replace static profile bias with utility terms:
    - `combatValue`, `positionValue`, `economyValue`, `riskValue`, `timingValue`.
  - Support phase-aware policy (opening/midgame/closing).
  - Add move-level `whyThisMove` metadata.
- Acceptance tests:
  - `pnpm -C apps/sim test -- --runInBand`
  - `test/mockLlmBot.test.ts` confirms archetype + reasoning metadata.

## T4 - Prompt-to-outcome coupling for API LLM lane
- Owner: Agent-B-Policy
- Status: Done
- Files:
  - `apps/sim/src/cli.ts`
  - `apps/sim/src/bots/llmBot.ts`
- Tasks:
  - Wire `--strategy1/--strategy2` into LLM system prompt even without explicit `--prompt`.
  - Add anti-loop policy hints and attack-priority escape hatch.
- Acceptance tests:
  - Run targeted API probes and verify fewer recruit/pass loops in artifacts.

## T5 - Economy depth (long-horizon + comeback)
- Owner: Agent-C-Economy
- Status: Done (mechanic), Tune pending
- Files:
  - `packages/engine/src/index.ts`
  - `packages/engine/test/engine.test.ts`
- Tasks:
  - Add multi-node compounding income mechanic.
  - Add comeback stipend when behind on multiple axes.
- Acceptance tests:
  - `pnpm -C packages/engine test`
  - Engine tests for node income and comeback stipend pass.

## T6 - Terrain + fortify tactical layer
- Owner: Agent-C-Economy
- Status: Done
- Files:
  - `packages/engine/src/index.ts`
  - `apps/sim/src/bots/stateEncoder.ts`
  - `apps/sim/src/scenarios/combatScenarios.ts`
  - `apps/sim/test/stateEncoder.test.ts`
  - `apps/sim/test/scenarios.test.ts`
- Tasks:
  - Raise default fortify impact.
  - Add contested terrain context in encoder.
  - Add terrain-centric scenarios (`high_ground_clash`, `forest_chokepoints`, `resource_race`).
- Acceptance tests:
  - `pnpm -C apps/sim test -- --runInBand`
  - Encoder/scenario tests pass.

## T7 - API lane reliability and benchmark instrumentation hygiene
- Owner: Agent-D-API
- Status: Done (core), Tune pending
- Files:
  - `apps/sim/scripts/benchmark-v2.ts`
  - `apps/sim/src/boardgameio/runner.ts`
- Tasks:
  - Force `--storeFullPrompt true --storeFullOutput true` in benchmark runs.
  - Ensure fallback prompt generation in runner for non-LLM turn planners.
  - Enforce non-null gate behavior for macro/terrain metrics.
- Acceptance tests:
  - `pnpm -C apps/sim exec tsx scripts/benchmark-v2.ts --dryRun`
  - Fresh benchmark summary shows non-null `terrainLeverageSummary.avgLeverageRate`.

## T8 - Long-game hotspot mitigation (all-infantry and defensive-vs-strategic)
- Owner: Agent-D-API
- Status: Done (implemented), Validation tuning pending
- Files:
  - `apps/sim/src/bots/llmBot.ts`
  - `apps/sim/src/bots/mockLlmBot.ts`
  - `apps/sim/src/scenarios/combatScenarios.ts`
- Tasks:
  - Add anti-stall pressure triggers for melee mirrors in late game.
  - Reduce recruit-loop and rotate-move loop behavior.
  - Add matchup-specific policy guardrails for all-infantry grind patterns.
- Acceptance tests:
  - API smoke pair set has `p95 turns <= 60` and `timeout rate < 5%`.
  - `all_infantry strategic_vs_defensive` mean turns reduced vs current baseline.

## T9 - Spectator explainability timeline
- Owner: Agent-E-UX
- Status: Done (backend/reporting), UI wire pending
- Files:
  - `apps/sim/src/boardgameio/types.ts`
  - `apps/sim/src/boardgameio/artifact.ts`
  - `apps/sim/src/boardgameio/runner.ts`
  - `apps/sim/src/reporting/dashboardGenerator.ts`
  - `apps/sim/test/boardgameio.explainability.test.ts`
- Tasks:
  - Add turn explainability fields: `declaredPlan`, `powerSpikeTriggered`, `swingEvent`, `whyThisMove`.
  - Build timeline extraction + archetype classification in reporting.
- Acceptance tests:
  - `pnpm -C apps/sim test -- --runInBand`
  - Explainability test confirms fields in artifacts.

## Current Gate Snapshot (2026-02-18)
- Source: `apps/sim/results/benchmark_v2_2026-02-18T06-01-19-750Z/benchmark-summary.json`
- Pass:
  - Illegal moves: 0
  - Scenario tempo spread: 11.14 (>=10)
  - Archetype separation: 0.2263 (>=0.04)
  - Terrain leverage: 0.3634 (>=0.3)
- Failing:
  - Draw rate: 2.68% (>2.0%)
  - Macro index: 0.1905 (<0.3)

## Next Parallel Sprint (to close remaining fails)
- Sprint-S1 (Agent-D-API): validate/tune T8 outcomes to clear draw-rate gate.
- Sprint-S2 (Agent-C-Economy): macroIndex uplift via stronger recruit/banking/node-control incentives.
- Sprint-S3 (Agent-A-Metrics): add per-matchup gate drilldown report in benchmark summary.
