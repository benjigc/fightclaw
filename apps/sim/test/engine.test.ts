import { describe, expect, test } from "bun:test";
import {
	applyMove,
	createInitialState,
	currentPlayer,
	listLegalMoves,
	type Move,
	MoveSchema,
} from "@fightclaw/engine";
import { Engine } from "../src/engineAdapter";

const players = ["agent-a", "agent-b"] as const;

function applyMoves(seed: number, moves: Move[]) {
	let state = createInitialState(seed, undefined, [...players]);
	for (const move of moves) {
		const result = applyMove(state, move);
		if (!result.ok) throw new Error(result.error);
		state = result.state;
	}
	return state;
}

describe("engine", () => {
	test("Move schema validates known moves", () => {
		expect(MoveSchema.safeParse({ action: "pass" }).success).toBe(true);
		expect(MoveSchema.safeParse({ action: "nope" }).success).toBe(false);
	});

	test("turn order enforcement via currentPlayer", () => {
		let state = createInitialState(1, undefined, [...players]);
		const first = currentPlayer(state);
		const result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		state = result.state;
		const second = currentPlayer(state);
		expect(second).not.toBe(first);
	});

	test("listLegalMoves includes end_turn", () => {
		const state = createInitialState(1, undefined, [...players]);
		const legal = listLegalMoves(state).map((m) => m.action);
		expect(legal).toContain("end_turn");
	});

	test("determinism with same seed", () => {
		const moves: Move[] = [
			{ action: "end_turn" },
			{ action: "end_turn" },
			{ action: "end_turn" },
		];
		const a = applyMoves(42, moves);
		const b = applyMoves(42, moves);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	test("createInitialState accepts config overrides", () => {
		const state = Engine.createInitialState(1, ["a", "b"], {
			turnLimit: 40,
			actionsPerTurn: 7,
		});
		expect(state.actionsRemaining).toBe(7);
	});
});
