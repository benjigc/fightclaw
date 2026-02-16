import { describe, expect, test } from "bun:test";
import { playMatch } from "../src/match";
import type { Bot, Move } from "../src/types";

describe("boardgameio turn boundary", () => {
	test("calls chooseTurn once per engine turn", async () => {
		let calls = 0;
		const makeCounterBot = (id: string): Bot => ({
			id,
			name: `Counter_${id}`,
			chooseMove: ({ legalMoves, rng }) =>
				legalMoves[Math.floor(rng() * legalMoves.length)] as Move,
			chooseTurn: async () => {
				calls++;
				return [{ action: "end_turn" }];
			},
		});

		const result = await playMatch({
			seed: 5,
			players: [makeCounterBot("P1"), makeCounterBot("P2")],
			maxTurns: 12,
			harness: "boardgameio",
			strict: true,
		});

		expect(result.turns).toBeGreaterThan(0);
		expect(calls).toBe(result.turns);
	});
});
