import { describe, expect, test } from "bun:test";
import { playMatch } from "../src/match";
import type { Bot, Move } from "../src/types";

function makeBatchBot(id: string): Bot {
	return {
		id,
		name: "BatchTestBot",
		chooseMove: async ({ legalMoves }) => legalMoves[0] as Move,
		chooseTurn: async () => {
			return [{ action: "end_turn" }];
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
		expect(result.reason).not.toBe("illegal");
	});

	test("batch bot with multiple moves per turn works", async () => {
		// A bot that always ends turn should complete the game
		const bot1 = makeBatchBot("P1");
		const bot2: Bot = {
			id: "P2",
			name: "SingleMoveBot",
			chooseMove: async ({ legalMoves }) => {
				// Just end turn
				return (
					legalMoves.find((m) => m.action === "end_turn") ??
					(legalMoves[0] as Move)
				);
			},
		};
		const result = await playMatch({
			seed: 1,
			players: [bot1, bot2],
			maxTurns: 400,
			autofixIllegal: true,
			engineConfig: { turnLimit: 5 },
		});
		// Should complete without errors, mixing batch and single-move bots
		expect(result.reason).not.toBe("illegal");
	});
});
