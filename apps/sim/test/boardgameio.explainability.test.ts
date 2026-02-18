import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeMockLlmBot } from "../src/bots/mockLlmBot";
import { makeRandomLegalBot } from "../src/bots/randomBot";
import { playMatch } from "../src/match";

describe("boardgameio explainability artifact fields", () => {
	test("populates turn explainability fields with backward-compatible artifact format", async () => {
		const artifactDir = mkdtempSync(path.join(tmpdir(), "fightclaw-bgio-exp-"));
		await playMatch({
			seed: 23,
			players: [
				makeMockLlmBot("P1", { strategy: "strategic" }),
				makeRandomLegalBot("P2"),
			],
			maxTurns: 12,
			harness: "boardgameio",
			strict: true,
			invalidPolicy: "skip",
			artifactDir,
		});

		const file = readdirSync(artifactDir).find((name) =>
			name.endsWith(".json"),
		);
		expect(typeof file).toBe("string");
		if (!file) throw new Error("artifact not found");

		const artifact = JSON.parse(
			readFileSync(path.join(artifactDir, file), "utf8"),
		) as {
			artifactVersion: number;
			turns: Array<{
				declaredPlan?: string;
				powerSpikeTriggered?: boolean;
				swingEvent?: string;
				whyThisMove?: string;
			}>;
		};

		expect(artifact.artifactVersion).toBe(1);
		expect(artifact.turns.length).toBeGreaterThan(0);
		expect(
			artifact.turns.some((turn) => typeof turn.declaredPlan === "string"),
		).toBe(true);
		expect(
			artifact.turns.every(
				(turn) => typeof turn.powerSpikeTriggered === "boolean",
			),
		).toBe(true);
		expect(
			artifact.turns.some(
				(turn) =>
					typeof turn.whyThisMove === "string" && turn.whyThisMove.length > 0,
			),
		).toBe(true);
	});
});
