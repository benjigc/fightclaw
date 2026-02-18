import { describe, expect, test } from "bun:test";
import { makeAggressiveBot } from "../src/bots/aggressiveBot";
import { makeGreedyBot } from "../src/bots/greedyBot";
import { playMatch } from "../src/match";
import type { Bot, Move } from "../src/types";

describe("integration", () => {
	test("greedy vs aggressive with turnLimit=40 completes", async () => {
		const result = await playMatch({
			seed: 42,
			players: [makeGreedyBot("P1"), makeAggressiveBot("P2")],
			maxTurns: 600,
			autofixIllegal: true,
			engineConfig: { turnLimit: 40, actionsPerTurn: 7 },
		});
		expect(result.turns).toBeGreaterThan(0);
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
		// Midfield scenario with aggressive bots should end via terminal
		expect(result.reason).toBe("terminal");
		expect(result.winner).not.toBeNull();
	});

	test("batch turn bot completes a game", async () => {
		// Create a simple batch bot that always attacks if possible, otherwise moves, otherwise ends turn
		const makeBatchAttackBot = (id: string): Bot => ({
			id,
			name: "BatchAttackBot",
			chooseMove: ({ legalMoves, rng }) => {
				if (legalMoves.length === 0) {
					return { action: "end_turn" };
				}
				return legalMoves[Math.floor(rng() * legalMoves.length)] as Move;
			},
			chooseTurn: async ({ legalMoves }) => {
				const attacks = legalMoves.filter((m) => m.action === "attack");
				const moves = legalMoves.filter((m) => m.action === "move");
				const result: Move[] = [];

				// Prioritize attacks, then moves, then end turn
				for (const atk of attacks) {
					result.push(atk);
				}
				for (const mv of moves.slice(0, 3)) {
					result.push(mv);
				}
				result.push({ action: "end_turn" });
				return result;
			},
		});

		const result = await playMatch({
			seed: 7,
			players: [makeBatchAttackBot("P1"), makeBatchAttackBot("P2")],
			maxTurns: 600,
			autofixIllegal: true,
			scenario: "midfield",
			engineConfig: { turnLimit: 40, actionsPerTurn: 7 },
		});

		expect(result.turns).toBeGreaterThan(0);
		expect(["terminal", "maxTurns"]).toContain(result.reason);
	});
});
