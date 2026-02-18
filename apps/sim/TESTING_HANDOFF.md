# Simulation Testing Handoff (Fast Lane + API Lane)

Date: 2026-02-17

## Goal
Iteratively balance gameplay so prompt-driven strategies are distinct and watchable, while avoiding stalled/draw-heavy matches.

## Active Runtime Defaults (API Lane)
- Board size: `17x9` (`--boardColumns 17`).
- LLM turn planning: parallel API fanout enabled (`--llmParallelCalls 2`).
- Rationale: shorter path-to-contact + lower per-turn latency.

## Lanes
- Fast lane: mock-LLM bots, high volume, rapid A/B screening.
- API lane: real LLM calls (OpenRouter, `openai/gpt-4o-mini`), lower volume, realism check.

## Current Best Baseline
- Keep `workstream_stageB3_cavalry_mirror_policy_20260216` as current working baseline.
- Rejected regressions moved to `results_low_quality`:
  - `workstream_stageB1_cavcharge1_20260216`
  - `workstream_stageB2_strategic_melee_convert_20260216`
  - `workstream_stageB4_anti_stall_20260216`
  - `workstream_stageB5_defensive_destall_20260216`
  - `workstream_stageC1_fortify_cost3_20260216`

## Why Those Were Rejected
- B1: cavalry charge nerf caused major pacing regression in melee/midfield.
- B2: strategic melee conversion tweak did not improve target lanes and worsened others.
- B4/B5: bot-weight anti-stall attempts increased draws and distorted strategy viability.
- C1: fortify cost to 3 caused heavy draw spikes and longer games.

## API Lane State
- Primary reference:
  - `results/api_matrix_gpt4omini_n12_20260216`
  - `results/api_calibration_engagement_20260216_clean`
- Signals:
  - illegal moves are near-zero in tested sets.
  - behavior metrics indicate non-random action diversity and high reasoning telemetry coverage.
- Caveat:
  - keep validating `results.jsonl` completeness before interpreting win-rate conclusions.

## Standard Iteration Loop (Use Every Stage)
1. Pick one minimal change (single variable).
2. Run tests:
   - `pnpm -C packages/engine test`
   - `pnpm -C apps/sim test`
3. Run mirrored fast-lane matrix (112 games):
   - scenarios: `midfield`, `melee`, `all_infantry`, `all_cavalry`
   - pairs: `strategic/defensive`, `defensive/strategic`, `strategic/aggressive`, `aggressive/strategic`, `aggressive/defensive`, `defensive/aggressive`, `defensive/defensive`
   - 4 games per pair per scenario
   - `--harness boardgameio --boardColumns 17 --maxTurns 180`
4. Compare vs Stage A and B3:
   - draws
   - mean turns
   - strategy win-rate shape (strategic/aggressive/defensive)
5. Accept or reject:
   - accept only if no draw regression and no major strategy collapse across lanes.
6. If accepted, run API lane spot-check (small mirrored sample) using `gpt-4o-mini`.

## Immediate Next Candidates
- C2 (engine-side, minimal): small infantry stall-pressure adjustment in repeated close combat (not global stat swing).
- C3 (engine-side): mild objective/VP anti-loop pressure to shorten prolonged non-decisive games.
- Keep B3 bot policy fixed while testing engine knobs (avoid mixed-causality).

## Guardrails
- Avoid large multi-parameter changes.
- Reject any change that introduces substantial draws in melee/midfield.
- Keep API lane for validation, not primary tuning volume.
- Never commit raw results/artifacts in code commits.

## Useful Commands
- Single API test:
  - `pnpm -C apps/sim exec tsx src/cli.ts single --harness boardgameio --boardColumns 17 --bot1 llm --bot2 llm --model1 openai/gpt-4o-mini --model2 openai/gpt-4o-mini --llmParallelCalls 2 --scenario midfield --maxTurns 180`
- Locked benchmark profile (fast lane, reproducible):
  - `pnpm -C apps/sim run benchmark:v1`
- Locked benchmark profile (fast + API spot-check):
  - `set -a; source .env; set +a; pnpm -C apps/sim run benchmark:v1:api`
- Behavior metrics:
  - `pnpm -C apps/sim exec tsx src/cli.ts behavior --input <artifacts_or_results_dir> --output <dir>/behavior-metrics.json`
