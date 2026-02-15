import { describe, expect, test } from "bun:test";
import { encodeLegalMoves, encodeState } from "../src/bots/stateEncoder";
import { Engine } from "../src/engineAdapter";

describe("stateEncoder", () => {
	test("encodeState produces compact notation", () => {
		const state = Engine.createInitialState(1, ["a", "b"]);
		const encoded = encodeState(state, "A");
		expect(encoded).toContain("STATE turn=");
		expect(encoded).toContain("player=A");
		expect(encoded).toContain("UNITS_A:");
		expect(encoded).toContain("UNITS_B:");
		// Should NOT contain raw JSON braces
		expect(encoded).not.toContain("{");
		expect(encoded).not.toContain("}");
	});

	test("encodeState includes unit details", () => {
		const state = Engine.createInitialState(1, ["a", "b"]);
		const encoded = encodeState(state, "A");
		expect(encoded).toContain("A-1 inf");
		expect(encoded).toContain("A-4 cav");
		expect(encoded).toContain("A-6 arc");
		expect(encoded).toContain("hp=");
	});

	test("encodeState shows stronghold terrain for units on strongholds", () => {
		const state = Engine.createInitialState(1, ["a", "b"]);
		const encoded = encodeState(state, "A");
		// A-1 starts on B2 which is stronghold_a
		expect(encoded).toContain("[stronghold]");
	});

	test("encodeState includes last enemy moves when provided", () => {
		const state = Engine.createInitialState(1, ["a", "b"]);
		const lastMoves = [
			{ action: "move" as const, unitId: "B-1", to: "B19" },
			{ action: "end_turn" as const },
		];
		const encoded = encodeState(state, "A", lastMoves);
		expect(encoded).toContain("LAST_ENEMY_TURN:");
		expect(encoded).toContain("move B-1 B19");
		expect(encoded).toContain("end_turn");
	});

	test("encodeLegalMoves categorizes by action type", () => {
		// Move A-1 off stronghold B2 so recruit becomes available
		let state = Engine.createInitialState(1, ["a", "b"]);
		const moveOff = { action: "move" as const, unitId: "A-1", to: "A1" };
		const result = Engine.applyMove(state, moveOff);
		if (!("ok" in result) || !result.ok) {
			throw new Error("Setup move failed");
		}
		state = result.state;
		const moves = Engine.listLegalMoves(state);
		const encoded = encodeLegalMoves(moves, state);
		expect(encoded).toContain("MOVES:");
		expect(encoded).toContain("RECRUIT:");
		expect(encoded).toContain("end_turn");
		// Should contain move notation
		expect(encoded).toMatch(/move A-\d/);
	});

	test("encodeLegalMoves shows attack targets when available", () => {
		// Use midfield scenario to get attack moves
		const {
			createCombatScenario,
		} = require("../src/scenarios/combatScenarios");
		const state = createCombatScenario(1, ["a", "b"], "midfield");
		const moves = Engine.listLegalMoves(state);
		const encoded = encodeLegalMoves(moves, state);
		expect(encoded).toContain("ATTACKS:");
		expect(encoded).toContain("target:");
	});
});
