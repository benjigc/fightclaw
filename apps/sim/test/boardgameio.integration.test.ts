import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { replayBoardgameArtifact } from "../src/boardgameio/replay";
import { makeAggressiveBot } from "../src/bots/aggressiveBot";
import { playMatch } from "../src/match";
import type { Bot, Move } from "../src/types";

function makeBatchBot(id: string): Bot {
	return {
		id,
		name: `Batch_${id}`,
		chooseMove: ({ legalMoves, rng }) =>
			legalMoves[Math.floor(rng() * legalMoves.length)] as Move,
		chooseTurn: async ({ legalMoves }) => {
			const attack = legalMoves.find((m) => m.action === "attack");
			if (attack) return [attack, { action: "end_turn" }];
			return [{ action: "end_turn" }];
		},
	};
}

describe("boardgameio harness", () => {
	test("runs an end-to-end match", async () => {
		const result = await playMatch({
			seed: 7,
			players: [makeBatchBot("P1"), makeBatchBot("P2")],
			maxTurns: 30,
			harness: "boardgameio",
			strict: true,
			invalidPolicy: "skip",
			scenario: "midfield",
		});

		expect(result.reason).not.toBe("illegal");
		expect(result.turns).toBeGreaterThan(0);
	});

	test("writes replayable artifact", async () => {
		const artifactDir = mkdtempSync(path.join(tmpdir(), "fightclaw-bgio-"));
		await playMatch({
			seed: 11,
			players: [makeBatchBot("P1"), makeBatchBot("P2")],
			maxTurns: 20,
			harness: "boardgameio",
			strict: true,
			invalidPolicy: "skip",
			artifactDir,
		});
		const files = readdirSync(artifactDir).filter((f) => f.endsWith(".json"));
		expect(files.length).toBe(1);
		const artifact = JSON.parse(
			readFileSync(path.join(artifactDir, files[0] as string), "utf8"),
		);
		expect(artifact.artifactVersion).toBe(1);
		const replay = replayBoardgameArtifact(artifact);
		expect(replay.ok).toBe(true);
	});

	test("strict harness handles terminal turns without divergence errors", async () => {
		const result = await playMatch({
			seed: 1,
			players: [makeAggressiveBot("P1"), makeAggressiveBot("P2")],
			maxTurns: 60,
			harness: "boardgameio",
			strict: true,
			invalidPolicy: "skip",
			scenario: "midfield",
		});

		expect(["terminal", "maxTurns"]).toContain(result.reason);
	});
});
