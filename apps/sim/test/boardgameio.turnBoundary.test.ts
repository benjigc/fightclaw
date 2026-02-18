import { describe, expect, test } from "bun:test";
import { Engine } from "../src/engineAdapter";
import { playMatch } from "../src/match";
import type { Bot, Move } from "../src/types";

function makeEndTurnBot(id: string): Bot {
	return {
		id,
		name: `End_${id}`,
		chooseMove: ({ legalMoves }) => legalMoves[0] as Move,
		chooseTurn: async () => [{ action: "end_turn" }],
	};
}

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

	test("classifies terminal-at-cap as terminal", async () => {
		const result = await playMatch({
			seed: 1,
			players: [makeEndTurnBot("P1"), makeEndTurnBot("P2")],
			maxTurns: 2,
			harness: "boardgameio",
			strict: true,
			engineConfig: { turnLimit: 1 },
			record: true,
		});

		expect(result.reason).toBe("terminal");
		expect(result.turns).toBe(2);
		expect(result.log).toBeDefined();
		if (!result.log) throw new Error("expected match log");
		const terminal = Engine.isTerminal(result.log.finalState);
		expect(terminal.ended).toBe(true);
		expect(result.winner).toBe(terminal.winner ?? null);
	});

	test("uses maxTurns only when loop exits non-terminal", async () => {
		const result = await playMatch({
			seed: 1,
			players: [makeEndTurnBot("P1"), makeEndTurnBot("P2")],
			maxTurns: 1,
			harness: "boardgameio",
			strict: true,
			engineConfig: { turnLimit: 40 },
			record: true,
		});

		expect(result.reason).toBe("maxTurns");
		expect(result.turns).toBe(1);
		expect(result.log).toBeDefined();
		if (!result.log) throw new Error("expected match log");
		expect(Engine.isTerminal(result.log.finalState).ended).toBe(false);
	});

	test("preserves illegal forfeit classification", async () => {
		const invalidBot: Bot = {
			id: "P1",
			name: "InvalidBot",
			chooseMove: ({ legalMoves }) => legalMoves[0] as Move,
			chooseTurn: async () => [
				{ action: "attack", unitId: "NOPE", target: "A1" },
			],
		};

		const result = await playMatch({
			seed: 1,
			players: [invalidBot, makeEndTurnBot("P2")],
			maxTurns: 2,
			harness: "boardgameio",
			strict: true,
			invalidPolicy: "forfeit",
		});

		expect(result.reason).toBe("illegal");
		expect(result.winner).toBe("P2");
		expect(result.turns).toBe(0);
		expect(result.illegalMoves).toBe(1);
	});
});
