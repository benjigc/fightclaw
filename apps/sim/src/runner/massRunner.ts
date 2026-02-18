import type { ChildProcess } from "node:child_process";
import { fork } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	HarnessMode,
	InvalidPolicy,
	MoveValidationMode,
	ScenarioName,
} from "../boardgameio/types";
import type { SimulationOptions, SimulationStats } from "../simulation/config";
import type { Bot, EngineConfigInput, MatchResult } from "../types";
import type { BotConfig } from "./forkWorker";

interface HarnessRunOptions {
	harness?: HarnessMode;
	scenario?: ScenarioName;
	invalidPolicy?: InvalidPolicy;
	moveValidationMode?: MoveValidationMode;
	strict?: boolean;
	artifactDir?: string;
	storeFullPrompt?: boolean;
	storeFullOutput?: boolean;
}

interface Checkpoint {
	completedSeeds: number[];
	results: MatchResult[];
	timestamp: number;
}

interface WorkerBatchResponse {
	type: "batch_complete" | "error";
	results?: MatchResult[];
	error?: string;
}

function createEmptyStats(): SimulationStats {
	return {
		totalGames: 0,
		completedGames: 0,
		draws: 0,
		totalIllegalMoves: 0,
		wins: {},
		winRates: {},
		matchLengths: {
			min: Number.POSITIVE_INFINITY,
			max: Number.NEGATIVE_INFINITY,
			mean: 0,
			median: 0,
			stdDev: 0,
			p25: 0,
			p75: 0,
			p95: 0,
			outliers: [],
		},
		moveCounts: {},
		totalAnomalies: 0,
		anomaliesByType: {
			instant_surrender: 0,
			illegal_move_spree: 0,
			same_move_repetition: 0,
			timeout_pattern: 0,
			deterministic_loop: 0,
			extreme_win_rate: 0,
			draw_pattern: 0,
			statistical_outlier: 0,
		},
		anomaliesBySeverity: {
			info: 0,
			warn: 0,
			critical: 0,
		},
		strategyDistribution: {},
	};
}

function aggregateResults(
	results: MatchResult[],
	playerIds: string[],
	botConfigs?: BotConfig[],
): SimulationStats {
	const stats = createEmptyStats();
	stats.totalGames = results.length;
	stats.completedGames = results.length;

	for (const id of playerIds) {
		stats.wins[id] = 0;
	}

	const lengths: number[] = [];

	for (const result of results) {
		if (result.winner === null) {
			stats.draws++;
		} else {
			const winnerId = String(result.winner);
			stats.wins[winnerId] = (stats.wins[winnerId] ?? 0) + 1;
		}
		stats.totalIllegalMoves += result.illegalMoves;
		lengths.push(result.turns);
	}

	if (lengths.length > 0) {
		lengths.sort((a, b) => a - b);
		stats.matchLengths.min = lengths[0] ?? 0;
		stats.matchLengths.max = lengths[lengths.length - 1] ?? 0;
		stats.matchLengths.mean =
			lengths.reduce((a, b) => a + b, 0) / lengths.length;
		stats.matchLengths.median = lengths[Math.floor(lengths.length / 2)] ?? 0;
		stats.matchLengths.p25 = lengths[Math.floor(lengths.length * 0.25)] ?? 0;
		stats.matchLengths.p75 = lengths[Math.floor(lengths.length * 0.75)] ?? 0;
		stats.matchLengths.p95 = lengths[Math.floor(lengths.length * 0.95)] ?? 0;

		const variance =
			lengths.reduce(
				(sum, val) => sum + (val - stats.matchLengths.mean) ** 2,
				0,
			) / lengths.length;
		stats.matchLengths.stdDev = Math.sqrt(variance);

		const iqr = stats.matchLengths.p75 - stats.matchLengths.p25;
		const lowerBound = stats.matchLengths.p25 - 1.5 * iqr;
		const upperBound = stats.matchLengths.p75 + 1.5 * iqr;
		stats.matchLengths.outliers = lengths.filter(
			(l) => l < lowerBound || l > upperBound,
		);
	}

	for (const id of playerIds) {
		const wins = stats.wins[id] ?? 0;
		const losses = stats.completedGames - wins - stats.draws;
		const rate = stats.completedGames > 0 ? wins / stats.completedGames : 0;

		const n = stats.completedGames;
		const z = 1.96;
		const phat = rate;
		const denominator = 1 + (z * z) / n;
		const center = phat + (z * z) / (2 * n);
		const spread = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * n)) / n);

		stats.winRates[id] = {
			wins,
			losses,
			total: stats.completedGames,
			rate,
			ci95Lower: Math.max(0, (center - spread) / denominator),
			ci95Upper: Math.min(1, (center + spread) / denominator),
		};
	}

	if (botConfigs && botConfigs.length > 0) {
		for (const cfg of botConfigs) {
			if (cfg.type !== "mockllm") continue;
			const strategy = cfg.llmConfig?.strategy ?? "strategic";
			stats.strategyDistribution[strategy] =
				(stats.strategyDistribution[strategy] ?? 0) + 1;
		}
	}

	return stats;
}

function loadCheckpoint(outputDir: string): Checkpoint | null {
	const checkpointPath = path.join(outputDir, "checkpoint.json");
	if (fs.existsSync(checkpointPath)) {
		try {
			const data = fs.readFileSync(checkpointPath, "utf-8");
			return JSON.parse(data) as Checkpoint;
		} catch {
			return null;
		}
	}
	return null;
}

function saveCheckpoint(
	outputDir: string,
	completedSeeds: number[],
	results: MatchResult[],
): void {
	fs.mkdirSync(outputDir, { recursive: true });
	const checkpoint: Checkpoint = {
		completedSeeds,
		results,
		timestamp: Date.now(),
	};
	fs.writeFileSync(
		path.join(outputDir, "checkpoint.json"),
		JSON.stringify(checkpoint, null, 2),
	);
}

function appendResultsToJsonl(outputDir: string, results: MatchResult[]): void {
	fs.mkdirSync(outputDir, { recursive: true });
	const resultsPath = path.join(outputDir, "results.jsonl");
	const lines = `${results.map((r) => JSON.stringify(r)).join("\n")}\n`;
	fs.appendFileSync(resultsPath, lines);
}

function writeSummary(outputDir: string, stats: SimulationStats): void {
	fs.mkdirSync(outputDir, { recursive: true });
	fs.writeFileSync(
		path.join(outputDir, "summary.json"),
		JSON.stringify(stats, null, 2),
	);
}

function cleanupCheckpoint(outputDir: string): void {
	const checkpointPath = path.join(outputDir, "checkpoint.json");
	if (fs.existsSync(checkpointPath)) {
		fs.unlinkSync(checkpointPath);
	}
}

// Resolve worker script path relative to this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const forkWorkerPath = path.join(__dirname, "forkWorker.ts");

function botToConfig(bot: Bot): BotConfig {
	// Infer type from bot name
	const name = bot.name.toLowerCase();
	let type: BotConfig["type"] = "random";
	if (name.includes("greedy")) type = "greedy";
	else if (name.includes("aggressive")) type = "aggressive";
	else if (name.includes("mockllm")) type = "mockllm";

	// For mockllm bots, extract the strategy from the name (MockLLM_<strategy>)
	const config: BotConfig = { id: String(bot.id), name: bot.name, type };
	if (type === "mockllm") {
		const strategyMatch =
			bot.name.match(/MockLLM_(\w+)/) ??
			bot.name.match(/strategy=(aggressive|defensive|random|strategic)/i);
		const strategy = strategyMatch?.[1]?.toLowerCase() as
			| "aggressive"
			| "defensive"
			| "random"
			| "strategic"
			| undefined;
		config.llmConfig = { strategy: strategy ?? "strategic" };
	}
	return config;
}

function createForkWorker(): ChildProcess {
	// fork() inherits process.execArgv (including --import tsx/loader.mjs)
	return fork(forkWorkerPath, [], { stdio: "inherit" });
}

function runWorkerBatch(
	worker: ChildProcess,
	seeds: number[],
	maxTurns: number,
	botConfigs: BotConfig[],
	engineConfig?: EngineConfigInput,
	harnessOptions?: HarnessRunOptions,
): Promise<MatchResult[]> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			worker.kill();
			reject(new Error("Worker batch timeout"));
		}, 300_000); // 5 min timeout per batch

		const handler = (msg: WorkerBatchResponse) => {
			clearTimeout(timeout);
			worker.off("message", handler);
			if (msg.type === "error") {
				reject(new Error(msg.error));
			} else {
				resolve(msg.results ?? []);
			}
		};

		worker.on("message", handler);

		worker.once("error", (err) => {
			clearTimeout(timeout);
			worker.off("message", handler);
			reject(err);
		});

		worker.send({
			type: "run_batch",
			seeds,
			maxTurns,
			botConfigs,
			engineConfig,
			harnessOptions,
		});
	});
}

export async function runMassSimulation(
	options: SimulationOptions,
	players: [Bot, Bot],
	engineConfig?: EngineConfigInput,
	harnessOptions?: HarnessRunOptions,
): Promise<SimulationStats> {
	const totalGames = options.games;
	const playerIds = players.map((p) => String(p.id));
	const parallelism = Math.max(1, options.parallelism);
	const botConfigs = players.map(botToConfig);

	const resultsPath = path.join(options.outputDir, "results.jsonl");
	let allResults: MatchResult[] = [];
	let completedSeedSet = new Set<number>();

	const checkpoint = loadCheckpoint(options.outputDir);
	if (checkpoint) {
		console.log(
			`Resuming from checkpoint: ${checkpoint.completedSeeds.length} matches completed`,
		);
		allResults = checkpoint.results;
		completedSeedSet = new Set(checkpoint.completedSeeds);
	} else {
		fs.mkdirSync(options.outputDir, { recursive: true });
		if (fs.existsSync(resultsPath)) {
			fs.unlinkSync(resultsPath);
		}
	}

	const allSeeds: number[] = [];
	for (let i = 0; i < totalGames; i++) {
		const seed = options.seed + i;
		if (!completedSeedSet.has(seed)) {
			allSeeds.push(seed);
		}
	}

	if (allSeeds.length === 0) {
		console.log("All matches already completed. Loading results...");
		const stats = aggregateResults(allResults, playerIds, botConfigs);
		writeSummary(options.outputDir, stats);
		cleanupCheckpoint(options.outputDir);
		return stats;
	}

	const mode = parallelism > 1 ? "parallel" : "sequential";
	console.log(
		`Running ${allSeeds.length} matches in ${mode} mode (${parallelism} workers)...`,
	);

	let lastReportedPercent = 0;
	let shutdownRequested = false;

	const saveAndExit = () => {
		if (shutdownRequested) return;
		shutdownRequested = true;
		console.log("\nShutdown requested, saving checkpoint...");
		saveCheckpoint(options.outputDir, Array.from(completedSeedSet), allResults);
		console.log(`Checkpoint saved: ${completedSeedSet.size} matches completed`);
		process.exit(0);
	};

	process.on("SIGINT", saveAndExit);
	process.on("SIGTERM", saveAndExit);

	if (parallelism === 1) {
		// Sequential mode — run in-process
		const { playMatch } = await import("../match");
		const batchSize = 100;

		for (let i = 0; i < allSeeds.length; i += batchSize) {
			if (shutdownRequested) break;

			const batch = allSeeds.slice(i, i + batchSize);
			const batchResults: MatchResult[] = [];

			for (const seed of batch) {
				const result = await playMatch({
					seed,
					players,
					maxTurns: options.maxTurns,
					verbose: false,
					record: false,
					autofixIllegal: true,
					engineConfig,
					scenario: harnessOptions?.scenario,
					harness: harnessOptions?.harness,
					invalidPolicy: harnessOptions?.invalidPolicy,
					moveValidationMode: harnessOptions?.moveValidationMode,
					strict: harnessOptions?.strict,
					artifactDir: harnessOptions?.artifactDir,
					storeFullPrompt: harnessOptions?.storeFullPrompt,
					storeFullOutput: harnessOptions?.storeFullOutput,
				});
				batchResults.push(result);
				completedSeedSet.add(seed);
			}

			allResults.push(...batchResults);
			appendResultsToJsonl(options.outputDir, batchResults);

			const currentPercent = Math.floor(
				(completedSeedSet.size / totalGames) * 100,
			);

			if (
				currentPercent >= lastReportedPercent + 5 ||
				completedSeedSet.size -
					Math.floor((lastReportedPercent / 100) * totalGames) >=
					1000
			) {
				console.log(
					`Progress: ${completedSeedSet.size}/${totalGames} matches (${currentPercent}%)`,
				);
				lastReportedPercent = currentPercent;
			}
		}
	} else {
		// Parallel mode with child_process.fork()
		const workers: ChildProcess[] = [];

		for (let i = 0; i < parallelism; i++) {
			workers.push(createForkWorker());
		}

		// Split seeds into chunks per worker, using smaller batches for progress reporting
		const chunkSize = Math.max(
			50,
			Math.ceil(allSeeds.length / (parallelism * 4)),
		);
		const chunks: number[][] = [];
		for (let i = 0; i < allSeeds.length; i += chunkSize) {
			chunks.push(allSeeds.slice(i, i + chunkSize));
		}

		// Process chunks round-robin across workers
		let chunkIndex = 0;
		const workerPromises: Promise<void>[] = [];

		for (let w = 0; w < workers.length; w++) {
			const worker = workers[w];
			if (!worker) continue;
			workerPromises.push(
				(async () => {
					while (true) {
						const myChunkIndex = chunkIndex++;
						if (myChunkIndex >= chunks.length || shutdownRequested) break;

						const seeds = chunks[myChunkIndex];
						if (!seeds) break;
						try {
							const results = await runWorkerBatch(
								worker,
								seeds,
								options.maxTurns,
								botConfigs,
								engineConfig,
								harnessOptions,
							);

							for (const result of results) {
								completedSeedSet.add(result.seed);
							}
							allResults.push(...results);
							appendResultsToJsonl(options.outputDir, results);

							const currentPercent = Math.floor(
								(completedSeedSet.size / totalGames) * 100,
							);
							if (
								currentPercent >= lastReportedPercent + 5 ||
								completedSeedSet.size -
									Math.floor((lastReportedPercent / 100) * totalGames) >=
									1000
							) {
								console.log(
									`Progress: ${completedSeedSet.size}/${totalGames} matches (${currentPercent}%)`,
								);
								lastReportedPercent = currentPercent;
							}
						} catch (error) {
							console.error(`Worker ${w} failed on chunk:`, error);
							// Try to continue with remaining chunks
						}
					}
				})(),
			);
		}

		await Promise.all(workerPromises);

		// Shutdown all workers
		for (const worker of workers) {
			worker.send({ type: "shutdown" });
		}
		// Give them a moment to exit gracefully, then kill
		await new Promise((resolve) => setTimeout(resolve, 500));
		for (const worker of workers) {
			if (worker.exitCode === null) {
				worker.kill();
			}
		}

		console.log(
			`Progress: ${completedSeedSet.size}/${totalGames} matches (100%)`,
		);
	}

	process.off("SIGINT", saveAndExit);
	process.off("SIGTERM", saveAndExit);

	const stats = aggregateResults(allResults, playerIds, botConfigs);
	stats.totalGames = totalGames;

	writeSummary(options.outputDir, stats);
	cleanupCheckpoint(options.outputDir);

	console.log(`Completed: ${stats.completedGames}/${totalGames} matches`);

	return stats;
}
