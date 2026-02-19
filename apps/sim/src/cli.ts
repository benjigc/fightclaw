import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import minimist from "minimist";
import { replayBoardgameArtifact } from "./boardgameio/replay";
import type {
	HarnessMode,
	InvalidPolicy,
	MoveValidationMode,
	ScenarioName,
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
type StrategyName = "aggressive" | "defensive" | "random" | "strategic";

function inferApiKeyForBaseUrl(
	_baseUrl: string | undefined,
): string | undefined {
	return process.env.LLM_API_KEY ?? process.env.OPENROUTER_API_KEY;
}

function strategyPromptForLlm(strategy?: string): string | undefined {
	const normalized = (strategy ?? "").toLowerCase() as StrategyName | "";
	switch (normalized) {
		case "aggressive":
			return "Aggressive timing push: prioritize legal attacks first, then advance toward enemy stronghold. Avoid recruit loops when attacks are legal.";
		case "defensive":
			return "Defensive macro: protect fragile units, trade safely, recruit when needed, but if attacks are legal do not skip all combat.";
		case "strategic":
			return "Strategic tempo: preserve material, take favorable attacks, contest terrain, and create a decisive midgame timing. Avoid move-only loops.";
		default:
			return undefined;
	}
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
				systemPrompt: opts.prompt ?? strategyPromptForLlm(opts.strategy),
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

type DashboardArtifactTurn = {
	turnIndex?: number;
	declaredPlan?: string;
	powerSpikeTriggered?: boolean;
	swingEvent?: string;
	whyThisMove?: string;
	commandAttempts?: Array<{
		accepted?: boolean;
		move?: {
			action?: string;
			reasoning?: string;
			metadata?: {
				whyThisMove?: string;
				breakdown?: {
					archetype?: string;
				};
			};
		};
	}>;
	metricsV2?: {
		resources?: {
			ownVpDelta?: number;
			enemyVpDelta?: number;
		};
	};
};

type DashboardArtifact = {
	seed?: number;
	result?: {
		winner?: string | null;
	};
	turns?: DashboardArtifactTurn[];
};

function mean(values: number[]): number | null {
	if (values.length === 0) return null;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) {
		return sorted[mid] ?? null;
	}
	const a = sorted[mid - 1];
	const b = sorted[mid];
	if (a === undefined || b === undefined) return null;
	return (a + b) / 2;
}

function resolveArtifactFiles(inputDir: string): string[] {
	const candidates = [path.join(inputDir, "artifacts"), inputDir];
	for (const dir of candidates) {
		if (!existsSync(dir)) continue;
		const files = readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => path.join(dir, name));
		if (files.length > 0) {
			const hasArtifacts = files.some((file) => {
				try {
					const payload = JSON.parse(readFileSync(file, "utf-8")) as {
						turns?: unknown;
						artifactVersion?: unknown;
					};
					return Array.isArray(payload.turns) || payload.artifactVersion === 1;
				} catch {
					return false;
				}
			});
			if (hasArtifacts) return files;
		}
	}
	return [];
}

function toTurnNumber(turn: DashboardArtifactTurn, idx: number): number {
	const value = turn.turnIndex;
	return Number.isFinite(value) && typeof value === "number" ? value : idx + 1;
}

function normalizeOpeningChoice(input: string): string {
	const clipped = input.trim().toLowerCase().slice(0, 48);
	return clipped.length > 0 ? clipped : "unknown";
}

function detectFirstCommitmentTurn(
	turns: DashboardArtifactTurn[],
): number | null {
	for (let idx = 0; idx < turns.length; idx++) {
		const turn = turns[idx];
		if (!turn) continue;
		const accepted = (turn.commandAttempts ?? []).filter((a) => a.accepted);
		const hasCommitment = accepted.some((attempt) => {
			const action = attempt.move?.action;
			return (
				action === "attack" ||
				action === "recruit" ||
				action === "upgrade" ||
				action === "fortify"
			);
		});
		if (hasCommitment) {
			return toTurnNumber(turn, idx);
		}
	}
	return null;
}

function extractArchetypeTags(turn: DashboardArtifactTurn): string[] {
	const tags: string[] = [];
	const topLevelWhy = turn.whyThisMove;
	if (typeof topLevelWhy === "string") {
		const m = topLevelWhy.match(/archetype=([a-z_]+)/i);
		if (m?.[1]) tags.push(m[1].toLowerCase());
	}
	for (const attempt of turn.commandAttempts ?? []) {
		const fromBreakdown = attempt.move?.metadata?.breakdown?.archetype;
		if (fromBreakdown) {
			tags.push(fromBreakdown.toLowerCase());
		}
		const why = attempt.move?.metadata?.whyThisMove ?? attempt.move?.reasoning;
		if (typeof why === "string") {
			const m = why.match(/archetype=([a-z_]+)/i);
			if (m?.[1]) tags.push(m[1].toLowerCase());
		}
	}
	return tags;
}

function classifyMatchArchetype(turns: DashboardArtifactTurn[]): {
	archetype: string;
	confidence: number;
} {
	const directTags = turns.flatMap(extractArchetypeTags);
	if (directTags.length > 0) {
		const counts = new Map<string, number>();
		for (const tag of directTags) {
			counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
		let best = "unknown";
		let bestCount = 0;
		for (const [tag, count] of counts.entries()) {
			if (count > bestCount) {
				best = tag;
				bestCount = count;
			}
		}
		return {
			archetype: best,
			confidence: bestCount / Math.max(1, directTags.length),
		};
	}

	let accepted = 0;
	let attacks = 0;
	let moves = 0;
	let recruits = 0;
	let upgrades = 0;
	let fortifies = 0;
	let openingAggro = 0;
	for (let idx = 0; idx < turns.length; idx++) {
		const turn = turns[idx];
		if (!turn) continue;
		const localAccepted = (turn.commandAttempts ?? []).filter(
			(a) => a.accepted,
		);
		for (const attempt of localAccepted) {
			accepted++;
			const action = attempt.move?.action;
			if (action === "attack") {
				attacks++;
				if (idx < 4) openingAggro++;
			}
			if (action === "move") moves++;
			if (action === "recruit") recruits++;
			if (action === "upgrade") upgrades++;
			if (action === "fortify") fortifies++;
		}
	}

	if (accepted === 0) {
		return { archetype: "unknown", confidence: 0 };
	}

	const attackRate = attacks / accepted;
	const moveRate = moves / accepted;
	const econRate = (recruits + upgrades) / accepted;
	const fortifyRate = fortifies / accepted;
	const openingAggroRate = openingAggro / Math.max(1, attacks);

	const scoreByArchetype = {
		timing_push: attackRate * 1.7 + openingAggroRate * 0.8,
		greedy_macro: econRate * 2.0 + (1 - attackRate) * 0.3,
		turtle_boom: fortifyRate * 1.8 + econRate * 0.9 - attackRate * 0.4,
		map_control: moveRate * 1.5 + attackRate * 0.5,
	};

	const entries = Object.entries(scoreByArchetype).sort((a, b) => b[1] - a[1]);
	const best = entries[0];
	const second = entries[1];
	if (!best || !second) {
		return { archetype: "unknown", confidence: 0 };
	}
	const margin = Math.max(0, best[1] - second[1]);
	return {
		archetype: best[0],
		confidence: Math.min(1, 0.5 + margin),
	};
}

function buildDashboardExplainabilityData(inputDir: string): {
	timeline?: DashboardData["timeline"];
	archetypeClassifier?: DashboardData["archetypeClassifier"];
} {
	const files = resolveArtifactFiles(inputDir);
	if (files.length === 0) {
		return {};
	}

	const openingCounts = new Map<string, number>();
	const firstCommitmentTurns: number[] = [];
	const powerSpikeTurns: number[] = [];
	const decisiveSwingTurns: number[] = [];
	const archetypeCounts = new Map<string, number>();
	const archetypeSamples: NonNullable<
		DashboardData["archetypeClassifier"]
	>["sampleMatches"] = [];
	const archetypeConfidences: number[] = [];

	for (const file of files) {
		let artifact: DashboardArtifact | null = null;
		try {
			artifact = JSON.parse(readFileSync(file, "utf-8")) as DashboardArtifact;
		} catch {
			continue;
		}
		const turns = artifact.turns ?? [];
		if (turns.length === 0) continue;

		const openingTurn = turns[0];
		if (openingTurn) {
			const openingLabel =
				openingTurn.declaredPlan ??
				(openingTurn.commandAttempts ?? []).find((attempt) => attempt.accepted)
					?.move?.action ??
				"unknown";
			const normalized = normalizeOpeningChoice(openingLabel);
			openingCounts.set(normalized, (openingCounts.get(normalized) ?? 0) + 1);
		}

		const commitmentTurn = detectFirstCommitmentTurn(turns);
		if (commitmentTurn !== null) {
			firstCommitmentTurns.push(commitmentTurn);
		}

		let matchDecisiveTurn: number | null = null;
		for (let idx = 0; idx < turns.length; idx++) {
			const turn = turns[idx];
			if (!turn) continue;
			const turnNumber = toTurnNumber(turn, idx);
			if (turn.powerSpikeTriggered) {
				powerSpikeTurns.push(turnNumber);
			}
			if (typeof turn.swingEvent === "string") {
				if (turn.swingEvent.startsWith("decisive_")) {
					matchDecisiveTurn = turnNumber;
				}
			}
		}
		if (matchDecisiveTurn !== null) {
			decisiveSwingTurns.push(matchDecisiveTurn);
		} else {
			const fallbackSwing = turns.findIndex(
				(turn) => typeof turn.swingEvent === "string",
			);
			if (fallbackSwing >= 0) {
				decisiveSwingTurns.push(
					toTurnNumber(
						turns[fallbackSwing] as DashboardArtifactTurn,
						fallbackSwing,
					),
				);
			}
		}

		const classified = classifyMatchArchetype(turns);
		archetypeCounts.set(
			classified.archetype,
			(archetypeCounts.get(classified.archetype) ?? 0) + 1,
		);
		archetypeConfidences.push(classified.confidence);
		archetypeSamples.push({
			seed:
				typeof artifact.seed === "number" && Number.isFinite(artifact.seed)
					? artifact.seed
					: null,
			winner:
				typeof artifact.result?.winner === "string" ||
				artifact.result?.winner === null
					? artifact.result.winner
					: null,
			archetype: classified.archetype,
			confidence: classified.confidence,
		});
	}

	const matchesAnalyzed = archetypeSamples.length;
	if (matchesAnalyzed === 0) {
		return {};
	}

	const openingChoice = Array.from(openingCounts.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([label, count]) => ({
			label,
			count,
			rate: count / matchesAnalyzed,
		}));

	const powerSpikeByTurn = Array.from(
		powerSpikeTurns.reduce((acc, turn) => {
			acc.set(turn, (acc.get(turn) ?? 0) + 1);
			return acc;
		}, new Map<number, number>()),
	)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([turn, count]) => ({
			turn,
			count,
			rate: count / matchesAnalyzed,
		}));

	const archetypeDistribution = Array.from(archetypeCounts.entries())
		.sort((a, b) => b[1] - a[1])
		.map(([archetype, count]) => ({
			archetype,
			count,
			rate: count / matchesAnalyzed,
		}));

	return {
		timeline: {
			matchesAnalyzed,
			openingChoice,
			firstCommitment: {
				meanTurn: mean(firstCommitmentTurns),
				medianTurn: median(firstCommitmentTurns),
				samples: firstCommitmentTurns.length,
			},
			powerSpikeTurns: powerSpikeByTurn,
			decisiveSwing: {
				meanTurn: mean(decisiveSwingTurns),
				medianTurn: median(decisiveSwingTurns),
				samples: decisiveSwingTurns.length,
			},
		},
		archetypeClassifier: {
			matchesAnalyzed,
			primaryArchetype: archetypeDistribution[0]?.archetype ?? null,
			averageConfidence: mean(archetypeConfidences) ?? 0,
			distribution: archetypeDistribution,
			sampleMatches: archetypeSamples.slice(0, 20),
		},
	};
}

type CliContext = {
	seed: number;
	verbose: boolean;
	log: boolean;
	logFile?: string;
	autofix: boolean;
	output: string;
	quiet: boolean;
	json: boolean;
	turnLimit: number;
	actionsPerTurn: number;
	maxTurns: number;
	minRecommendedMaxTurns: number;
	engineConfig: EngineConfigInput;
	p1: Bot;
	p2: Bot;
	bot1Type: BotType;
	bot2Type: BotType;
	enableDiagnostics: boolean;
	harness: HarnessMode;
	invalidPolicy: InvalidPolicy;
	moveValidationMode: MoveValidationMode;
	strict: boolean;
	artifactDir?: string;
	storeFullPrompt: boolean;
	storeFullOutput: boolean;
	scenario?: ScenarioName;
};

function stringArg(argv: Args, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = argv[key];
		if (typeof value === "string") {
			return value;
		}
	}
	return undefined;
}

function parseStoreFlag(argv: Args, key: string, fallback: boolean): boolean {
	const value = argv[key];
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return value !== "false";
	return fallback;
}

function loadSummaryStatsOrExit(
	inputDir: string,
	options?: { showMassHint?: boolean },
): SimulationStats {
	if (!existsSync(inputDir)) {
		console.error(`Input directory not found: ${inputDir}`);
		process.exit(1);
	}

	const summaryPath = path.join(inputDir, "summary.json");
	if (!existsSync(summaryPath)) {
		console.error(`Summary file not found: ${summaryPath}`);
		if (options?.showMassHint) {
			console.error("Run 'mass' command first to generate results.");
		}
		process.exit(1);
	}

	return JSON.parse(readFileSync(summaryPath, "utf-8")) as SimulationStats;
}

function createCliContext(argv: Args): CliContext {
	const seed = num(argv.seed, 1);
	const verbose = !!argv.verbose;
	const log = !!argv.log;
	const logFile = stringArg(argv, "logFile");
	const autofix = !!argv.autofix;
	const output = stringArg(argv, "output") ?? "./results";
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

	const bot1Type = (stringArg(argv, "bot1") ?? "greedy") as BotType;
	const bot2Type = (stringArg(argv, "bot2") ?? "random") as BotType;
	const prompt1 = stringArg(argv, "prompt1");
	const prompt2 = stringArg(argv, "prompt2");
	const strategy1 = stringArg(argv, "strategy1");
	const strategy2 = stringArg(argv, "strategy2");

	const baseUrl = stringArg(argv, "baseUrl");
	const baseUrl1 = stringArg(argv, "baseUrl1") ?? baseUrl;
	const baseUrl2 = stringArg(argv, "baseUrl2") ?? baseUrl;
	const apiKey = stringArg(argv, "apiKey");
	const apiKey1 =
		stringArg(argv, "apiKey1") ?? apiKey ?? inferApiKeyForBaseUrl(baseUrl1);
	const apiKey2 =
		stringArg(argv, "apiKey2") ?? apiKey ?? inferApiKeyForBaseUrl(baseUrl2);
	const llmDelayMs = num(argv.llmDelay, 0);
	const llmParallelCalls = Math.max(1, num(argv.llmParallelCalls, 1));
	const llmTimeoutMs = num(argv.llmTimeoutMs, 35000);
	const llmMaxRetries = Math.max(0, num(argv.llmMaxRetries, 3));
	const llmRetryBaseMs = Math.max(1, num(argv.llmRetryBaseMs, 1000));
	const llmMaxTokens = Math.max(64, num(argv.llmMaxTokens, 320));
	const openrouterReferrer =
		stringArg(argv, "openrouterReferrer", "openRouterReferrer") ??
		process.env.OPENROUTER_REFERRER;
	const openrouterTitle =
		stringArg(argv, "openrouterTitle", "openRouterTitle") ??
		process.env.OPENROUTER_TITLE;

	const model = stringArg(argv, "model", "modelName");
	const model1 = stringArg(argv, "model1") ?? model;
	const model2 = stringArg(argv, "model2") ?? model;

	const sharedLlmBotConfig = {
		llmDelayMs,
		llmParallelCalls,
		llmTimeoutMs,
		llmMaxRetries,
		llmRetryBaseMs,
		llmMaxTokens,
		openrouterReferrer,
		openrouterTitle,
	};

	const p1 = makeBot("P1", bot1Type, {
		prompt: prompt1,
		strategy: strategy1,
		model: model1,
		apiKey: apiKey1,
		baseUrl: baseUrl1,
		...sharedLlmBotConfig,
	});
	const p2 = makeBot("P2", bot2Type, {
		prompt: prompt2,
		strategy: strategy2,
		model: model2,
		apiKey: apiKey2,
		baseUrl: baseUrl2,
		...sharedLlmBotConfig,
	});

	const enableDiagnostics = !!argv.diagnostics;
	const harness =
		(stringArg(argv, "harness") as HarnessMode | undefined) ?? "legacy";
	const invalidPolicy =
		(stringArg(argv, "invalidPolicy") as InvalidPolicy | undefined) ?? "skip";
	const moveValidationMode =
		(stringArg(argv, "moveValidationMode") as MoveValidationMode | undefined) ??
		"strict";
	const strict = !!argv.strict || process.env.HARNESS_STRICT === "1";
	const artifactDir = stringArg(argv, "artifactDir");
	const defaultStore = process.env.CI !== "true";
	const storeFullPrompt = parseStoreFlag(argv, "storeFullPrompt", defaultStore);
	const storeFullOutput = parseStoreFlag(argv, "storeFullOutput", defaultStore);

	const scenario = stringArg(argv, "scenario") as ScenarioName | undefined;

	return {
		seed,
		verbose,
		log,
		logFile,
		autofix,
		output,
		quiet,
		json,
		turnLimit,
		actionsPerTurn,
		maxTurns,
		minRecommendedMaxTurns,
		engineConfig,
		p1,
		p2,
		bot1Type,
		bot2Type,
		enableDiagnostics,
		harness,
		invalidPolicy,
		moveValidationMode,
		strict,
		artifactDir,
		storeFullPrompt,
		storeFullOutput,
		scenario,
	};
}

function warnIfMaxTurnsMayTruncate(cmd: unknown, context: CliContext): void {
	if (
		(cmd === "single" || cmd === "tourney" || cmd === "mass") &&
		context.maxTurns < context.minRecommendedMaxTurns &&
		!context.quiet
	) {
		console.warn(
			`Warning: --maxTurns ${context.maxTurns} may truncate games early for turnLimit=${context.turnLimit} and actionsPerTurn=${context.actionsPerTurn}. Recommended >= ${context.minRecommendedMaxTurns}.`,
		);
	}
}

async function handleSingleCommand(context: CliContext): Promise<void> {
	const result = await playMatch({
		seed: context.seed,
		maxTurns: context.maxTurns,
		players: [context.p1, context.p2],
		verbose: context.verbose,
		record: context.log || !!context.logFile,
		autofixIllegal: context.autofix,
		enableDiagnostics: context.enableDiagnostics,
		engineConfig: context.engineConfig,
		scenario: context.scenario,
		harness: context.harness,
		invalidPolicy: context.invalidPolicy,
		moveValidationMode: context.moveValidationMode,
		strict: context.strict,
		artifactDir: context.artifactDir,
		storeFullPrompt: context.storeFullPrompt,
		storeFullOutput: context.storeFullOutput,
	});

	if (context.logFile && result.log) {
		writeFileSync(context.logFile, JSON.stringify(result.log));
	}
	if (context.log && result.log) {
		console.log(JSON.stringify(result.log));
		return;
	}
	console.log(JSON.stringify(result, null, 2));
}

function handleReplayCommand(context: CliContext): void {
	if (!context.logFile) {
		console.error("replay requires --logFile path");
		process.exit(1);
	}

	const payload = JSON.parse(readFileSync(context.logFile, "utf-8"));
	const result =
		payload?.artifactVersion === 1
			? replayBoardgameArtifact(payload)
			: replayMatch(payload);
	console.log(JSON.stringify(result, null, 2));
	process.exit(result.ok ? 0 : 1);
}

async function handleTourneyCommand(
	argv: Args,
	context: CliContext,
): Promise<void> {
	const games = num(argv.games, 200);
	const { summary } = await runTournament({
		games,
		seed: context.seed,
		maxTurns: context.maxTurns,
		players: [context.p1, context.p2],
		autofixIllegal: context.autofix,
		engineConfig: context.engineConfig,
		harness: context.harness,
		invalidPolicy: context.invalidPolicy,
		moveValidationMode: context.moveValidationMode,
		strict: context.strict,
		artifactDir: context.artifactDir,
		storeFullPrompt: context.storeFullPrompt,
		storeFullOutput: context.storeFullOutput,
	});

	console.log(JSON.stringify(summary, null, 2));
	console.log(
		`games=${summary.games} avgTurns=${summary.avgTurns} draws=${summary.draws} illegalMoveRate=${summary.illegalMoveRate}`,
	);
}

async function handleMassCommand(
	argv: Args,
	context: CliContext,
): Promise<void> {
	const games = num(argv.games, 10000);
	const parallel = num(argv.parallel, 4);

	if (
		(context.bot1Type === "llm" || context.bot2Type === "llm") &&
		parallel > 1
	) {
		console.error(
			"LLM bots are only supported with --parallel 1 (API keys are not forwarded to fork workers).",
		);
		process.exit(1);
	}

	const options = createSimulationOptions({
		games,
		maxTurns: context.maxTurns,
		parallelism: parallel,
		seed: context.seed,
		outputDir: context.output,
	});

	if (!context.quiet) {
		console.log(`Starting mass simulation: ${games} games...`);
		console.log(`Parallel workers: ${parallel}`);
		console.log(`Output directory: ${context.output}`);
	}

	const startTime = Date.now();
	const stats = await runMassSimulation(
		options,
		[context.p1, context.p2],
		context.engineConfig,
		{
			harness: context.harness,
			scenario: context.scenario,
			invalidPolicy: context.invalidPolicy,
			moveValidationMode: context.moveValidationMode,
			strict: context.strict,
			artifactDir: context.artifactDir,
			storeFullPrompt: context.storeFullPrompt,
			storeFullOutput: context.storeFullOutput,
		},
	);
	const duration = (Date.now() - startTime) / 1000;

	if (!context.quiet) {
		console.log(`\nCompleted in ${duration.toFixed(1)}s`);
		console.log(`Games: ${stats.totalGames}`);
		console.log(`Avg turns: ${stats.matchLengths.mean.toFixed(1)}`);
		console.log(`Anomalies: ${stats.totalAnomalies}`);
	}

	if (context.json) {
		console.log(JSON.stringify(stats, null, 2));
	}
}

function handleAnalyzeCommand(argv: Args, context: CliContext): void {
	const inputDir = stringArg(argv, "input") ?? context.output;
	const stats = loadSummaryStatsOrExit(inputDir, { showMassHint: true });

	if (!context.quiet) {
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

	if (context.json) {
		console.log(JSON.stringify(stats, null, 2));
	}
}

function handleDashboardCommand(argv: Args, context: CliContext): void {
	const inputDir = stringArg(argv, "input") ?? context.output;
	const dashboardOutput =
		stringArg(argv, "output") ?? path.join(inputDir, "dashboard.html");
	const stats = loadSummaryStatsOrExit(inputDir);

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
	const explainabilityData = buildDashboardExplainabilityData(inputDir);
	if (explainabilityData.timeline) {
		dashboardData.timeline = explainabilityData.timeline;
	}
	if (explainabilityData.archetypeClassifier) {
		dashboardData.archetypeClassifier = explainabilityData.archetypeClassifier;
	}

	generateDashboard(dashboardData, dashboardOutput);

	if (!context.quiet) {
		console.log(`Dashboard generated: ${dashboardOutput}`);
	}
}

function handleBehaviorCommand(argv: Args, context: CliContext): void {
	const inputDir = stringArg(argv, "input") ?? "./results";
	const outputPath =
		stringArg(argv, "output") ?? path.join(inputDir, "behavior-metrics.json");

	const summary = analyzeBehaviorFromArtifacts(inputDir);
	writeFileSync(outputPath, JSON.stringify(summary, null, 2));
	console.log(JSON.stringify(summary, null, 2));
	if (!context.quiet) {
		console.log(`Behavior metrics written: ${outputPath}`);
	}
}

function printUsageAndExit(): never {
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
		"  --scenario NAME     Combat scenario: melee, ranged, stronghold_rush, midfield, all_infantry, all_cavalry, all_archer, infantry_archer, cavalry_archer, infantry_cavalry, high_ground_clash, forest_chokepoints, resource_race",
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

async function main() {
	const argv: Args = minimist(process.argv.slice(2));
	const cmd = argv._[0];
	const context = createCliContext(argv);

	warnIfMaxTurnsMayTruncate(cmd, context);

	switch (cmd) {
		case "single":
			await handleSingleCommand(context);
			return;
		case "replay":
			handleReplayCommand(context);
			return;
		case "tourney":
			await handleTourneyCommand(argv, context);
			return;
		case "mass":
			await handleMassCommand(argv, context);
			return;
		case "analyze":
			handleAnalyzeCommand(argv, context);
			return;
		case "dashboard":
			handleDashboardCommand(argv, context);
			return;
		case "behavior":
			handleBehaviorCommand(argv, context);
			return;
		default:
			printUsageAndExit();
	}
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
