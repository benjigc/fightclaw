import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { analyzeBehaviorFromArtifacts } from "../src/reporting/behaviorMetrics";

type Scenario = "midfield" | "melee" | "all_infantry" | "all_cavalry";
type Strategy = "strategic" | "defensive" | "aggressive";

interface Matchup {
	scenario: Scenario;
	bot1: Strategy;
	bot2: Strategy;
	seed: number;
}

interface Aggregate {
	games: number;
	draws: number;
	illegalMoves: number;
	avgTurns: number;
	byScenario: Record<
		string,
		{ games: number; draws: number; avgTurns: number }
	>;
}

const scenarios: Scenario[] = [
	"midfield",
	"melee",
	"all_infantry",
	"all_cavalry",
];

const mirroredPairs: Array<[Strategy, Strategy]> = [
	["strategic", "defensive"],
	["defensive", "strategic"],
	["strategic", "aggressive"],
	["aggressive", "strategic"],
	["aggressive", "defensive"],
	["defensive", "aggressive"],
	["defensive", "defensive"],
];

function parseArg(name: string): string | undefined {
	const idx = process.argv.indexOf(name);
	if (idx < 0) return undefined;
	return process.argv[idx + 1];
}

function hasFlag(name: string): boolean {
	return process.argv.includes(name);
}

function runCmd(cwd: string, args: string[], dryRun: boolean): void {
	const pretty = `pnpm ${args.join(" ")}`;
	console.log(pretty);
	if (dryRun) return;
	execFileSync("pnpm", args, { cwd, stdio: "inherit" });
}

function collectMatchups(baseSeed: number): Matchup[] {
	const out: Matchup[] = [];
	let seed = baseSeed;
	for (const scenario of scenarios) {
		for (const [bot1, bot2] of mirroredPairs) {
			out.push({ scenario, bot1, bot2, seed });
			seed += 1;
		}
	}
	return out;
}

function aggregateSummaries(laneDir: string): Aggregate {
	const aggregate: Aggregate = {
		games: 0,
		draws: 0,
		illegalMoves: 0,
		avgTurns: 0,
		byScenario: {},
	};
	let weightedTurns = 0;

	for (const entry of readdirSync(laneDir)) {
		const summaryPath = path.join(laneDir, entry, "summary.json");
		let summary: {
			totalGames: number;
			draws: number;
			totalIllegalMoves: number;
			matchLengths: { mean: number };
		};
		try {
			summary = JSON.parse(readFileSync(summaryPath, "utf-8"));
		} catch {
			continue;
		}
		const games = summary.totalGames ?? 0;
		const draws = summary.draws ?? 0;
		const meanTurns = summary.matchLengths?.mean ?? 0;
		const illegalMoves = summary.totalIllegalMoves ?? 0;
		const scenario = entry.split("__")[0] ?? "unknown";

		aggregate.games += games;
		aggregate.draws += draws;
		aggregate.illegalMoves += illegalMoves;
		weightedTurns += meanTurns * games;

		const byScenario =
			aggregate.byScenario[scenario] ??
			({ games: 0, draws: 0, avgTurns: 0 } as const);
		aggregate.byScenario[scenario] = {
			games: byScenario.games + games,
			draws: byScenario.draws + draws,
			avgTurns: byScenario.avgTurns + meanTurns * games,
		};
	}

	aggregate.avgTurns =
		aggregate.games > 0 ? weightedTurns / aggregate.games : 0;
	for (const scenario of Object.keys(aggregate.byScenario)) {
		const entry = aggregate.byScenario[scenario];
		aggregate.byScenario[scenario] = {
			games: entry.games,
			draws: entry.draws,
			avgTurns: entry.games > 0 ? entry.avgTurns / entry.games : 0,
		};
	}

	return aggregate;
}

function klDivergence(p: number[], q: number[]): number {
	let sum = 0;
	for (let i = 0; i < p.length; i++) {
		const pi = p[i] ?? 0;
		const qi = q[i] ?? 0;
		if (pi <= 0 || qi <= 0) continue;
		sum += pi * Math.log2(pi / qi);
	}
	return sum;
}

function jsDivergence(p: number[], q: number[]): number {
	const m = p.map((v, idx) => (v + (q[idx] ?? 0)) / 2);
	return 0.5 * klDivergence(p, m) + 0.5 * klDivergence(q, m);
}

function main() {
	const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
	const simDir = path.join(repoRoot, "apps", "sim");
	const dryRun = hasFlag("--dryRun");
	const withApi = hasFlag("--withApi");
	const gamesPerMatchup = Number.parseInt(
		parseArg("--gamesPerMatchup") ?? "4",
		10,
	);
	const maxTurns = Number.parseInt(parseArg("--maxTurns") ?? "200", 10);
	const baseSeed = Number.parseInt(parseArg("--seed") ?? "90000", 10);
	const model = parseArg("--model") ?? "openai/gpt-4o-mini";
	const apiMaxTurns = Number.parseInt(parseArg("--apiMaxTurns") ?? "120", 10);
	const apiLlmParallelCalls = Number.parseInt(
		parseArg("--apiLlmParallelCalls") ?? "1",
		10,
	);
	const apiLlmTimeoutMs = Number.parseInt(
		parseArg("--apiLlmTimeoutMs") ?? "20000",
		10,
	);
	const apiLlmMaxRetries = Number.parseInt(
		parseArg("--apiLlmMaxRetries") ?? "1",
		10,
	);
	const apiLlmRetryBaseMs = Number.parseInt(
		parseArg("--apiLlmRetryBaseMs") ?? "600",
		10,
	);
	const apiLlmMaxTokens = Number.parseInt(
		parseArg("--apiLlmMaxTokens") ?? "280",
		10,
	);
	const maxDrawRate = Number.parseFloat(parseArg("--maxDrawRate") ?? "0.02");
	const minTempoSpread = Number.parseFloat(
		parseArg("--minTempoSpread") ?? "10",
	);
	const minProfileSeparation = Number.parseFloat(
		parseArg("--minProfileSeparation") ?? "0.04",
	);
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const runName = parseArg("--name") ?? `benchmark_v2_${timestamp}`;
	const outputBaseInSim = path.join("results", runName);
	const outputBaseAbs = path.join(simDir, outputBaseInSim);

	const matchups = collectMatchups(baseSeed);
	mkdirSync(outputBaseAbs, { recursive: true });

	console.log(`Benchmark output: ${outputBaseAbs}`);
	console.log(`Matchups: ${matchups.length}`);
	console.log(`Games per matchup: ${gamesPerMatchup}`);

	const fastLaneDirInSim = path.join(outputBaseInSim, "fast_lane");
	for (const matchup of matchups) {
		const output = path.join(
			fastLaneDirInSim,
			`${matchup.scenario}__${matchup.bot1}_vs_${matchup.bot2}`,
		);
		runCmd(
			repoRoot,
			[
				"-C",
				"apps/sim",
				"exec",
				"tsx",
				"src/cli.ts",
				"mass",
				"--games",
				String(gamesPerMatchup),
				"--parallel",
				"4",
				"--output",
				output,
				"--artifactDir",
				path.join(output, "artifacts"),
				"--harness",
				"boardgameio",
				"--boardColumns",
				"17",
				"--turnLimit",
				"40",
				"--actionsPerTurn",
				"7",
				"--maxTurns",
				String(maxTurns),
				"--scenario",
				matchup.scenario,
				"--bot1",
				"mockllm",
				"--bot2",
				"mockllm",
				"--strategy1",
				matchup.bot1,
				"--strategy2",
				matchup.bot2,
				"--seed",
				String(matchup.seed),
				"--quiet",
			],
			dryRun,
		);
	}

	if (withApi) {
		const hasApiKey = !!(
			process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY
		);
		if (!hasApiKey && !dryRun) {
			throw new Error(
				"--withApi requires LLM_API_KEY or OPENROUTER_API_KEY in environment",
			);
		}
		const apiLaneDirInSim = path.join(outputBaseInSim, "api_lane");
		const apiPairs = mirroredPairs.slice(0, 3);
		let apiSeed = baseSeed + 10_000;
		for (const scenario of scenarios) {
			for (const [bot1, bot2] of apiPairs) {
				const output = path.join(
					apiLaneDirInSim,
					`${scenario}__${bot1}_vs_${bot2}`,
				);
				runCmd(
					repoRoot,
					[
						"-C",
						"apps/sim",
						"exec",
						"tsx",
						"src/cli.ts",
						"mass",
						"--games",
						"1",
						"--parallel",
						"1",
						"--output",
						output,
						"--artifactDir",
						path.join(output, "artifacts"),
						"--harness",
						"boardgameio",
						"--boardColumns",
						"17",
						"--turnLimit",
						"40",
						"--actionsPerTurn",
						"7",
						"--maxTurns",
						String(apiMaxTurns),
						"--scenario",
						scenario,
						"--bot1",
						"llm",
						"--bot2",
						"llm",
						"--model1",
						model,
						"--model2",
						model,
						"--strategy1",
						bot1,
						"--strategy2",
						bot2,
						"--llmParallelCalls",
						String(Math.max(1, apiLlmParallelCalls)),
						"--llmTimeoutMs",
						String(Math.max(1, apiLlmTimeoutMs)),
						"--llmMaxRetries",
						String(Math.max(0, apiLlmMaxRetries)),
						"--llmRetryBaseMs",
						String(Math.max(1, apiLlmRetryBaseMs)),
						"--llmMaxTokens",
						String(Math.max(64, apiLlmMaxTokens)),
						"--seed",
						String(apiSeed),
						"--quiet",
					],
					dryRun,
				);
				apiSeed += 1;
			}
		}
	}

	if (dryRun) {
		console.log("\nDry run complete (no matches executed).");
		return;
	}

	const fastLaneAbs = path.join(outputBaseAbs, "fast_lane");
	const fastLaneAggregate = aggregateSummaries(fastLaneAbs);
	const byScenarioTurns = Object.values(fastLaneAggregate.byScenario).map(
		(entry) => entry.avgTurns,
	);
	const scenarioTempoSpread =
		byScenarioTurns.length > 0
			? Math.max(...byScenarioTurns) - Math.min(...byScenarioTurns)
			: 0;

	const behaviorByMatchup: Record<
		string,
		ReturnType<typeof analyzeBehaviorFromArtifacts>
	> = {};
	for (const entry of readdirSync(fastLaneAbs)) {
		const lanePath = path.join(fastLaneAbs, entry);
		try {
			behaviorByMatchup[entry] = analyzeBehaviorFromArtifacts(lanePath);
		} catch {
			// Ignore entries that do not contain artifact payloads.
		}
	}

	const matchupNames = Object.keys(behaviorByMatchup).sort();
	const actionKeys = Array.from(
		new Set(
			matchupNames.flatMap((name) =>
				Object.keys(
					behaviorByMatchup[name]?.actionProfile.normalizedAcceptedActions ??
						{},
				),
			),
		),
	).sort();

	let pairCount = 0;
	let separationSum = 0;
	for (let i = 0; i < matchupNames.length; i++) {
		for (let j = i + 1; j < matchupNames.length; j++) {
			const aName = matchupNames[i];
			const bName = matchupNames[j];
			if (!aName || !bName) continue;
			const aProfile =
				behaviorByMatchup[aName]?.actionProfile.normalizedAcceptedActions ?? {};
			const bProfile =
				behaviorByMatchup[bName]?.actionProfile.normalizedAcceptedActions ?? {};
			const p = actionKeys.map((key) => aProfile[key] ?? 0);
			const q = actionKeys.map((key) => bProfile[key] ?? 0);
			separationSum += jsDivergence(p, q);
			pairCount++;
		}
	}
	const actionProfileSeparation = pairCount > 0 ? separationSum / pairCount : 0;

	const totalBehaviorGames = matchupNames.reduce(
		(sum, name) => sum + (behaviorByMatchup[name]?.games ?? 0),
		0,
	);
	const weighted = <
		K extends Exclude<
			keyof ReturnType<typeof analyzeBehaviorFromArtifacts>["upgradeEconomy"],
			"meanFirstUpgradeTurn"
		>,
	>(
		key: K,
	): number => {
		if (totalBehaviorGames <= 0) return 0;
		let sum = 0;
		for (const name of matchupNames) {
			const metrics = behaviorByMatchup[name];
			if (!metrics) continue;
			sum += metrics.upgradeEconomy[key] * metrics.games;
		}
		return sum / totalBehaviorGames;
	};

	const meanFirstUpgradeTurn = (() => {
		let weightedSum = 0;
		let weightedGames = 0;
		for (const name of matchupNames) {
			const metrics = behaviorByMatchup[name];
			if (!metrics) continue;
			const firstUpgradeTurn = metrics.upgradeEconomy.meanFirstUpgradeTurn;
			if (firstUpgradeTurn == null) continue;
			weightedSum += firstUpgradeTurn * metrics.games;
			weightedGames += metrics.games;
		}
		return weightedGames > 0 ? weightedSum / weightedGames : null;
	})();

	const upgradeSummary = {
		avgUpgradeAdoptionRate: weighted("upgradeAdoptionRate"),
		avgUpgradesPerGame: weighted("avgUpgradesPerGame"),
		avgEstimatedUpgradeGoldSpendPerGame: weighted(
			"avgEstimatedUpgradeGoldSpendPerGame",
		),
		avgEstimatedUpgradeWoodSpendPerGame: weighted(
			"avgEstimatedUpgradeWoodSpendPerGame",
		),
		meanFirstUpgradeTurn,
	};

	const drawRate =
		fastLaneAggregate.games > 0
			? fastLaneAggregate.draws / fastLaneAggregate.games
			: 0;

	const gates = {
		drawRate: {
			threshold: maxDrawRate,
			value: drawRate,
			pass: drawRate <= maxDrawRate,
		},
		illegalMoves: {
			threshold: 0,
			value: fastLaneAggregate.illegalMoves,
			pass: fastLaneAggregate.illegalMoves === 0,
		},
		scenarioTempoSpread: {
			threshold: minTempoSpread,
			value: scenarioTempoSpread,
			pass: scenarioTempoSpread >= minTempoSpread,
		},
		actionProfileSeparation: {
			threshold: minProfileSeparation,
			value: actionProfileSeparation,
			pass: actionProfileSeparation >= minProfileSeparation,
		},
	};

	const benchmarkSummary = {
		version: "benchmark_v2",
		timestamp: new Date().toISOString(),
		config: {
			boardColumns: 17,
			turnLimit: 40,
			actionsPerTurn: 7,
			maxTurns,
			gamesPerMatchup,
			baseSeed,
			matchupCount: matchups.length,
			withApi,
			apiModel: withApi ? model : null,
		},
		fastLane: fastLaneAggregate,
		apiLane: withApi
			? aggregateSummaries(path.join(outputBaseAbs, "api_lane"))
			: null,
		behaviorByMatchup,
		metaDiversity: {
			scenarioTempoSpread,
			actionProfileSeparation,
			upgradeSummary,
		},
		gates,
	};

	const summaryPath = path.join(outputBaseAbs, "benchmark-summary.json");
	writeFileSync(summaryPath, JSON.stringify(benchmarkSummary, null, 2));

	console.log("\nBenchmark complete.");
	console.log(`Summary: ${summaryPath}`);
}

main();
