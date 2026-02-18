import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import minimist from "minimist";
import { replayBoardgameArtifact } from "./boardgameio/replay";
import type {
	HarnessMode,
	InvalidPolicy,
	MoveValidationMode,
} from "./boardgameio/types";
import { makeAggressiveBot } from "./bots/aggressiveBot";
import { makeGreedyBot } from "./bots/greedyBot";
import { makeLlmBot } from "./bots/llmBot";
import { makeMockLlmBot } from "./bots/mockLlmBot";
import { makeRandomLegalBot } from "./bots/randomBot";
import { playMatch, replayMatch } from "./match";
import { analyzeBehaviorFromArtifacts } from "./reporting/behaviorMetrics";
import type { DashboardData } from "./reporting/dashboardGenerator";
import { generateDashboard } from "./reporting/dashboardGenerator";
import { runMassSimulation } from "./runner/massRunner";
import type { SimulationStats } from "./simulation/config";
import { createSimulationOptions } from "./simulation/config";
import { runTournament } from "./tournament";
import type { Bot, EngineConfigInput } from "./types";

type Args = ReturnType<typeof minimist>;

type BotType = "random" | "greedy" | "aggressive" | "mockllm" | "llm";

function inferApiKeyForBaseUrl(
	_baseUrl: string | undefined,
): string | undefined {
	return process.env.LLM_API_KEY ?? process.env.OPENROUTER_API_KEY;
}

function makeBot(
	id: string,
	type: BotType,
	opts?: {
		prompt?: string;
		strategy?: string;
		model?: string;
		apiKey?: string;
		baseUrl?: string;
		llmDelayMs?: number;
		llmParallelCalls?: number;
		llmTimeoutMs?: number;
		llmMaxRetries?: number;
		llmRetryBaseMs?: number;
		llmMaxTokens?: number;
		openrouterReferrer?: string;
		openrouterTitle?: string;
	},
): Bot {
	switch (type) {
		case "greedy":
			return makeGreedyBot(id);
		case "aggressive":
			return makeAggressiveBot(id);
		case "llm": {
			if (!opts?.model) {
				throw new Error(`Missing --model for ${id} (required for llm bot)`);
			}
			if (!opts.apiKey) {
				throw new Error(
					"Missing --apiKey (or set LLM_API_KEY env var) (required for llm bot)",
				);
			}
			return makeLlmBot(id, {
				model: opts.model,
				apiKey: opts.apiKey,
				baseUrl: opts.baseUrl,
				openRouterReferer: opts.openrouterReferrer,
				openRouterTitle: opts.openrouterTitle,
				systemPrompt: opts.prompt,
				delayMs: opts.llmDelayMs ?? 0,
				parallelCalls: opts.llmParallelCalls,
				timeoutMs: opts.llmTimeoutMs,
				maxRetries: opts.llmMaxRetries,
				retryBaseMs: opts.llmRetryBaseMs,
				maxTokens: opts.llmMaxTokens,
			});
		}
		case "mockllm":
			return makeMockLlmBot(id, {
				strategy:
					(opts?.strategy as
						| "aggressive"
						| "defensive"
						| "random"
						| "strategic") ?? "strategic",
				inline: opts?.prompt,
			});
		default:
			return makeRandomLegalBot(id);
	}
}

async function main() {
	const argv: Args = minimist(process.argv.slice(2));
	const cmd = argv._[0];

	const seed = num(argv.seed, 1);
	const verbose = !!argv.verbose;
	const log = !!argv.log;
	const logFile = typeof argv.logFile === "string" ? argv.logFile : undefined;
	const autofix = !!argv.autofix;
	const output = typeof argv.output === "string" ? argv.output : "./results";
	const quiet = !!argv.quiet;
	const json = !!argv.json;

	const turnLimit = num(argv.turnLimit, 40);
	const actionsPerTurn = num(argv.actionsPerTurn, 7);
	const boardColumnsRaw = num(argv.boardColumns, 17);
	const boardColumns =
		boardColumnsRaw === 17 || boardColumnsRaw === 21 ? boardColumnsRaw : 17;
	const minRecommendedMaxTurns = Math.max(200, turnLimit * actionsPerTurn * 2);
	const maxTurns =
		argv.maxTurns === undefined
			? minRecommendedMaxTurns
			: num(argv.maxTurns, minRecommendedMaxTurns);

	const engineConfig: EngineConfigInput = {
		turnLimit,
		actionsPerTurn,
		boardColumns: boardColumns as 17 | 21,
	};

	const bot1Type = (
		typeof argv.bot1 === "string" ? argv.bot1 : "greedy"
	) as BotType;
	const bot2Type = (
		typeof argv.bot2 === "string" ? argv.bot2 : "random"
	) as BotType;
	const prompt1 = typeof argv.prompt1 === "string" ? argv.prompt1 : undefined;
	const prompt2 = typeof argv.prompt2 === "string" ? argv.prompt2 : undefined;
	const strategy1 =
		typeof argv.strategy1 === "string" ? argv.strategy1 : undefined;
	const strategy2 =
		typeof argv.strategy2 === "string" ? argv.strategy2 : undefined;

	const baseUrl = typeof argv.baseUrl === "string" ? argv.baseUrl : undefined;
	const baseUrl1 = typeof argv.baseUrl1 === "string" ? argv.baseUrl1 : baseUrl;
	const baseUrl2 = typeof argv.baseUrl2 === "string" ? argv.baseUrl2 : baseUrl;
	const apiKey = typeof argv.apiKey === "string" ? argv.apiKey : undefined;
	const apiKey1 =
		typeof argv.apiKey1 === "string"
			? argv.apiKey1
			: (apiKey ?? inferApiKeyForBaseUrl(baseUrl1));
	const apiKey2 =
		typeof argv.apiKey2 === "string"
			? argv.apiKey2
			: (apiKey ?? inferApiKeyForBaseUrl(baseUrl2));
	const llmDelayMs = num(argv.llmDelay, 0);
	const llmParallelCalls = Math.max(1, num(argv.llmParallelCalls, 1));
	const llmTimeoutMs = num(argv.llmTimeoutMs, 35000);
	const llmMaxRetries = Math.max(0, num(argv.llmMaxRetries, 3));
	const llmRetryBaseMs = Math.max(1, num(argv.llmRetryBaseMs, 1000));
	const llmMaxTokens = Math.max(64, num(argv.llmMaxTokens, 320));
	const openrouterReferrer =
		typeof argv.openrouterReferrer === "string"
			? argv.openrouterReferrer
			: typeof argv.openRouterReferrer === "string"
				? argv.openRouterReferrer
				: process.env.OPENROUTER_REFERRER;
	const openrouterTitle =
		typeof argv.openrouterTitle === "string"
			? argv.openrouterTitle
			: typeof argv.openRouterTitle === "string"
				? argv.openRouterTitle
				: process.env.OPENROUTER_TITLE;

	const model =
		typeof argv.model === "string"
			? argv.model
			: typeof argv.modelName === "string"
				? argv.modelName
				: undefined;
	const model1 =
		typeof argv.model1 === "string" ? argv.model1 : (model ?? undefined);
	const model2 =
		typeof argv.model2 === "string" ? argv.model2 : (model ?? undefined);

	const p1 = makeBot("P1", bot1Type, {
		prompt: prompt1,
		strategy: strategy1,
		model: model1,
		apiKey: apiKey1,
		baseUrl: baseUrl1,
		llmDelayMs,
		llmParallelCalls,
		llmTimeoutMs,
		llmMaxRetries,
		llmRetryBaseMs,
		llmMaxTokens,
		openrouterReferrer,
		openrouterTitle,
	});
	const p2 = makeBot("P2", bot2Type, {
		prompt: prompt2,
		strategy: strategy2,
		model: model2,
		apiKey: apiKey2,
		baseUrl: baseUrl2,
		llmDelayMs,
		llmParallelCalls,
		llmTimeoutMs,
		llmMaxRetries,
		llmRetryBaseMs,
		llmMaxTokens,
		openrouterReferrer,
		openrouterTitle,
	});

	const enableDiagnostics = !!argv.diagnostics;
	const harness =
		typeof argv.harness === "string" ? (argv.harness as HarnessMode) : "legacy";
	const invalidPolicy =
		typeof argv.invalidPolicy === "string"
			? (argv.invalidPolicy as InvalidPolicy)
			: "skip";
	const moveValidationMode =
		typeof argv.moveValidationMode === "string"
			? (argv.moveValidationMode as MoveValidationMode)
			: "strict";
	const strict = !!argv.strict || process.env.HARNESS_STRICT === "1";
	const artifactDir =
		typeof argv.artifactDir === "string" ? argv.artifactDir : undefined;
	const storeFullPrompt =
		typeof argv.storeFullPrompt === "string"
			? argv.storeFullPrompt !== "false"
			: process.env.CI !== "true";
	const storeFullOutput =
		typeof argv.storeFullOutput === "string"
			? argv.storeFullOutput !== "false"
			: process.env.CI !== "true";

	const scenario =
		typeof argv.scenario === "string"
			? (argv.scenario as
					| "melee"
					| "ranged"
					| "stronghold_rush"
					| "midfield"
					| "all_infantry"
					| "all_cavalry"
					| "all_archer"
					| "infantry_archer"
					| "cavalry_archer"
					| "infantry_cavalry")
			: undefined;

	if (
		(cmd === "single" || cmd === "tourney" || cmd === "mass") &&
		maxTurns < minRecommendedMaxTurns &&
		!quiet
	) {
		console.warn(
			`Warning: --maxTurns ${maxTurns} may truncate games early for turnLimit=${turnLimit} and actionsPerTurn=${actionsPerTurn}. Recommended >= ${minRecommendedMaxTurns}.`,
		);
	}

	if (cmd === "single") {
		const result = await playMatch({
			seed,
			maxTurns,
			players: [p1, p2],
			verbose,
			record: log || !!logFile,
			autofixIllegal: autofix,
			enableDiagnostics,
			engineConfig,
			scenario,
			harness,
			invalidPolicy,
			moveValidationMode,
			strict,
			artifactDir,
			storeFullPrompt,
			storeFullOutput,
		});
		if (logFile && result.log) {
			writeFileSync(logFile, JSON.stringify(result.log));
		}
		if (log && result.log) {
			console.log(JSON.stringify(result.log));
			return;
		}
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	if (cmd === "replay") {
		if (!logFile) {
			console.error("replay requires --logFile path");
			process.exit(1);
		}
		const payload = JSON.parse(readFileSync(logFile, "utf-8"));
		const result =
			payload?.artifactVersion === 1
				? replayBoardgameArtifact(payload)
				: replayMatch(payload);
		console.log(JSON.stringify(result, null, 2));
		process.exit(result.ok ? 0 : 1);
	}

	if (cmd === "tourney") {
		const games = num(argv.games, 200);
		const { summary } = await runTournament({
			games,
			seed,
			maxTurns,
			players: [p1, p2],
			autofixIllegal: autofix,
			engineConfig,
			harness,
			invalidPolicy,
			moveValidationMode,
			strict,
			artifactDir,
			storeFullPrompt,
			storeFullOutput,
		});
		console.log(JSON.stringify(summary, null, 2));
		console.log(
			`games=${summary.games} avgTurns=${summary.avgTurns} draws=${summary.draws} illegalMoveRate=${summary.illegalMoveRate}`,
		);
		return;
	}

	if (cmd === "mass") {
		const games = num(argv.games, 10000);
		const parallel = num(argv.parallel, 4);

		if ((bot1Type === "llm" || bot2Type === "llm") && parallel > 1) {
			console.error(
				"LLM bots are only supported with --parallel 1 (API keys are not forwarded to fork workers).",
			);
			process.exit(1);
		}

		const options = createSimulationOptions({
			games,
			maxTurns,
			parallelism: parallel,
			seed,
			outputDir: output,
		});

		if (!quiet) {
			console.log(`Starting mass simulation: ${games} games...`);
			console.log(`Parallel workers: ${parallel}`);
			console.log(`Output directory: ${output}`);
		}

		const startTime = Date.now();
		const stats = await runMassSimulation(options, [p1, p2], engineConfig, {
			harness,
			scenario,
			invalidPolicy,
			moveValidationMode,
			strict,
			artifactDir,
			storeFullPrompt,
			storeFullOutput,
		});
		const duration = (Date.now() - startTime) / 1000;

		if (!quiet) {
			console.log(`\nCompleted in ${duration.toFixed(1)}s`);
			console.log(`Games: ${stats.totalGames}`);
			console.log(`Avg turns: ${stats.matchLengths.mean.toFixed(1)}`);
			console.log(`Anomalies: ${stats.totalAnomalies}`);
		}

		if (json) {
			console.log(JSON.stringify(stats, null, 2));
		}
		return;
	}

	if (cmd === "analyze") {
		const inputDir = typeof argv.input === "string" ? argv.input : output;

		if (!existsSync(inputDir)) {
			console.error(`Input directory not found: ${inputDir}`);
			process.exit(1);
		}

		const summaryPath = path.join(inputDir, "summary.json");
		if (!existsSync(summaryPath)) {
			console.error(`Summary file not found: ${summaryPath}`);
			console.error("Run 'mass' command first to generate results.");
			process.exit(1);
		}

		const stats: SimulationStats = JSON.parse(
			readFileSync(summaryPath, "utf-8"),
		);

		if (!quiet) {
			console.log("=== SIMULATION ANALYSIS ===\n");
			console.log(`Total Games: ${stats.totalGames}`);
			console.log(`Completed: ${stats.completedGames}`);
			console.log(`Draws: ${stats.draws}`);
			console.log("\nMatch Lengths:");
			console.log(`  Mean: ${stats.matchLengths.mean.toFixed(1)}`);
			console.log(`  Median: ${stats.matchLengths.median}`);
			console.log(
				`  Min: ${stats.matchLengths.min}, Max: ${stats.matchLengths.max}`,
			);
			console.log(
				`  StdDev: ${stats.matchLengths.stdDev.toFixed(1)}, P95: ${stats.matchLengths.p95}`,
			);
			console.log("\nWin Rates:");
			for (const [player, winRate] of Object.entries(stats.winRates)) {
				console.log(
					`  ${player}: ${(winRate.rate * 100).toFixed(1)}% (${winRate.wins}/${winRate.total})`,
				);
			}
			console.log(`\nAnomalies: ${stats.totalAnomalies}`);
			if (stats.matchLengths.outliers.length > 0) {
				console.log(
					`  Match length outliers: ${stats.matchLengths.outliers.length}`,
				);
			}
		}

		if (json) {
			console.log(JSON.stringify(stats, null, 2));
		}
		return;
	}

	if (cmd === "dashboard") {
		const inputDir = typeof argv.input === "string" ? argv.input : output;
		const dashboardOutput =
			typeof argv.output === "string"
				? argv.output
				: path.join(inputDir, "dashboard.html");

		if (!existsSync(inputDir)) {
			console.error(`Input directory not found: ${inputDir}`);
			process.exit(1);
		}

		const summaryPath = path.join(inputDir, "summary.json");
		if (!existsSync(summaryPath)) {
			console.error(`Summary file not found: ${summaryPath}`);
			process.exit(1);
		}

		const stats: SimulationStats = JSON.parse(
			readFileSync(summaryPath, "utf-8"),
		);

		const dashboardData: DashboardData = {
			summary: {
				totalGames: stats.totalGames,
				completedGames: stats.completedGames,
				draws: stats.draws,
				avgTurns: stats.matchLengths.mean,
				totalAnomalies: stats.totalAnomalies,
			},
			winRates: stats.winRates,
			strategyDistribution: stats.strategyDistribution,
			anomalies: [],
			matchLengths: stats.matchLengths,
		};

		generateDashboard(dashboardData, dashboardOutput);

		if (!quiet) {
			console.log(`Dashboard generated: ${dashboardOutput}`);
		}
		return;
	}

	if (cmd === "behavior") {
		const inputDir = typeof argv.input === "string" ? argv.input : "./results";
		const outputPath =
			typeof argv.output === "string"
				? argv.output
				: path.join(inputDir, "behavior-metrics.json");

		const summary = analyzeBehaviorFromArtifacts(inputDir);
		writeFileSync(outputPath, JSON.stringify(summary, null, 2));
		console.log(JSON.stringify(summary, null, 2));
		if (!quiet) {
			console.log(`Behavior metrics written: ${outputPath}`);
		}
		return;
	}

	console.error("Usage:");
	console.error(
		"  tsx src/cli.ts single  --seed 1 --maxTurns 200 --verbose --log --logFile ./match.json",
	);
	console.error("  tsx src/cli.ts single  --autofix");
	console.error("  tsx src/cli.ts replay  --logFile ./match.json");
	console.error(
		"  tsx src/cli.ts tourney --games 200 --seed 1 --maxTurns 200 --autofix",
	);
	console.error(
		"  tsx src/cli.ts mass    --games 10000 --parallel 4 --output ./results",
	);
	console.error("  tsx src/cli.ts analyze --input ./results [--json]");
	console.error(
		"  tsx src/cli.ts dashboard --input ./results --output ./dashboard.html",
	);
	console.error(
		"  tsx src/cli.ts behavior --input ./results-or-artifacts --output ./behavior-metrics.json",
	);
	console.error("");
	console.error("Engine options:");
	console.error("  --turnLimit N       Engine turn limit (default: 40)");
	console.error("  --actionsPerTurn N  Actions per turn (default: 7)");
	console.error("  --boardColumns N    Board width: 17 or 21 (default: 17)");
	console.error(
		"  --scenario NAME     Combat scenario: melee, ranged, stronghold_rush, midfield, all_infantry, all_cavalry, all_archer, infantry_archer, cavalry_archer, infantry_cavalry",
	);
	console.error(
		"  --harness MODE      Runner harness: legacy, boardgameio (default: legacy)",
	);
	console.error(
		"  --invalidPolicy P   Invalid command policy: skip, stop_turn, forfeit",
	);
	console.error(
		"  --moveValidationMode M  Move validation mode: strict, relaxed (default: strict)",
	);
	console.error("  --strict            Fail on harness divergence checks");
	console.error(
		"  --artifactDir PATH  Boardgame harness artifact output directory",
	);
	console.error(
		"  --storeFullPrompt B Store full prompts in artifacts (true|false)",
	);
	console.error(
		"  --storeFullOutput B Store full model output in artifacts (true|false)",
	);
	console.error("");
	console.error("Bot options (for single, tourney, mass):");
	console.error(
		"  --bot1 TYPE    P1 bot type: random, greedy, aggressive, mockllm, llm (default: greedy)",
	);
	console.error(
		"  --bot2 TYPE    P2 bot type: random, greedy, aggressive, mockllm, llm (default: random)",
	);
	console.error(
		'  --prompt1 TXT  Inline prompt for P1 mockllm/llm bot (e.g., "Always attack first")',
	);
	console.error(
		'  --prompt2 TXT  Inline prompt for P2 mockllm/llm bot (e.g., "Defend and recruit")',
	);
	console.error(
		"  --strategy1 S  MockLLM strategy: aggressive, defensive, random, strategic",
	);
	console.error(
		"  --strategy2 S  MockLLM strategy: aggressive, defensive, random, strategic",
	);
	console.error("");
	console.error("LLM options:");
	console.error(
		"  --model MODEL   Model id (alias: applies to both players if --model1/--model2 omitted)",
	);
	console.error("  --model1 MODEL  Model id for P1 (required when --bot1 llm)");
	console.error("  --model2 MODEL  Model id for P2 (required when --bot2 llm)");
	console.error(
		"  --apiKey KEY    API key for provider (or set LLM_API_KEY env var)",
	);
	console.error(
		"  --apiKey1 KEY   API key for P1 llm bot (overrides --apiKey)",
	);
	console.error(
		"  --apiKey2 KEY   API key for P2 llm bot (overrides --apiKey)",
	);
	console.error(
		"  --baseUrl URL   OpenAI-compatible base URL (default: OpenRouter)",
	);
	console.error(
		"  --baseUrl1 URL  Base URL for P1 llm bot (overrides --baseUrl)",
	);
	console.error(
		"  --baseUrl2 URL  Base URL for P2 llm bot (overrides --baseUrl)",
	);
	console.error(
		"  --openrouterReferrer URL  Sets OpenRouter HTTP-Referer header (or OPENROUTER_REFERRER env var)",
	);
	console.error(
		"  --openrouterTitle TXT     Sets OpenRouter X-Title header (or OPENROUTER_TITLE env var)",
	);
	console.error(
		"  --llmDelay MS   Delay between LLM calls per bot (default: 0)",
	);
	console.error(
		"  --llmParallelCalls N  Parallel API requests per LLM turn (default: 1)",
	);
	console.error(
		"  --llmTimeoutMs MS     Per-call API timeout in ms (default: 35000)",
	);
	console.error(
		"  --llmMaxRetries N     Max retry attempts per call (default: 3)",
	);
	console.error(
		"  --llmRetryBaseMs MS   Retry backoff base delay in ms (default: 1000)",
	);
	console.error(
		"  --llmMaxTokens N      Max output tokens per model call (default: 320)",
	);
	process.exit(1);
}

function num(v: unknown, def: number) {
	const n =
		typeof v === "string" ? Number(v) : typeof v === "number" ? v : Number.NaN;
	return Number.isFinite(n) ? n : def;
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
