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

	test("all_infantry scenario uses infantry-only armies", () => {
		const state = createCombatScenario(1, ["a", "b"], "all_infantry");
		expect(state.players.A.units).toHaveLength(6);
		expect(state.players.B.units).toHaveLength(6);
		expect(state.players.A.units.every((u) => u.type === "infantry")).toBe(
			true,
		);
		expect(state.players.B.units.every((u) => u.type === "infantry")).toBe(
			true,
		);
	});

	test("cavalry_archer scenario applies asymmetrical composition", () => {
		const state = createCombatScenario(1, ["a", "b"], "cavalry_archer");
		expect(state.players.A.units.every((u) => u.type === "cavalry")).toBe(true);
		expect(state.players.B.units.every((u) => u.type === "archer")).toBe(true);
	});

	test("high_ground_clash scenario positions both teams around high ground", () => {
		const state = createCombatScenario(1, ["a", "b"], "high_ground_clash");
		const highGround = new Set(
			state.board.filter((h) => h.type === "high_ground").map((h) => h.id),
		);
		const nearHighGround = [
			...state.players.A.units,
			...state.players.B.units,
		].some(
			(u) =>
				highGround.has(u.position) ||
				u.position === "D10" ||
				u.position === "D12" ||
				u.position === "E10" ||
				u.position === "E12" ||
				u.position === "F12",
		);
		expect(nearHighGround).toBe(true);
	});

	test("resource_race scenario starts units on economy-heavy terrain", () => {
		const state = createCombatScenario(1, ["a", "b"], "resource_race");
		const byHex = new Map(state.board.map((hex) => [hex.id, hex.type]));
		const terrainTypes = [
			byHex.get(state.players.A.units[0]?.position ?? ""),
			byHex.get(state.players.A.units[1]?.position ?? ""),
			byHex.get(state.players.B.units[0]?.position ?? ""),
			byHex.get(state.players.B.units[1]?.position ?? ""),
		];
		expect(
			terrainTypes.some((t) => t === "gold_mine" || t === "lumber_camp"),
		).toBe(true);
	});
});
