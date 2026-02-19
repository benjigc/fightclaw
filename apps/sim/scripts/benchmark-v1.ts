import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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

interface RunPolicy {
	timeoutMs?: number;
	retries?: number;
	continueOnError?: boolean;
}

interface MassCommandBaseOptions {
	games: number;
	parallel: number;
	output: string;
	maxTurns: number;
	scenario: string;
	bot1: string;
	bot2: string;
}

interface ApiLlmOptions {
	model: string;
	parallelCalls: number;
	timeoutMs: number;
	maxRetries: number;
	retryBaseMs: number;
	maxTokens: number;
}

interface ApiLaneCommandOptions {
	scenario: Scenario;
	bot1: Strategy;
	bot2: Strategy;
	gamesPerMatchup: number;
	output: string;
	maxTurns: number;
	seed: number;
	llm: ApiLlmOptions;
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

const SIM_MASS_COMMAND_PREFIX = [
	"-C",
	"apps/sim",
	"exec",
	"tsx",
	"src/cli.ts",
	"mass",
] as const;

function parseArg(name: string): string | undefined {
	const idx = process.argv.indexOf(name);
	if (idx < 0) return undefined;
	return process.argv[idx + 1];
}

function parseStringArg(name: string, fallback: string): string {
	return parseArg(name) ?? fallback;
}

function parseIntArg(name: string, fallback: number): number {
	const parsed = Number.parseInt(parseStringArg(name, String(fallback)), 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function hasFlag(name: string): boolean {
	return process.argv.includes(name);
}

function parseBoolArg(name: string, fallback: boolean): boolean {
	const value = parseArg(name);
	if (value === undefined) return fallback;
	const normalized = value.toLowerCase();
	if (normalized === "true" || normalized === "1" || normalized === "yes") {
		return true;
	}
	if (normalized === "false" || normalized === "0" || normalized === "no") {
		return false;
	}
	return fallback;
}

function createMassCommandBaseArgs(options: MassCommandBaseOptions): string[] {
	return [
		...SIM_MASS_COMMAND_PREFIX,
		"--games",
		String(options.games),
		"--parallel",
		String(options.parallel),
		"--output",
		options.output,
		"--harness",
		"boardgameio",
		"--boardColumns",
		"17",
		"--turnLimit",
		"40",
		"--actionsPerTurn",
		"7",
		"--maxTurns",
		String(options.maxTurns),
		"--scenario",
		options.scenario,
		"--bot1",
		options.bot1,
		"--bot2",
		options.bot2,
	];
}

function createFastLaneCommandArgs(
	matchup: Matchup,
	gamesPerMatchup: number,
	maxTurns: number,
	output: string,
): string[] {
	return [
		...createMassCommandBaseArgs({
			games: gamesPerMatchup,
			parallel: 4,
			output,
			maxTurns,
			scenario: matchup.scenario,
			bot1: "mockllm",
			bot2: "mockllm",
		}),
		"--strategy1",
		matchup.bot1,
		"--strategy2",
		matchup.bot2,
		"--seed",
		String(matchup.seed),
		"--quiet",
	];
}

function createApiLaneCommandArgs(options: ApiLaneCommandOptions): string[] {
	const { llm } = options;
	return [
		...createMassCommandBaseArgs({
			games: options.gamesPerMatchup,
			parallel: 1,
			output: options.output,
			maxTurns: options.maxTurns,
			scenario: options.scenario,
			bot1: "llm",
			bot2: "llm",
		}),
		"--model1",
		llm.model,
		"--model2",
		llm.model,
		"--strategy1",
		options.bot1,
		"--strategy2",
		options.bot2,
		"--llmParallelCalls",
		String(Math.max(1, llm.parallelCalls)),
		"--llmTimeoutMs",
		String(Math.max(1, llm.timeoutMs)),
		"--llmMaxRetries",
		String(Math.max(0, llm.maxRetries)),
		"--llmRetryBaseMs",
		String(Math.max(1, llm.retryBaseMs)),
		"--llmMaxTokens",
		String(Math.max(64, llm.maxTokens)),
		"--seed",
		String(options.seed),
		"--quiet",
	];
}

async function runCmd(
	cwd: string,
	args: string[],
	dryRun: boolean,
	policy?: RunPolicy,
): Promise<boolean> {
	const pretty = `pnpm ${args.join(" ")}`;
	console.log(pretty);
	if (dryRun) return true;

	const retries = Math.max(0, policy?.retries ?? 0);
	const timeoutMs = policy?.timeoutMs;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			await new Promise<void>((resolve, reject) => {
				const child = spawn("pnpm", args, {
					cwd,
					stdio: "inherit",
				});
				let timedOut = false;
				let killTimer: NodeJS.Timeout | null = null;
				let graceTimer: NodeJS.Timeout | null = null;

				if (typeof timeoutMs === "number" && timeoutMs > 0) {
					killTimer = setTimeout(() => {
						timedOut = true;
						if (child.exitCode === null && child.signalCode === null) {
							child.kill("SIGTERM");
						}
						graceTimer = setTimeout(() => {
							if (child.exitCode === null && child.signalCode === null) {
								child.kill("SIGKILL");
							}
						}, 5_000);
					}, timeoutMs);
				}

				child.on("error", (error) => {
					if (killTimer != null) clearTimeout(killTimer);
					if (graceTimer != null) clearTimeout(graceTimer);
					reject(error);
				});

				child.on("close", (code, signal) => {
					if (killTimer != null) clearTimeout(killTimer);
					if (graceTimer != null) clearTimeout(graceTimer);
					if (code === 0) {
						resolve();
						return;
					}
					const exitPart =
						signal != null ? `signal ${signal}` : `code ${code ?? "unknown"}`;
					const timeoutPart = timedOut ? " (timed out)" : "";
					reject(new Error(`Command failed with ${exitPart}${timeoutPart}`));
				});
			});
			return true;
		} catch (error) {
			const lastAttempt = attempt >= retries;
			const msg = error instanceof Error ? error.message : String(error);
			console.warn(
				`Command failed (attempt ${attempt + 1}/${retries + 1}): ${msg}`,
			);
			if (lastAttempt) {
				if (policy?.continueOnError) return false;
				throw error;
			}
		}
	}
	return false;
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
	if (!existsSync(laneDir)) {
		return aggregate;
	}

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

		const byScenario = aggregate.byScenario[scenario] ?? {
			games: 0,
			draws: 0,
			avgTurns: 0,
		};
		aggregate.byScenario[scenario] = {
			games: byScenario.games + games,
			draws: byScenario.draws + draws,
			avgTurns: byScenario.avgTurns + meanTurns * games,
		};
	}

	aggregate.avgTurns =
		aggregate.games > 0 ? weightedTurns / aggregate.games : 0;
	for (const [scenario, byScenario] of Object.entries(aggregate.byScenario)) {
		aggregate.byScenario[scenario] = {
			games: byScenario.games,
			draws: byScenario.draws,
			avgTurns:
				byScenario.games > 0 ? byScenario.avgTurns / byScenario.games : 0,
		};
	}

	return aggregate;
}

function shouldSkipCompletedMatchup(
	outputDirAbs: string,
	expectedGames: number,
	resumeEnabled: boolean,
): boolean {
	if (!resumeEnabled) return false;
	const summaryPath = path.join(outputDirAbs, "summary.json");
	if (!existsSync(summaryPath)) return false;
	try {
		const summary = JSON.parse(readFileSync(summaryPath, "utf-8")) as {
			totalGames?: number;
			completedGames?: number;
		};
		const completed = summary.completedGames ?? summary.totalGames ?? 0;
		return completed >= expectedGames;
	} catch {
		return false;
	}
}

async function main() {
	const repoRoot = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"..",
	);
	const simDir = path.join(repoRoot, "apps", "sim");
	const dryRun = hasFlag("--dryRun");
	const withApi = hasFlag("--withApi");
	const skipFastLane = hasFlag("--skipFastLane") || hasFlag("--apiOnly");
	const resume = parseBoolArg("--resume", true);
	const gamesPerMatchup = parseIntArg("--gamesPerMatchup", 4);
	const apiGamesPerMatchup = parseIntArg("--apiGamesPerMatchup", 1);
	const maxTurns = parseIntArg("--maxTurns", 200);
	const baseSeed = parseIntArg("--seed", 70000);
	const model = parseStringArg("--model", "openai/gpt-4o-mini");
	const apiMaxTurns = parseIntArg("--apiMaxTurns", 120);
	const apiLlmParallelCalls = parseIntArg("--apiLlmParallelCalls", 1);
	const apiLlmTimeoutMs = parseIntArg("--apiLlmTimeoutMs", 20000);
	const apiLlmMaxRetries = parseIntArg("--apiLlmMaxRetries", 1);
	const apiLlmRetryBaseMs = parseIntArg("--apiLlmRetryBaseMs", 600);
	const apiLlmMaxTokens = parseIntArg("--apiLlmMaxTokens", 280);
	const apiCommandTimeoutMs = parseIntArg("--apiCommandTimeoutMs", 240000);
	const apiCommandRetries = parseIntArg("--apiCommandRetries", 1);
	const apiContinueOnError = parseArg("--apiContinueOnError") !== "false";
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const runName = parseStringArg("--name", `benchmark_v1_${timestamp}`);
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
	console.log(`Skip fast lane: ${skipFastLane}`);
	console.log(`Resume completed matchups: ${resume}`);
	console.log(
		`Engine/harness locks: boardColumns=17, turnLimit=40, actionsPerTurn=7, maxTurns=${maxTurns}, harness=boardgameio`,
	);
	const apiFailures: string[] = [];
	const skippedApiMatchups: string[] = [];

	const fastLaneDirInSim = path.join(outputBaseInSim, "fast_lane");
	if (!skipFastLane) {
		for (const matchup of matchups) {
			const output = path.join(
				fastLaneDirInSim,
				`${matchup.scenario}__${matchup.bot1}_vs_${matchup.bot2}`,
			);
			await runCmd(
				repoRoot,
				createFastLaneCommandArgs(matchup, gamesPerMatchup, maxTurns, output),
				dryRun,
			);
		}
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
				if (
					shouldSkipCompletedMatchup(
						path.join(simDir, output),
						apiGamesPerMatchup,
						resume,
					)
				) {
					skippedApiMatchups.push(path.basename(output));
					apiSeed += 1;
					continue;
				}
				const ok = await runCmd(
					repoRoot,
					createApiLaneCommandArgs({
						scenario,
						bot1,
						bot2,
						gamesPerMatchup: apiGamesPerMatchup,
						output,
						maxTurns: apiMaxTurns,
						seed: apiSeed,
						llm: {
							model,
							parallelCalls: apiLlmParallelCalls,
							timeoutMs: apiLlmTimeoutMs,
							maxRetries: apiLlmMaxRetries,
							retryBaseMs: apiLlmRetryBaseMs,
							maxTokens: apiLlmMaxTokens,
						},
					}),
					dryRun,
					{
						timeoutMs: Math.max(0, apiCommandTimeoutMs),
						retries: Math.max(0, apiCommandRetries),
						continueOnError: apiContinueOnError,
					},
				);
				if (!ok) {
					apiFailures.push(`${scenario}__${bot1}_vs_${bot2}`);
				}
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
			apiGamesPerMatchup,
			baseSeed,
			matchupCount: matchups.length,
			withApi,
			skipFastLane,
			resume,
			apiModel: withApi ? model : null,
		},
		fastLane: aggregateSummaries(path.join(outputBaseAbs, "fast_lane")),
		apiLane: withApi
			? aggregateSummaries(path.join(outputBaseAbs, "api_lane"))
			: null,
		apiReliability: withApi
			? {
					failedMatchups: apiFailures,
					failedMatchupCount: apiFailures.length,
					skippedApiMatchups,
					skippedApiMatchupCount: skippedApiMatchups.length,
					apiCommandTimeoutMs: Math.max(0, apiCommandTimeoutMs),
					apiCommandRetries: Math.max(0, apiCommandRetries),
				}
			: null,
	};

	const summaryPath = path.join(outputBaseAbs, "benchmark-summary.json");
	writeFileSync(summaryPath, JSON.stringify(benchmarkSummary, null, 2));

	console.log("\nBenchmark complete.");
	console.log(`Summary: ${summaryPath}`);
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`benchmark-v1 failed: ${message}`);
	process.exitCode = 1;
});
