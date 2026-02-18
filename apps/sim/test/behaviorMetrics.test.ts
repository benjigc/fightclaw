import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { analyzeBehaviorFromArtifacts } from "../src/reporting/behaviorMetrics";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makePrompt(args: {
	side: "A" | "B";
	turn: number;
	gold: number;
	wood: number;
	ownUnits: string[];
	enemyUnits: string[];
	terrain: string;
}): string {
	const enemySide = args.side === "A" ? "B" : "A";
	return [
		`STATE turn=${args.turn} player=${args.side} actions=7 gold=${args.gold} wood=${args.wood} vp=0`,
		"",
		`UNITS_${args.side}:`,
		...args.ownUnits.map((line) => `  ${line}`),
		"",
		`UNITS_${enemySide}:`,
		...args.enemyUnits.map((line) => `  ${line}`),
		"",
		"TERRAIN_NEAR_UNITS:",
		`  ${args.terrain}`,
		"LEGAL_MOVES:",
	].join("\n");
}

describe("analyzeBehaviorFromArtifacts", () => {
	test("computes v2 archetype/macro/terrain/fortify metrics", () => {
		const root = mkdtempSync(path.join(tmpdir(), "fightclaw-behavior-"));
		tempDirs.push(root);
		const artifactsDir = path.join(root, "artifacts");
		mkdirSync(artifactsDir, { recursive: true });

		const artifact = {
			participants: ["P1", "P2"],
			result: { winner: "P1", reason: "terminal", illegalMoves: 0, turns: 5 },
			acceptedMoves: [
				{ playerID: "0", engineMove: { action: "attack" } },
				{ playerID: "0", engineMove: { action: "fortify" } },
				{ playerID: "0", engineMove: { action: "recruit" } },
				{ playerID: "0", engineMove: { action: "attack" } },
				{ playerID: "0", engineMove: { action: "move" } },
			],
			turns: [
				{
					playerID: "0",
					prompt: makePrompt({
						side: "A",
						turn: 1,
						gold: 20,
						wood: 10,
						ownUnits: ["A-1 inf E8 hp=3/3", "A-2 arc D8 hp=2/2"],
						enemyUnits: ["B-1 inf D9 hp=3/3", "B-2 cav F9 hp=2/2"],
						terrain: "E8=high_ground D9=forest D8=gold_mine",
					}),
					commandAttempts: [
						{
							accepted: true,
							move: { action: "attack", unitId: "A-1", target: "D9" },
						},
						{ accepted: true, move: { action: "fortify", unitId: "A-2" } },
						{
							accepted: true,
							move: { action: "recruit", unitType: "infantry", target: "B2" },
						},
						{ accepted: true, move: { action: "end_turn" } },
					],
					metricsV2: {
						side: "A",
						combat: { ownHpDelta: 0 },
						resources: { ownGoldDelta: -10, ownWoodDelta: -2 },
						upgrade: {
							upgradesAccepted: 0,
							estimatedGoldSpend: 0,
							estimatedWoodSpend: 0,
						},
					},
				},
				{
					playerID: "1",
					prompt: makePrompt({
						side: "B",
						turn: 1,
						gold: 19,
						wood: 8,
						ownUnits: ["B-1 inf D9 hp=2/3"],
						enemyUnits: ["A-1 inf E8 hp=3/3"],
						terrain: "D9=forest E8=high_ground",
					}),
					commandAttempts: [{ accepted: true, move: { action: "end_turn" } }],
					metricsV2: {
						side: "B",
						combat: { ownHpDelta: -4 },
						resources: { ownGoldDelta: 0, ownWoodDelta: 0 },
						upgrade: {
							upgradesAccepted: 0,
							estimatedGoldSpend: 0,
							estimatedWoodSpend: 0,
						},
					},
				},
				{
					playerID: "0",
					prompt: makePrompt({
						side: "A",
						turn: 2,
						gold: 15,
						wood: 8,
						ownUnits: ["A-1 inf E8 hp=2/3", "A-2 arc D8 hp=2/2"],
						enemyUnits: ["B-1 inf D9 hp=2/3"],
						terrain: "E8=high_ground D9=forest D8=gold_mine",
					}),
					commandAttempts: [
						{
							accepted: true,
							move: { action: "attack", unitId: "A-1", target: "D9" },
						},
						{ accepted: true, move: { action: "end_turn" } },
					],
					metricsV2: {
						side: "A",
						combat: { ownHpDelta: -1 },
						resources: { ownGoldDelta: -4, ownWoodDelta: 0 },
						upgrade: {
							upgradesAccepted: 0,
							estimatedGoldSpend: 0,
							estimatedWoodSpend: 0,
						},
					},
				},
				{
					playerID: "1",
					prompt: makePrompt({
						side: "B",
						turn: 2,
						gold: 21,
						wood: 8,
						ownUnits: ["B-1 inf D9 hp=1/3"],
						enemyUnits: ["A-1 inf E8 hp=2/3"],
						terrain: "D9=forest E8=high_ground",
					}),
					commandAttempts: [{ accepted: true, move: { action: "end_turn" } }],
					metricsV2: {
						side: "B",
						combat: { ownHpDelta: -4 },
						resources: { ownGoldDelta: 0, ownWoodDelta: 0 },
						upgrade: {
							upgradesAccepted: 0,
							estimatedGoldSpend: 0,
							estimatedWoodSpend: 0,
						},
					},
				},
				{
					playerID: "0",
					prompt: makePrompt({
						side: "A",
						turn: 3,
						gold: 12,
						wood: 8,
						ownUnits: ["A-1 inf E8 hp=1/3", "A-2 arc D8 hp=2/2"],
						enemyUnits: ["B-1 inf D9 hp=1/3"],
						terrain: "E8=high_ground D9=forest D8=gold_mine",
					}),
					commandAttempts: [
						{
							accepted: true,
							move: { action: "move", unitId: "A-2", to: "E9" },
						},
						{ accepted: true, move: { action: "end_turn" } },
					],
					metricsV2: {
						side: "A",
						combat: { ownHpDelta: -3 },
						resources: { ownGoldDelta: -1, ownWoodDelta: 0 },
						upgrade: {
							upgradesAccepted: 0,
							estimatedGoldSpend: 0,
							estimatedWoodSpend: 0,
						},
					},
				},
			],
		};

		writeFileSync(
			path.join(artifactsDir, "match-1.json"),
			JSON.stringify(artifact, null, 2),
		);

		const summary = analyzeBehaviorFromArtifacts(root);

		expect(
			summary.archetypeSeparation.resourceSpendCurveSignal.totalEstimatedSpend,
		).toBeGreaterThan(0);
		expect(summary.macroIndex.recruitTiming.gamesWithRecruit).toBe(1);
		expect(summary.macroIndex.recruitTiming.meanFirstRecruitTurn).toBe(1);
		expect(summary.terrainLeverage.fightsInitiated).toBeGreaterThan(0);
		expect(summary.terrainLeverage.advantagedInitiations).toBeGreaterThan(0);
		expect(summary.terrainLeverage.leverageRate).toBeGreaterThan(0);
		expect(summary.fortifyROI.fortifyActionsAccepted).toBe(1);
		expect(summary.fortifyROI.woodSpentEstimate).toBe(2);
		expect(summary.fortifyROI.damagePreventedEstimate).toBeGreaterThan(0);
		expect(summary.fortifyROI.roi).toBeGreaterThan(0);
	});
});
