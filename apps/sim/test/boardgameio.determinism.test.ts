import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { playMatch } from "../src/match";
import type { Bot } from "../src/types";

function makeDeterministicBot(id: string): Bot {
	return {
		id,
		name: `Det_${id}`,
		chooseMove: ({ legalMoves, rng }) => {
			if (legalMoves.length === 0) return { action: "end_turn" };
			const move = legalMoves[Math.floor(rng() * legalMoves.length)];
			return move ?? { action: "end_turn" };
		},
		chooseTurn: async ({ legalMoves }) => {
			const attack = legalMoves.find((m) => m.action === "attack");
			if (attack) return [attack, { action: "end_turn" }];
			const move = legalMoves.find((m) => m.action === "move");
			if (move) return [move, { action: "end_turn" }];
			return [{ action: "end_turn" }];
		},
	};
}

describe("boardgameio determinism", () => {
	test("same seed and bots yields identical accepted move list", async () => {
		const run = async () => {
			const dir = mkdtempSync(path.join(tmpdir(), "fightclaw-bgio-det-"));
			try {
				await playMatch({
					seed: 19,
					players: [makeDeterministicBot("P1"), makeDeterministicBot("P2")],
					maxTurns: 14,
					harness: "boardgameio",
					strict: true,
					artifactDir: dir,
				});
				const file = readdirSync(dir).find((name) => name.endsWith(".json"));
				if (!file) throw new Error("artifact not found");
				return JSON.parse(readFileSync(path.join(dir, file), "utf8"));
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		};

		const a = await run();
		const b = await run();
		expect(a.result.winner).toBe(b.result.winner);
		expect(a.result.reason).toBe(b.result.reason);
		expect(JSON.stringify(a.acceptedMoves)).toBe(
			JSON.stringify(b.acceptedMoves),
		);
	});
});
