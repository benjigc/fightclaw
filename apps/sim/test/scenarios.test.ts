import { describe, expect, test } from "bun:test";
import { Engine } from "../src/engineAdapter";
import { createCombatScenario } from "../src/scenarios/combatScenarios";

describe("combat scenarios", () => {
	test("midfield scenario places units near center", () => {
		const state = createCombatScenario(1, ["a", "b"], "midfield");
		const aUnits = state.players.A.units;
		const bUnits = state.players.B.units;
		expect(aUnits.length).toBeGreaterThan(0);
		expect(bUnits.length).toBeGreaterThan(0);
		// All units should be in columns 7-15 (center area)
		for (const u of [...aUnits, ...bUnits]) {
			const col = Number.parseInt(u.position.slice(1), 10);
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
