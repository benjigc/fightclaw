# LLM Bot Simulation Overhaul — Design

## Problem

The LLM bot simulation is functionally working but games never end decisively. Units start ~18 hexes apart on a 21x9 board, take 5+ turns to make contact, and the 20-turn limit expires before meaningful combat occurs. API calls are sequential (one per action, 5 per turn), making games take 10-20 minutes of mostly movement.

## Approach: Hybrid

Keep the full 21x9 board (production layout), but fix the sim to produce decisive games through config overrides, combat scenario support, and a fundamentally reworked LLM interface.

No engine changes required. All changes are in `apps/sim`.

---

## Section 1: Engine Config Passthrough

The engine's `createInitialState(seed, configInput, players)` already accepts config overrides. The sim adapter currently hardcodes `configInput` to `undefined`.

Changes:
- `engineAdapter.ts`: Accept optional `EngineConfigInput` in `createInitialState`
- `cli.ts`: Add `--turnLimit` (default 40) and `--actionsPerTurn` (default 7) flags
- `match.ts`: Pass config through to the adapter

Sim defaults (override engine defaults for sim purposes):
- `turnLimit: 40` (up from 20) — units make contact by turn 5-6, leaving 34+ turns of gameplay
- `actionsPerTurn: 7` (up from 5) — more actions to both move and fight per turn

## Section 2: Combat Scenarios as First-Class CLI Feature

The existing `combatScenarios.ts` has melee/ranged/stronghold_rush scenarios but isn't wired into the CLI.

Changes:
- `cli.ts`: Add `--scenario melee|ranged|stronghold_rush|midfield` flag
- `match.ts`: When scenario is set, use `createCombatScenario()` instead of `createInitialState()`
- `combatScenarios.ts`: Add `midfield` scenario — both armies pre-positioned around columns 8-14, within 2-3 hexes of each other, testing full game flow without the approach march
- Verify existing scenario hex positions against actual board terrain

## Section 3: Compact Hex Notation for LLM Context

Replace the verbose ASCII board + JSON move dump with structured, compact notation.

### Board state encoding

```
STATE turn=12 player=A actions=7 gold=19 wood=3 vp=3
ENEMY gold=15 wood=1 vp=1

UNITS_A:
  A-1 inf E10 hp=3/3
  A-4 cav G11 hp=2/2
  A-6 arc D9 hp=2/2 fortified

UNITS_B:
  B-1 inf F11 hp=2/3
  B-3 inf B20 hp=3/3 [stronghold]
  B-5 cav H13 hp=1/2

TERRAIN_NEAR_UNITS:
  E10=plains F11=forest G11=hills D9=high_ground B20=stronghold_b

LAST_ENEMY_TURN:
  move B-1 G12->F11
  attack B-5 G11 (dmg=1, target=A-4 cav hp=1/2)
  fortify B-3 B20
  recruit inf H20
  end_turn
```

### Legal moves encoding

Categorized by action type, compact format:

```
LEGAL_MOVES:
ATTACKS:
  attack A-1 F11 (target: B-1 inf hp=2/3)
  attack A-6 F11 (target: B-1 inf hp=2/3, ranged)
MOVES:
  move A-1 E10->E11
  move A-1 E10->D10
  move A-4 G11->F12
  ...
RECRUIT:
  recruit inf B2 (cost=10g)
  recruit cav B2 (cost=18g)
OTHER:
  end_turn
```

## Section 4: One API Call Per Turn, CLI-Style Commands

### Core change

Instead of 5-7 API calls per turn (one per action), the LLM gets one call and returns all actions as line-separated CLI commands.

### Command format

```
move A-4 E10
attack A-1 F11
attack A-6 F11
recruit infantry B2
end_turn
```

Format: `<action> <unit_id|unit_type> <target_hex>`

### Parsing and validation

The sim parses each command line, matches it against the current legal moves:
1. Parse the command into action type + params
2. Find matching legal move(s) from `listLegalMoves()`
3. If match found: apply move, re-list legal moves for next command
4. If no match: skip command, log warning
5. If fewer valid commands than actions available: remaining auto-pass
6. Log full command set, match results, and reasoning to diagnostics

### System prompt strategy

First call of the game includes:
- Command format spec (the "skill document")
- Unit stats reference table
- Win conditions
- Player side and stronghold positions

Subsequent calls include only:
- "You are Player A. Respond with commands only."

### Response format

The LLM responds with commands followed by optional reasoning:

```
move A-4 E10
attack A-1 F11
recruit infantry B2
end_turn
---
Pushing cavalry forward to threaten stronghold. Attacking their weakened infantry.
```

Everything after `---` is reasoning (logged to diagnostics, not parsed as commands).

## Section 5: Expected Performance

| Metric | Current | After |
|--------|---------|-------|
| API calls per turn | 5-7 | 1 |
| Tokens per call | 2000-3000 | 300-500 |
| API latency per turn | 15-28s | 1-3s |
| Game turns | 20 (too few) | 40 |
| Actions per turn | 5 | 7 |
| Time per full game | 10-20 min | 2-5 min |
| Combat engagement | Never | Turn 5-6 |

## Files to Change

- `apps/sim/src/engineAdapter.ts` — config passthrough
- `apps/sim/src/match.ts` — batch action model, scenario support, config passthrough
- `apps/sim/src/cli.ts` — new flags (turnLimit, actionsPerTurn, scenario)
- `apps/sim/src/bots/llmBot.ts` — complete rewrite of prompt construction and response parsing
- `apps/sim/src/scenarios/combatScenarios.ts` — add midfield scenario, verify positions
- `apps/sim/src/diagnostics/collector.ts` — adapt to batch action logging

## Files unchanged

- `packages/engine/` — zero engine changes
- `apps/sim/src/bots/randomBot.ts` — unchanged
- `apps/sim/src/bots/greedyBot.ts` — unchanged
- `apps/sim/src/bots/aggressiveBot.ts` — unchanged
- `apps/sim/src/runner/` — unchanged
- `apps/sim/src/tournament.ts` — unchanged
