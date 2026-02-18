import { describe, expect, test } from "bun:test";
import { applyLoopPressurePolicy, parseLlmResponse } from "../src/bots/llmBot";
import { Engine } from "../src/engineAdapter";
import { createCombatScenario } from "../src/scenarios/combatScenarios";
import type { Move } from "../src/types";

describe("llmBot", () => {
	test("parseLlmResponse extracts commands and reasoning", () => {
		const text =
			"move A-1 E10\nattack A-4 F11\nend_turn\n---\nPushing forward.";
		const result = parseLlmResponse(text);
		expect(result.commands).toHaveLength(3);
		expect(result.commands[0]?.action).toBe("move");
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

	test("parseLlmResponse handles pass as end_turn", () => {
		const result = parseLlmResponse("pass");
		expect(result.commands).toHaveLength(1);
		expect(result.commands[0]?.action).toBe("end_turn");
	});

	test("loop pressure replaces recruit/fortify loop with attack", () => {
		const state = createCombatScenario(1, ["P1", "P2"], "midfield");
		const legalMoves = Engine.listLegalMoves(state);
		const lowImpact =
			legalMoves.find((move) => move.action === "recruit") ??
			legalMoves.find((move) => move.action === "fortify");
		expect(lowImpact).toBeTruthy();
		if (!lowImpact) {
			throw new Error("expected recruit or fortify legal move");
		}

		const adjusted = applyLoopPressurePolicy(
			[lowImpact, { action: "end_turn" }],
			{
				state,
				side: "A",
				legalMoves,
				turn: 32,
				loopState: {
					noAttackStreak: 3,
					noProgressStreak: 3,
					recruitStreak: 2,
				},
			},
		);

		expect(adjusted[0]?.action).toBe("attack");
		expect(adjusted[1]?.action).toBe("end_turn");
	});

	test("loop pressure avoids forcing clearly bad attacks when objective move exists", () => {
		const state = createCombatScenario(2, ["P1", "P2"], "midfield");
		let legalMoves = Engine.listLegalMoves(state);
		const attack = legalMoves.find(
			(move): move is Extract<Move, { action: "attack" }> =>
				move.action === "attack",
		);
		expect(attack).toBeTruthy();
		if (!attack) return;

		const attacker = state.players.A.units.find((u) => u.id === attack.unitId);
		expect(attacker).toBeTruthy();
		if (!attacker) return;

		for (const unit of state.players.A.units) {
			unit.hp = Math.min(unit.hp, 1);
		}
		for (const unit of state.players.B.units) {
			unit.hp = unit.maxHp;
			unit.isFortified = true;
		}
		legalMoves = Engine.listLegalMoves(state);

		const lowImpact =
			legalMoves.find((move) => move.action === "recruit") ??
			legalMoves.find((move) => move.action === "fortify");
		expect(lowImpact).toBeTruthy();
		if (!lowImpact) {
			throw new Error("expected recruit or fortify legal move");
		}

		const adjusted = applyLoopPressurePolicy(
			[lowImpact, { action: "end_turn" }],
			{
				state,
				side: "A",
				legalMoves,
				turn: 40,
				loopState: {
					noAttackStreak: 2,
					noProgressStreak: 3,
					recruitStreak: 2,
				},
			},
		);

		expect(adjusted[0]?.action).toBe("move");
		expect(adjusted.some((move) => move.action === "attack")).toBe(false);
	});

	test("late-game pressure pushes combat with mild stall signals", () => {
		const state = createCombatScenario(3, ["P1", "P2"], "midfield");
		const legalMoves = Engine.listLegalMoves(state);
		const lowImpact =
			legalMoves.find((move) => move.action === "recruit") ??
			legalMoves.find((move) => move.action === "fortify");
		expect(lowImpact).toBeTruthy();
		if (!lowImpact) {
			throw new Error("expected recruit or fortify legal move");
		}

		const adjusted = applyLoopPressurePolicy(
			[lowImpact, { action: "end_turn" }],
			{
				state,
				side: "A",
				legalMoves,
				turn: 72,
				loopState: {
					noAttackStreak: 1,
					noProgressStreak: 0,
					recruitStreak: 1,
				},
			},
		);

		expect(adjusted[0]?.action).toBe("attack");
		expect(adjusted[1]?.action).toBe("end_turn");
	});

	test("loop pressure keeps existing attack plan unchanged", () => {
		const state = createCombatScenario(4, ["P1", "P2"], "midfield");
		const legalMoves = Engine.listLegalMoves(state);
		const attack = legalMoves.find(
			(move): move is Extract<Move, { action: "attack" }> =>
				move.action === "attack",
		);
		expect(attack).toBeTruthy();
		if (!attack) return;

		const adjusted = applyLoopPressurePolicy([attack, { action: "end_turn" }], {
			state,
			side: "A",
			legalMoves,
			turn: 88,
			loopState: {
				noAttackStreak: 4,
				noProgressStreak: 4,
				recruitStreak: 2,
			},
		});

		expect(adjusted[0]).toEqual(attack);
		expect(adjusted[1]?.action).toBe("end_turn");
	});
});
