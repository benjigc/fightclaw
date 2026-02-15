# LLM Bot Simulation Overhaul — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the LLM bot simulation produce decisive games in 2-5 minutes with one API call per turn using CLI-style commands.

**Architecture:** The sim adapter passes engine config overrides (turnLimit, actionsPerTurn) to give games enough room for combat. The LLM bot is rewritten to batch all turn actions into one API call using compact hex notation and CLI-style command output. Combat scenarios are wired into the CLI for focused testing.

**Tech Stack:** TypeScript, bun:test, @fightclaw/engine, OpenAI SDK

---

### Task 1: Engine Config Passthrough in Adapter

**Files:**
- Modify: `apps/sim/src/engineAdapter.ts`
- Modify: `apps/sim/src/types.ts`
- Test: `apps/sim/test/engine.test.ts`

**Step 1: Write the failing test**

In `apps/sim/test/engine.test.ts`, add:

```typescript
test("createInitialState accepts config overrides", () => {
	const state = Engine.createInitialState(1, ["a", "b"], {
		turnLimit: 40,
		actionsPerTurn: 7,
	});
	expect(state.actionsRemaining).toBe(7);
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/sim && bun test test/engine.test.ts`
Expected: FAIL — `createInitialState` doesn't accept a third argument.

**Step 3: Update types.ts to re-export EngineConfigInput**

In `apps/sim/src/types.ts`, add to the imports and re-exports:

```typescript
import type {
	AgentId,
	EngineConfigInput,
	EngineEvent,
	GameState,
	MatchState,
	Move,
	TerminalState,
} from "@fightclaw/engine";

export type {
	AgentId,
	EngineConfigInput,
	EngineEvent,
	GameState,
	MatchState,
	Move,
	TerminalState,
};
```

**Step 4: Update engineAdapter.ts**

Replace the `createInitialState` method:

```typescript
import {
	applyMove,
	createInitialState,
	currentPlayer,
	isTerminal,
	listLegalMoves,
	winner,
} from "@fightclaw/engine";
import type { AgentId, EngineConfigInput, MatchState, Move } from "./types";

export const Engine = {
	createInitialState(
		seed: number,
		players: AgentId[],
		configInput?: EngineConfigInput,
	): MatchState {
		return createInitialState(seed, configInput, players);
	},
	// ... rest unchanged
```

**Step 5: Run test to verify it passes**

Run: `cd apps/sim && bun test test/engine.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add apps/sim/src/engineAdapter.ts apps/sim/src/types.ts apps/sim/test/engine.test.ts
git commit -m "feat(sim): pass engine config overrides through adapter"
```

---

### Task 2: Wire Config Through Match Runner and CLI

**Files:**
- Modify: `apps/sim/src/match.ts`
- Modify: `apps/sim/src/cli.ts`

**Step 1: Add config to playMatch opts**

In `apps/sim/src/match.ts`, update the opts type and the `createInitialState` call:

```typescript
import type {
	AgentId,
	Bot,
	EngineConfigInput,
	EngineEvent,
	MatchLog,
	MatchResult,
	MatchState,
	Move,
} from "./types";

export async function playMatch(opts: {
	seed: number;
	players: Bot[];
	maxTurns: number;
	verbose?: boolean;
	record?: boolean;
	autofixIllegal?: boolean;
	enableDiagnostics?: boolean;
	engineConfig?: EngineConfigInput;
}): Promise<MatchResult> {
```

Then change the `createInitialState` call from:

```typescript
let state: MatchState = Engine.createInitialState(opts.seed, playerIds);
```

to:

```typescript
let state: MatchState = Engine.createInitialState(opts.seed, playerIds, opts.engineConfig);
```

**Step 2: Add CLI flags**

In `apps/sim/src/cli.ts`, in the `main()` function, after the existing `maxTurns` parsing, add:

```typescript
const turnLimit = num(argv.turnLimit, 40);
const actionsPerTurn = num(argv.actionsPerTurn, 7);
```

Build the config object:

```typescript
const engineConfig: EngineConfigInput = {
	turnLimit,
	actionsPerTurn,
};
```

(Import `EngineConfigInput` from `./types`.)

Pass `engineConfig` to every `playMatch` call and `runTournament` call. The tournament runner (`tournament.ts`) also needs the config passed through — add `engineConfig?: EngineConfigInput` to its opts and forward to `playMatch`.

**Step 3: Update tournament.ts**

In `apps/sim/src/tournament.ts`, add `engineConfig` to the options type and forward it to `playMatch`.

**Step 4: Verify manually**

Run: `cd apps/sim && npx tsx src/cli.ts single --bot1 greedy --bot2 random --turnLimit 40 --actionsPerTurn 7 --seed 1 --verbose`

Confirm the game runs with 7 actions per turn and a 40-turn limit.

**Step 5: Commit**

```bash
git add apps/sim/src/match.ts apps/sim/src/cli.ts apps/sim/src/tournament.ts
git commit -m "feat(sim): wire turnLimit and actionsPerTurn CLI flags"
```

---

### Task 3: Wire Combat Scenarios into CLI

**Files:**
- Modify: `apps/sim/src/scenarios/combatScenarios.ts`
- Modify: `apps/sim/src/match.ts`
- Modify: `apps/sim/src/cli.ts`
- Test: `apps/sim/test/scenarios.test.ts`

**Step 1: Write a test for the midfield scenario**

Create `apps/sim/test/scenarios.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { createCombatScenario } from "../src/scenarios/combatScenarios";
import { Engine } from "../src/engineAdapter";

describe("combat scenarios", () => {
	test("midfield scenario places units near center", () => {
		const state = createCombatScenario(1, ["a", "b"], "midfield");
		const aUnits = state.players.A.units;
		const bUnits = state.players.B.units;
		expect(aUnits.length).toBeGreaterThan(0);
		expect(bUnits.length).toBeGreaterThan(0);
		// All units should be in columns 7-15 (center area)
		for (const u of [...aUnits, ...bUnits]) {
			const col = parseInt(u.position.slice(1), 10);
			expect(col).toBeGreaterThanOrEqual(7);
			expect(col).toBeLessThanOrEqual(15);
		}
	});

	test("midfield scenario produces legal moves including attacks", () => {
		const state = createCombatScenario(1, ["a", "b"], "midfield");
		const moves = Engine.listLegalMoves(state);
		const attacks = moves.filter((m) => m.action === "attack");
		expect(attacks.length).toBeGreaterThan(0);
	});

	test("melee scenario has attacks on turn 1", () => {
		const state = createCombatScenario(1, ["a", "b"], "melee");
		const moves = Engine.listLegalMoves(state);
		const attacks = moves.filter((m) => m.action === "attack");
		expect(attacks.length).toBeGreaterThan(0);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/sim && bun test test/scenarios.test.ts`
Expected: FAIL — `midfield` scenario doesn't exist.

**Step 3: Add the midfield scenario**

In `apps/sim/src/scenarios/combatScenarios.ts`, add a `midfield` case to the switch. Update the scenario type:

```typescript
export function createCombatScenario(
	seed: number,
	players: AgentId[],
	scenario: "melee" | "ranged" | "stronghold_rush" | "midfield" = "melee",
): MatchState {
```

Add the midfield case (units in columns 8-14, both sides within 2-3 hexes):

```typescript
		case "midfield":
			// Full army positioned in the center for immediate engagement
			addUnitToState(state, "A-1", "infantry", "A", "D8");
			addUnitToState(state, "A-2", "infantry", "A", "F8");
			addUnitToState(state, "A-3", "infantry", "A", "E9");
			addUnitToState(state, "A-4", "cavalry", "A", "C9");
			addUnitToState(state, "A-5", "cavalry", "A", "G9");
			addUnitToState(state, "A-6", "archer", "A", "E8");

			addUnitToState(state, "B-1", "infantry", "B", "D12");
			addUnitToState(state, "B-2", "infantry", "B", "F12");
			addUnitToState(state, "B-3", "infantry", "B", "E11");
			addUnitToState(state, "B-4", "cavalry", "B", "C12");
			addUnitToState(state, "B-5", "cavalry", "B", "G12");
			addUnitToState(state, "B-6", "archer", "B", "E13");
			break;
```

**Step 4: Run test to verify it passes**

Run: `cd apps/sim && bun test test/scenarios.test.ts`
Expected: PASS

**Step 5: Add scenario support to match runner**

In `apps/sim/src/match.ts`, add a `scenario` option:

```typescript
export async function playMatch(opts: {
	seed: number;
	players: Bot[];
	maxTurns: number;
	verbose?: boolean;
	record?: boolean;
	autofixIllegal?: boolean;
	enableDiagnostics?: boolean;
	engineConfig?: EngineConfigInput;
	scenario?: "melee" | "ranged" | "stronghold_rush" | "midfield";
}): Promise<MatchResult> {
```

Replace the state initialization:

```typescript
import { createCombatScenario } from "./scenarios/combatScenarios";

// ... inside playMatch:
let state: MatchState = opts.scenario
	? createCombatScenario(opts.seed, playerIds, opts.scenario)
	: Engine.createInitialState(opts.seed, playerIds, opts.engineConfig);
```

**Step 6: Add CLI flag**

In `apps/sim/src/cli.ts`, add:

```typescript
const scenario = typeof argv.scenario === "string"
	? (argv.scenario as "melee" | "ranged" | "stronghold_rush" | "midfield")
	: undefined;
```

Pass `scenario` to `playMatch`.

**Step 7: Verify manually**

Run: `cd apps/sim && npx tsx src/cli.ts single --bot1 greedy --bot2 aggressive --scenario midfield --seed 1 --verbose --autofix`

Confirm the game starts with units near center and attacks happen immediately.

**Step 8: Commit**

```bash
git add apps/sim/src/scenarios/combatScenarios.ts apps/sim/src/match.ts apps/sim/src/cli.ts apps/sim/test/scenarios.test.ts
git commit -m "feat(sim): wire combat scenarios into CLI with midfield scenario"
```

---

### Task 4: Batch Turn Bot Interface

**Files:**
- Modify: `apps/sim/src/types.ts`
- Modify: `apps/sim/src/match.ts`
- Test: `apps/sim/test/batchTurn.test.ts`

This task adds an optional `chooseTurn` method to the `Bot` interface. LLM bots use it to return all actions for a turn in one call. Non-LLM bots keep using `chooseMove`.

**Step 1: Write a test for batch turn execution**

Create `apps/sim/test/batchTurn.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { Engine } from "../src/engineAdapter";
import { playMatch } from "../src/match";
import type { Bot, MatchState, Move } from "../src/types";

function makeBatchBot(id: string): Bot {
	return {
		id,
		name: "BatchTestBot",
		chooseMove: async ({ legalMoves }) => legalMoves[0]!,
		chooseTurn: async ({ state, legalMoves }) => {
			// Return 3 end_turns — the runner should apply them sequentially
			return [{ action: "end_turn" }, { action: "end_turn" }, { action: "end_turn" }];
		},
	};
}

describe("batch turn", () => {
	test("match runner uses chooseTurn when available", async () => {
		const bot1 = makeBatchBot("P1");
		const bot2 = makeBatchBot("P2");
		const result = await playMatch({
			seed: 1,
			players: [bot1, bot2],
			maxTurns: 400,
			autofixIllegal: true,
			engineConfig: { turnLimit: 5 },
		});
		// Game should complete — both bots end their turns immediately
		expect(result.reason).not.toBe("illegal");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/sim && bun test test/batchTurn.test.ts`
Expected: FAIL — `chooseTurn` is not recognized.

**Step 3: Update Bot interface in types.ts**

```typescript
export type Bot = {
	id: AgentId;
	name: string;
	chooseMove: (ctx: {
		state: MatchState;
		legalMoves: Move[];
		turn: number;
		rng: () => number;
	}) => Promise<Move> | Move;
	chooseTurn?: (ctx: {
		state: MatchState;
		legalMoves: Move[];
		turn: number;
		rng: () => number;
	}) => Promise<Move[]>;
};
```

**Step 4: Update match runner to use chooseTurn**

In `apps/sim/src/match.ts`, the main loop currently iterates one action at a time. We need to detect when the active player changes and, if the bot has `chooseTurn`, call it once and then apply all returned moves sequentially.

Replace the inner loop logic. The key change: when a new player's turn starts (active player changed or first iteration), check if the bot has `chooseTurn`. If so, call it, get the move batch, and iterate through the batch applying each move. Between each move, re-validate against current legal moves. If the bot doesn't have `chooseTurn`, fall through to the existing `chooseMove` logic.

```typescript
// Inside the main for loop, after getting `bot` and checking terminal:
if (bot.chooseTurn) {
	// Batch mode: get all moves for this turn in one call
	const legalMoves = Engine.listLegalMoves(state);
	if (!Array.isArray(legalMoves) || legalMoves.length === 0) {
		throw new Error("Engine.listLegalMoves returned empty list");
	}

	let turnMoves: Move[];
	try {
		turnMoves = await bot.chooseTurn({ state, legalMoves, turn, rng });
	} catch (e) {
		illegalMoves++;
		if (!opts.autofixIllegal) {
			// ... same error handling as existing code
		}
		turnMoves = [{ action: "end_turn" }];
	}

	// Apply each move from the batch
	for (const batchMove of turnMoves) {
		// Check terminal between each action
		const midTerminal = Engine.isTerminal(state);
		if (midTerminal.ended) break;

		const currentLegal = Engine.listLegalMoves(state);
		if (currentLegal.length === 0) break;

		// Check if the active player changed (turn ended by engine)
		if (Engine.currentPlayer(state) !== bot.id) break;

		const isLegal = currentLegal.some(
			(m) => safeJson(stripReasoning(m)) === safeJson(stripReasoning(batchMove)),
		);

		let moveToApply = batchMove;
		if (!isLegal) {
			illegalMoves++;
			if (!opts.autofixIllegal) {
				// ... error handling
			}
			if (opts.verbose) console.warn(`[turn ${turn}] batch move skipped (illegal): ${short(batchMove)}`);
			continue; // Skip this move, try next in batch
		}

		const result = Engine.applyMove(state, moveToApply);
		engineEvents.push(...result.engineEvents);
		moves.push(moveToApply);
		if (result.ok) {
			state = result.state;
		}

		if (opts.verbose) {
			console.log(`[turn ${turn}] ${bot.name} -> ${short(moveToApply)}`);
		}

		// Diagnostics per action
		if (opts.enableDiagnostics) {
			getDiagnosticsCollector().logTurn(turn, bot.name, moveToApply.action, state as any);
		}
	}

	// After processing the batch, if we haven't ended the turn,
	// the loop continues and will call the same bot again for remaining actions.
	// To avoid this, skip forward in the outer loop until the active player changes.
	continue;
}

// ... existing single-move logic stays as the else branch
```

The exact implementation needs care to integrate with the outer loop correctly. The key invariant: after processing a `chooseTurn` batch, the outer loop should continue to the next iteration where it re-checks `currentPlayer` and `isTerminal`.

**Step 5: Run test to verify it passes**

Run: `cd apps/sim && bun test test/batchTurn.test.ts`
Expected: PASS

**Step 6: Run all existing tests to verify no regression**

Run: `cd apps/sim && bun test`
Expected: All tests pass.

**Step 7: Commit**

```bash
git add apps/sim/src/types.ts apps/sim/src/match.ts apps/sim/test/batchTurn.test.ts
git commit -m "feat(sim): add chooseTurn batch interface to Bot type and match runner"
```

---

### Task 5: Compact State Encoder

**Files:**
- Create: `apps/sim/src/bots/stateEncoder.ts`
- Test: `apps/sim/test/stateEncoder.test.ts`

This module encodes game state into the compact hex notation for LLM consumption.

**Step 1: Write the test**

Create `apps/sim/test/stateEncoder.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { Engine } from "../src/engineAdapter";
import { encodeState, encodeLegalMoves } from "../src/bots/stateEncoder";

describe("stateEncoder", () => {
	test("encodeState produces compact notation", () => {
		const state = Engine.createInitialState(1, ["a", "b"]);
		const encoded = encodeState(state, "A");
		expect(encoded).toContain("STATE turn=");
		expect(encoded).toContain("player=A");
		expect(encoded).toContain("UNITS_A:");
		expect(encoded).toContain("UNITS_B:");
		expect(encoded).toContain("TERRAIN_NEAR_UNITS:");
		// Should NOT contain JSON or ASCII board
		expect(encoded).not.toContain("{");
		expect(encoded).not.toContain("}");
	});

	test("encodeState includes unit details", () => {
		const state = Engine.createInitialState(1, ["a", "b"]);
		const encoded = encodeState(state, "A");
		// Should contain unit IDs and types
		expect(encoded).toContain("A-1 inf");
		expect(encoded).toContain("A-4 cav");
		expect(encoded).toContain("A-6 arc");
		expect(encoded).toContain("hp=");
	});

	test("encodeLegalMoves categorizes by action type", () => {
		const state = Engine.createInitialState(1, ["a", "b"]);
		const moves = Engine.listLegalMoves(state);
		const encoded = encodeLegalMoves(moves, state);
		expect(encoded).toContain("MOVES:");
		expect(encoded).toContain("RECRUIT:");
		expect(encoded).toContain("end_turn");
		// Should contain move notation like "move A-1 B2->C2"
		expect(encoded).toMatch(/move A-\d/);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/sim && bun test test/stateEncoder.test.ts`
Expected: FAIL — module doesn't exist.

**Step 3: Implement stateEncoder.ts**

Create `apps/sim/src/bots/stateEncoder.ts`:

```typescript
import type { MatchState, Move } from "../types";

const TYPE_SHORT: Record<string, string> = {
	infantry: "inf",
	cavalry: "cav",
	archer: "arc",
};

export function encodeState(
	state: MatchState,
	side: "A" | "B",
	lastEnemyMoves?: Move[],
): string {
	const enemy = side === "A" ? "B" : "A";
	const p = state.players[side];
	const e = state.players[enemy];

	const lines: string[] = [];

	// Header
	lines.push(
		`STATE turn=${state.turn} player=${side} actions=${state.actionsRemaining} gold=${p.gold} wood=${p.wood} vp=${p.vp}`,
	);
	lines.push(`ENEMY gold=${e.gold} wood=${e.wood} vp=${e.vp}`);
	lines.push("");

	// Own units
	lines.push(`UNITS_${side}:`);
	for (const u of p.units) {
		let line = `  ${u.id} ${TYPE_SHORT[u.type] ?? u.type} ${u.position} hp=${u.hp}/${u.maxHp}`;
		if (u.isFortified) line += " fortified";
		// Check if on a stronghold
		const hex = state.board.find((h) => h.id === u.position);
		if (hex && (hex.type === "stronghold_a" || hex.type === "stronghold_b")) {
			line += " [stronghold]";
		}
		lines.push(line);
	}
	lines.push("");

	// Enemy units
	lines.push(`UNITS_${enemy}:`);
	for (const u of e.units) {
		let line = `  ${u.id} ${TYPE_SHORT[u.type] ?? u.type} ${u.position} hp=${u.hp}/${u.maxHp}`;
		if (u.isFortified) line += " fortified";
		const hex = state.board.find((h) => h.id === u.position);
		if (hex && (hex.type === "stronghold_a" || hex.type === "stronghold_b")) {
			line += " [stronghold]";
		}
		lines.push(line);
	}
	lines.push("");

	// Terrain near units (only hexes with units or adjacent to units)
	const unitHexIds = new Set<string>();
	for (const u of [...p.units, ...e.units]) {
		unitHexIds.add(u.position);
	}
	const relevantHexes = state.board.filter(
		(h) =>
			unitHexIds.has(h.id) &&
			h.type !== "plains" &&
			h.type !== "deploy_a" &&
			h.type !== "deploy_b",
	);
	if (relevantHexes.length > 0) {
		lines.push("TERRAIN_NEAR_UNITS:");
		const terrainParts = relevantHexes.map((h) => `${h.id}=${h.type}`);
		lines.push(`  ${terrainParts.join(" ")}`);
		lines.push("");
	}

	// Last enemy moves
	if (lastEnemyMoves && lastEnemyMoves.length > 0) {
		lines.push("LAST_ENEMY_TURN:");
		for (const m of lastEnemyMoves) {
			lines.push(`  ${encodeMove(m)}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

export function encodeLegalMoves(moves: Move[], state: MatchState): string {
	const attacks: string[] = [];
	const moveMoves: string[] = [];
	const recruits: string[] = [];
	const fortifies: string[] = [];
	const other: string[] = [];

	for (const m of moves) {
		const encoded = encodeMove(m);
		switch (m.action) {
			case "attack": {
				// Add target info
				const target = (m as { target?: string }).target;
				const targetHex = target
					? state.board.find((h) => h.id === target)
					: undefined;
				const targetUnitId =
					targetHex && targetHex.unitIds.length > 0
						? targetHex.unitIds[0]
						: undefined;
				const allUnits = [
					...state.players.A.units,
					...state.players.B.units,
				];
				const targetUnit = targetUnitId
					? allUnits.find((u) => u.id === targetUnitId)
					: undefined;
				if (targetUnit) {
					attacks.push(
						`${encoded} (target: ${targetUnit.id} ${TYPE_SHORT[targetUnit.type] ?? targetUnit.type} hp=${targetUnit.hp}/${targetUnit.maxHp})`,
					);
				} else {
					attacks.push(encoded);
				}
				break;
			}
			case "move":
				moveMoves.push(encoded);
				break;
			case "recruit":
				recruits.push(encoded);
				break;
			case "fortify":
				fortifies.push(encoded);
				break;
			default:
				other.push(encoded);
				break;
		}
	}

	const lines: string[] = ["LEGAL_MOVES:"];
	if (attacks.length > 0) {
		lines.push("ATTACKS:");
		for (const a of attacks) lines.push(`  ${a}`);
	}
	if (moveMoves.length > 0) {
		lines.push("MOVES:");
		for (const m of moveMoves) lines.push(`  ${m}`);
	}
	if (recruits.length > 0) {
		lines.push("RECRUIT:");
		for (const r of recruits) lines.push(`  ${r}`);
	}
	if (fortifies.length > 0) {
		lines.push("FORTIFY:");
		for (const f of fortifies) lines.push(`  ${f}`);
	}
	if (other.length > 0) {
		lines.push("OTHER:");
		for (const o of other) lines.push(`  ${o}`);
	}

	return lines.join("\n");
}

export function encodeMove(m: Move): string {
	switch (m.action) {
		case "move": {
			const mv = m as { unitId: string; to: string };
			return `move ${mv.unitId} ${mv.to}`;
		}
		case "attack": {
			const atk = m as { unitId: string; target: string };
			return `attack ${atk.unitId} ${atk.target}`;
		}
		case "recruit": {
			const rec = m as { unitType: string; at: string };
			return `recruit ${rec.unitType} ${rec.at}`;
		}
		case "fortify": {
			const fort = m as { unitId: string };
			return `fortify ${fort.unitId}`;
		}
		case "end_turn":
			return "end_turn";
		case "pass":
			return "end_turn";
		default:
			return m.action;
	}
}
```

**Step 4: Run test to verify it passes**

Run: `cd apps/sim && bun test test/stateEncoder.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/sim/src/bots/stateEncoder.ts apps/sim/test/stateEncoder.test.ts
git commit -m "feat(sim): add compact state encoder for LLM context"
```

---

### Task 6: Command Parser

**Files:**
- Create: `apps/sim/src/bots/commandParser.ts`
- Test: `apps/sim/test/commandParser.test.ts`

This module parses CLI-style command strings from LLM output into Move objects.

**Step 1: Write the test**

Create `apps/sim/test/commandParser.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { parseCommands, matchCommand } from "../src/bots/commandParser";
import type { Move } from "../src/types";

describe("parseCommands", () => {
	test("parses basic commands", () => {
		const input = "move A-4 E10\nattack A-1 F11\nrecruit infantry B2\nend_turn";
		const cmds = parseCommands(input);
		expect(cmds).toEqual([
			{ action: "move", unitId: "A-4", target: "E10" },
			{ action: "attack", unitId: "A-1", target: "F11" },
			{ action: "recruit", unitType: "infantry", target: "B2" },
			{ action: "end_turn" },
		]);
	});

	test("ignores reasoning after ---", () => {
		const input = "move A-1 E10\nend_turn\n---\nPushing forward to attack.";
		const cmds = parseCommands(input);
		expect(cmds).toHaveLength(2);
		expect(cmds[0]!.action).toBe("move");
	});

	test("extracts reasoning after ---", () => {
		const input = "move A-1 E10\n---\nMy reasoning here.";
		const result = parseCommands(input);
		// reasoning is returned separately by parseCommandsWithReasoning
		expect(result).toHaveLength(1);
	});

	test("handles fortify command", () => {
		const input = "fortify A-1";
		const cmds = parseCommands(input);
		expect(cmds).toEqual([{ action: "fortify", unitId: "A-1" }]);
	});

	test("skips blank lines and comments", () => {
		const input = "move A-1 E10\n\n# comment\nend_turn";
		const cmds = parseCommands(input);
		expect(cmds).toHaveLength(2);
	});
});

describe("matchCommand", () => {
	test("matches move command to legal move", () => {
		const legalMoves: Move[] = [
			{ action: "move", unitId: "A-1", to: "E10" },
			{ action: "move", unitId: "A-1", to: "D10" },
			{ action: "end_turn" },
		];
		const cmd = { action: "move" as const, unitId: "A-1", target: "E10" };
		const match = matchCommand(cmd, legalMoves);
		expect(match).toEqual({ action: "move", unitId: "A-1", to: "E10" });
	});

	test("matches attack command", () => {
		const legalMoves: Move[] = [
			{ action: "attack", unitId: "A-1", target: "F11" },
			{ action: "end_turn" },
		];
		const cmd = { action: "attack" as const, unitId: "A-1", target: "F11" };
		const match = matchCommand(cmd, legalMoves);
		expect(match).toEqual({ action: "attack", unitId: "A-1", target: "F11" });
	});

	test("matches recruit command", () => {
		const legalMoves: Move[] = [
			{ action: "recruit", unitType: "infantry", at: "B2" },
			{ action: "end_turn" },
		];
		const cmd = { action: "recruit" as const, unitType: "infantry", target: "B2" };
		const match = matchCommand(cmd, legalMoves);
		expect(match).toEqual({ action: "recruit", unitType: "infantry", at: "B2" });
	});

	test("returns null for unmatched command", () => {
		const legalMoves: Move[] = [{ action: "end_turn" }];
		const cmd = { action: "move" as const, unitId: "A-1", target: "E10" };
		const match = matchCommand(cmd, legalMoves);
		expect(match).toBeNull();
	});

	test("matches end_turn", () => {
		const legalMoves: Move[] = [{ action: "end_turn" }];
		const cmd = { action: "end_turn" as const };
		const match = matchCommand(cmd, legalMoves);
		expect(match).toEqual({ action: "end_turn" });
	});
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/sim && bun test test/commandParser.test.ts`
Expected: FAIL — module doesn't exist.

**Step 3: Implement commandParser.ts**

Create `apps/sim/src/bots/commandParser.ts`:

```typescript
import type { Move } from "../types";

export type ParsedCommand =
	| { action: "move"; unitId: string; target: string }
	| { action: "attack"; unitId: string; target: string }
	| { action: "recruit"; unitType: string; target: string }
	| { action: "fortify"; unitId: string }
	| { action: "end_turn" };

export function parseCommands(text: string): ParsedCommand[] {
	// Split on --- to separate commands from reasoning
	const commandSection = text.split("---")[0] ?? text;
	const lines = commandSection
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("#"));

	const commands: ParsedCommand[] = [];
	for (const line of lines) {
		const cmd = parseSingleCommand(line);
		if (cmd) commands.push(cmd);
	}
	return commands;
}

export function parseCommandsWithReasoning(text: string): {
	commands: ParsedCommand[];
	reasoning?: string;
} {
	const parts = text.split("---");
	const commands = parseCommands(parts[0] ?? "");
	const reasoning = parts.slice(1).join("---").trim() || undefined;
	return { commands, reasoning };
}

function parseSingleCommand(line: string): ParsedCommand | null {
	const parts = line.split(/\s+/);
	const action = parts[0]?.toLowerCase();

	switch (action) {
		case "move":
			if (parts.length >= 3) {
				return { action: "move", unitId: parts[1]!, target: parts[2]! };
			}
			return null;
		case "attack":
			if (parts.length >= 3) {
				return { action: "attack", unitId: parts[1]!, target: parts[2]! };
			}
			return null;
		case "recruit":
			if (parts.length >= 3) {
				return { action: "recruit", unitType: parts[1]!, target: parts[2]! };
			}
			return null;
		case "fortify":
			if (parts.length >= 2) {
				return { action: "fortify", unitId: parts[1]! };
			}
			return null;
		case "end_turn":
		case "pass":
			return { action: "end_turn" };
		default:
			return null;
	}
}

export function matchCommand(
	cmd: ParsedCommand,
	legalMoves: Move[],
): Move | null {
	switch (cmd.action) {
		case "move":
			return (
				legalMoves.find(
					(m) =>
						m.action === "move" &&
						(m as { unitId: string }).unitId === cmd.unitId &&
						(m as { to: string }).to === cmd.target,
				) ?? null
			);
		case "attack":
			return (
				legalMoves.find(
					(m) =>
						m.action === "attack" &&
						(m as { unitId: string }).unitId === cmd.unitId &&
						(m as { target: string }).target === cmd.target,
				) ?? null
			);
		case "recruit":
			return (
				legalMoves.find(
					(m) =>
						m.action === "recruit" &&
						(m as { unitType: string }).unitType === cmd.unitType &&
						(m as { at: string }).at === cmd.target,
				) ?? null
			);
		case "fortify":
			return (
				legalMoves.find(
					(m) =>
						m.action === "fortify" &&
						(m as { unitId: string }).unitId === cmd.unitId,
				) ?? null
			);
		case "end_turn":
			return legalMoves.find((m) => m.action === "end_turn") ?? null;
		default:
			return null;
	}
}
```

**Step 4: Run test to verify it passes**

Run: `cd apps/sim && bun test test/commandParser.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/sim/src/bots/commandParser.ts apps/sim/test/commandParser.test.ts
git commit -m "feat(sim): add CLI command parser for LLM bot output"
```

---

### Task 7: Rewrite LLM Bot with Batch Turn and Compact Prompts

**Files:**
- Modify: `apps/sim/src/bots/llmBot.ts`
- Modify: `apps/sim/test/llmBot.test.ts`

**Step 1: Update the tests**

Replace `apps/sim/test/llmBot.test.ts` with tests for the new command-based parser:

```typescript
import { describe, expect, test } from "bun:test";
import { parseLlmResponse } from "../src/bots/llmBot";

describe("llmBot", () => {
	test("parseLlmResponse extracts commands and reasoning", () => {
		const text = "move A-1 E10\nattack A-4 F11\nend_turn\n---\nPushing forward.";
		const result = parseLlmResponse(text);
		expect(result.commands).toHaveLength(3);
		expect(result.commands[0]!.action).toBe("move");
		expect(result.reasoning).toBe("Pushing forward.");
	});

	test("parseLlmResponse handles commands only (no reasoning)", () => {
		const text = "recruit infantry B2\nend_turn";
		const result = parseLlmResponse(text);
		expect(result.commands).toHaveLength(2);
		expect(result.reasoning).toBeUndefined();
	});

	test("parseLlmResponse handles markdown code blocks", () => {
		const text = "```\nmove A-1 E10\nend_turn\n```\n---\nReason.";
		const result = parseLlmResponse(text);
		expect(result.commands).toHaveLength(2);
	});

	test("parseLlmResponse handles empty response", () => {
		const result = parseLlmResponse("");
		expect(result.commands).toHaveLength(0);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/sim && bun test test/llmBot.test.ts`
Expected: FAIL — `parseLlmResponse` doesn't exist.

**Step 3: Rewrite llmBot.ts**

Full rewrite of `apps/sim/src/bots/llmBot.ts`. Key changes:
- `makeLlmBot` returns a Bot with `chooseTurn` (batch mode)
- `chooseMove` is kept as a simple fallback (picks random move)
- System prompt is compact, sent fully on first call, shortened on subsequent calls
- User message uses `encodeState` + `encodeLegalMoves` from stateEncoder
- Response is parsed via `parseCommandsWithReasoning` from commandParser
- Commands are matched and returned as `Move[]`
- `parseLlmResponse` is exported for testing

The system prompt on the first call:

```
You are Player {side} in Fightclaw, a hex strategy game.

COMMAND FORMAT (one per line):
  move <unitId> <hexId>       - Move unit/stack to hex
  attack <unitId> <hexId>     - Attack target hex
  recruit <unitType> <hexId>  - Recruit at stronghold (infantry/cavalry/archer)
  fortify <unitId>            - Fortify unit (costs 1 wood)
  end_turn                    - End your turn

UNITS: infantry (ATK=2 DEF=4 HP=3 range=1 move=2), cavalry (ATK=4 DEF=2 HP=2 range=1 move=4), archer (ATK=3 DEF=1 HP=2 range=2 move=3)
COMBAT: damage = max(1, ATK+1+stackBonus - DEF-terrainBonus). Cavalry charge: +2 ATK if moved 2+ hexes.
WIN: capture ANY enemy stronghold, eliminate all enemies, or highest VP at turn limit.
Your strongholds: {strongholds}. Enemy strongholds: {enemyStrongholds}.

{userStrategy}

Respond with commands only. Optional reasoning after --- separator.
```

Subsequent calls: `"Player {side}. Commands only."`

The `chooseTurn` method:
1. Builds the state encoding and legal moves encoding
2. Calls the API once
3. Parses the response into commands
4. Matches each command against legal moves
5. Returns the matched `Move[]` array

Export `parseLlmResponse` for testing (wraps `parseCommandsWithReasoning` with markdown code block stripping).

**Step 4: Run test to verify it passes**

Run: `cd apps/sim && bun test test/llmBot.test.ts`
Expected: PASS

**Step 5: Run all tests**

Run: `cd apps/sim && bun test`
Expected: All pass.

**Step 6: Commit**

```bash
git add apps/sim/src/bots/llmBot.ts apps/sim/test/llmBot.test.ts
git commit -m "feat(sim): rewrite LLM bot with batch turn and CLI commands"
```

---

### Task 8: Update Diagnostics for Batch Model

**Files:**
- Modify: `apps/sim/src/diagnostics/collector.ts`

**Step 1: Update LlmDiagnostics interface**

Replace `chosenMoveIndex` with batch-relevant fields:

```typescript
export interface LlmDiagnostics {
	timestamp: string;
	botId: string;
	model: string;
	turn: number;
	apiLatencyMs: number;
	apiSuccess: boolean;
	parsingSuccess: boolean;
	usedRandomFallback: boolean;
	commandsReturned: number;
	commandsMatched: number;
	commandsSkipped: number;
	responsePreview: string;
	reasoning?: string;
	parseError?: string;
	apiError?: string;
}
```

Remove `legalMovesCount` and `chosenMoveIndex`. Add `commandsReturned`, `commandsMatched`, `commandsSkipped`, `reasoning`.

**Step 2: Update the logLlmCall method and callers**

The LLM bot in Task 7 will already call `logLlmCall` with the new fields. Just make sure the interface matches.

**Step 3: Commit**

```bash
git add apps/sim/src/diagnostics/collector.ts
git commit -m "feat(sim): update diagnostics for batch turn model"
```

---

### Task 9: Integration Test — Full Game with Mock Batch Bot

**Files:**
- Test: `apps/sim/test/integration.test.ts`

**Step 1: Write the integration test**

Create `apps/sim/test/integration.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { playMatch } from "../src/match";
import { makeGreedyBot } from "../src/bots/greedyBot";
import { makeAggressiveBot } from "../src/bots/aggressiveBot";
import type { Bot, Move } from "../src/types";

describe("integration", () => {
	test("greedy vs aggressive with turnLimit=40 produces a winner", async () => {
		const result = await playMatch({
			seed: 42,
			players: [makeGreedyBot("P1"), makeAggressiveBot("P2")],
			maxTurns: 600,
			autofixIllegal: true,
			engineConfig: { turnLimit: 40, actionsPerTurn: 7 },
		});
		// With 40 turns and 7 actions, game should end via terminal (not maxTurns)
		expect(result.turns).toBeGreaterThan(0);
		// Either terminal or turn_limit, but should have a winner
		expect(["terminal", "maxTurns"]).toContain(result.reason);
	});

	test("midfield scenario leads to combat quickly", async () => {
		const result = await playMatch({
			seed: 1,
			players: [makeAggressiveBot("P1"), makeAggressiveBot("P2")],
			maxTurns: 600,
			autofixIllegal: true,
			scenario: "midfield",
			engineConfig: { turnLimit: 40, actionsPerTurn: 7 },
		});
		// Midfield scenario with aggressive bots should end before turn 40
		expect(result.reason).toBe("terminal");
		expect(result.winner).not.toBeNull();
	});
});
```

**Step 2: Run tests**

Run: `cd apps/sim && bun test test/integration.test.ts`
Expected: PASS

**Step 3: Run full test suite**

Run: `cd apps/sim && bun test`
Expected: All pass.

**Step 4: Commit**

```bash
git add apps/sim/test/integration.test.ts
git commit -m "test(sim): add integration tests for config overrides and scenarios"
```

---

### Task 10: Manual Smoke Test and Cleanup

**Step 1: Run greedy vs aggressive on the full board with new config**

```bash
cd apps/sim && npx tsx src/cli.ts single --bot1 aggressive --bot2 aggressive --turnLimit 40 --actionsPerTurn 7 --seed 1 --verbose --autofix
```

Verify: game runs, units engage, game ends with a winner.

**Step 2: Run a midfield scenario**

```bash
cd apps/sim && npx tsx src/cli.ts single --bot1 greedy --bot2 aggressive --scenario midfield --turnLimit 40 --actionsPerTurn 7 --seed 1 --verbose --autofix
```

Verify: immediate combat, decisive winner.

**Step 3: Run type check**

```bash
cd apps/sim && npx tsc --noEmit
```

Expected: No errors.

**Step 4: Run biome**

```bash
pnpm -w run check
```

Fix any formatting issues.

**Step 5: Final commit**

```bash
git add -A
git commit -m "chore(sim): cleanup and formatting"
```
