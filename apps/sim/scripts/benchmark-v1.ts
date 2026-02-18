import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

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
	const baseSeed = Number.parseInt(parseArg("--seed") ?? "70000", 10);
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
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const runName = parseArg("--name") ?? `benchmark_v1_${timestamp}`;
	const outputBaseInSim = path.join("results", runName);
	const outputBaseAbs = path.join(simDir, outputBaseInSim);

	const matchups = collectMatchups(baseSeed);
	mkdirSync(outputBaseAbs, { recursive: true });

	console.log(
		"Using benchmark skill: systematic-debugging (root-cause-first).\n",
	);
	console.log(`Benchmark output: ${outputBaseAbs}`);
	console.log(
		`Matchups: ${matchups.length} (scenarios=${scenarios.length}, mirroredPairs=${mirroredPairs.length})`,
	);
	console.log(`Games per matchup: ${gamesPerMatchup}`);
	console.log(
		`Engine/harness locks: boardColumns=17, turnLimit=40, actionsPerTurn=7, maxTurns=${maxTurns}, harness=boardgameio`,
	);

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
		const apiPairs = mirroredPairs.slice(0, 3); // 12 games total across 4 scenarios
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

	const benchmarkSummary = {
		version: "benchmark_v1",
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
		fastLane: aggregateSummaries(path.join(outputBaseAbs, "fast_lane")),
		apiLane: withApi
			? aggregateSummaries(path.join(outputBaseAbs, "api_lane"))
			: null,
	};

	const summaryPath = path.join(outputBaseAbs, "benchmark-summary.json");
	writeFileSync(summaryPath, JSON.stringify(benchmarkSummary, null, 2));

	console.log("\nBenchmark complete.");
	console.log(`Summary: ${summaryPath}`);
}

main();
