import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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

interface ApiGameResult {
	seed?: number;
	turns?: number;
	winner?: string | null;
	illegalMoves?: number;
	reason?: string;
}

interface ApiLaneMetrics {
	totalGames: number;
	draws: number;
	maxTurnsEndings: number;
	drawRate: number;
	maxTurnsEndingRate: number;
	turns: {
		mean: number;
		p95: number;
		max: number;
	};
}

interface RunPolicy {
	timeoutMs?: number;
	retries?: number;
	continueOnError?: boolean;
}

interface RunResult {
	ok: boolean;
	attempts: number;
	durationMs: number;
}

type ApiMatchStatus = "ok" | "failed" | "skipped";

interface ApiMatchTelemetry {
	matchup: string;
	scenario: Scenario;
	bot1: Strategy;
	bot2: Strategy;
	seed: number;
	output: string;
	status: ApiMatchStatus;
	durationMs: number;
	attempts: number;
}

interface ApiTelemetryTotals {
	completed: number;
	skipped: number;
	failed: number;
}

interface ApiLaneIntegritySummary {
	notes: {
		telemetryTotalsUnit: "matchups";
		laneTotalsUnit: "games";
		primaryApiLaneScope: "runScopedSuccessfulMatchups";
	};
	runScoped: {
		successfulMatchupCount: number;
		expectedGamesFromTelemetry: number;
		aggregateGames: number;
		metricsGames: number;
		aggregateMatchesMetrics: boolean;
		aggregateMatchesTelemetryExpectation: boolean;
	};
	rawOnDisk: {
		aggregateGames: number;
		metricsGames: number;
		aggregateMatchesMetrics: boolean;
	};
}

type ApiGraduationLane = "api_smoke" | "api_full";

interface ApiGraduationCheck {
	operator: "==" | ">=" | "<=";
	threshold: number;
	value: number;
	pass: boolean;
}

interface ApiGraduationSummary {
	lane: ApiGraduationLane;
	illegalMoves: number;
	completionRate: number;
	maxTurnsEndingRate: number;
	p95WallClockPerMatchMs: number;
	p95WallClockPerMatchMinutes: number;
	checks: {
		illegalMoves: ApiGraduationCheck;
		completionRate: ApiGraduationCheck;
		maxTurnsEndingRate: ApiGraduationCheck;
		p95WallClockPerMatchMs: ApiGraduationCheck;
	};
	pass: boolean;
	consecutivePassTracking: {
		contractKey: string;
		requiredConsecutivePasses: 2;
		lane: ApiGraduationLane;
		runName: string;
		runTimestamp: string;
		currentRunPass: boolean;
		priorConsecutivePasses: number;
		currentConsecutivePasses: number;
		meetsRequiredConsecutivePasses: boolean;
	};
}

interface ApiGraduationHistoryEntry {
	lane: ApiGraduationLane;
	runName: string;
	runTimestamp: string;
	pass: boolean;
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

function parseBoolArg(name: string, fallback: boolean): boolean {
	const idx = process.argv.indexOf(name);
	if (idx < 0) return fallback;
	const value = process.argv[idx + 1];
	if (value === undefined || value.startsWith("--")) return true;
	const normalized = value.toLowerCase();
	if (normalized === "true" || normalized === "1" || normalized === "yes") {
		return true;
	}
	if (normalized === "false" || normalized === "0" || normalized === "no") {
		return false;
	}
	return fallback;
}

function runCmd(
	cwd: string,
	args: string[],
	dryRun: boolean,
	policy?: RunPolicy,
): boolean {
	const pretty = `pnpm ${args.join(" ")}`;
	console.log(pretty);
	if (dryRun) return true;

	const retries = Math.max(0, policy?.retries ?? 0);
	const timeoutMs = policy?.timeoutMs;

	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			execFileSync("pnpm", args, {
				cwd,
				stdio: "inherit",
				timeout: timeoutMs,
				killSignal: "SIGKILL",
			});
			return true;
		} catch (error) {
			const lastAttempt = attempt >= retries;
			const msg = error instanceof Error ? error.message : String(error);
			console.warn(
				`Command failed (attempt ${attempt + 1}/${retries + 1}): ${msg}`,
			);
			if (lastAttempt) {
				if (policy?.continueOnError) {
					return false;
				}
				throw error;
			}
		}
	}
	return false;
}

function runCmdAsync(
	cwd: string,
	args: string[],
	dryRun: boolean,
	policy?: RunPolicy,
): Promise<RunResult> {
	const pretty = `pnpm ${args.join(" ")}`;
	console.log(pretty);
	if (dryRun) {
		return Promise.resolve({ ok: true, attempts: 0, durationMs: 0 });
	}

	const retries = Math.max(0, policy?.retries ?? 0);
	const timeoutMs = policy?.timeoutMs;
	const startedAt = Date.now();

	return (async () => {
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				await new Promise<void>((resolve, reject) => {
					const child = spawn("pnpm", args, {
						cwd,
						stdio: "inherit",
					});
					let timedOut = false;
					const timeout =
						typeof timeoutMs === "number" && timeoutMs > 0
							? setTimeout(() => {
									timedOut = true;
									child.kill("SIGKILL");
								}, timeoutMs)
							: null;

					child.on("error", (error) => {
						if (timeout != null) clearTimeout(timeout);
						reject(error);
					});

					child.on("close", (code, signal) => {
						if (timeout != null) clearTimeout(timeout);
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
				return {
					ok: true,
					attempts: attempt + 1,
					durationMs: Date.now() - startedAt,
				};
			} catch (error) {
				const lastAttempt = attempt >= retries;
				const msg = error instanceof Error ? error.message : String(error);
				console.warn(
					`Command failed (attempt ${attempt + 1}/${retries + 1}): ${msg}`,
				);
				if (lastAttempt) {
					if (policy?.continueOnError) {
						return {
							ok: false,
							attempts: attempt + 1,
							durationMs: Date.now() - startedAt,
						};
					}
					throw error;
				}
			}
		}
		return {
			ok: false,
			attempts: retries + 1,
			durationMs: Date.now() - startedAt,
		};
	})();
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

function aggregateSummaries(
	laneDir: string,
	includedMatchups?: ReadonlySet<string>,
): Aggregate {
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
		if (includedMatchups != null && !includedMatchups.has(entry)) continue;
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

function parseResultsJsonl(filePath: string): ApiGameResult[] {
	try {
		const content = readFileSync(filePath, "utf-8");
		const results: ApiGameResult[] = [];
		let malformedLines = 0;
		for (const [index, rawLine] of content.split("\n").entries()) {
			const line = rawLine.trim();
			if (line.length === 0) continue;
			try {
				results.push(JSON.parse(line) as ApiGameResult);
			} catch (error) {
				malformedLines += 1;
				const message = error instanceof Error ? error.message : String(error);
				console.warn(
					`Skipping malformed API results JSONL line ${index + 1} in ${filePath}: ${message}`,
				);
			}
		}
		if (malformedLines > 0) {
			console.warn(
				`Skipped ${malformedLines} malformed JSONL line(s) in ${filePath}`,
			);
		}
		return results;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(
			`Failed to read API results JSONL file ${filePath}: ${message}`,
		);
		return [];
	}
}

export function summarizeApiGameRows(
	rows: ReadonlyArray<ApiGameResult>,
): ApiLaneMetrics {
	const turnSamples: number[] = [];
	let totalGames = 0;
	let draws = 0;
	let maxTurnsEndings = 0;
	for (const row of rows) {
		totalGames += 1;
		if (typeof row.turns === "number" && Number.isFinite(row.turns)) {
			turnSamples.push(row.turns);
		}
		if (row.winner == null) {
			draws += 1;
		}
		if (row.reason === "maxTurns") {
			maxTurnsEndings += 1;
		}
	}
	const meanTurns =
		turnSamples.length > 0
			? turnSamples.reduce((sum, value) => sum + value, 0) / turnSamples.length
			: 0;
	return {
		totalGames,
		draws,
		maxTurnsEndings,
		drawRate: totalGames > 0 ? draws / totalGames : 0,
		maxTurnsEndingRate: totalGames > 0 ? maxTurnsEndings / totalGames : 0,
		turns: {
			mean: meanTurns,
			p95: percentile(turnSamples, 0.95),
			max: turnSamples.length > 0 ? Math.max(...turnSamples) : 0,
		},
	};
}

function aggregateApiLaneMetrics(
	apiLaneDir: string,
	includedMatchups?: ReadonlySet<string>,
): ApiLaneMetrics {
	if (!existsSync(apiLaneDir)) {
		return summarizeApiGameRows([]);
	}
	const rows: ApiGameResult[] = [];
	for (const entry of readdirSync(apiLaneDir)) {
		if (includedMatchups != null && !includedMatchups.has(entry)) continue;
		const resultsPath = path.join(apiLaneDir, entry, "results.jsonl");
		if (!existsSync(resultsPath)) continue;
		rows.push(...parseResultsJsonl(resultsPath));
	}
	return summarizeApiGameRows(rows);
}

export function countApiTelemetryTotals(
	telemetry: ReadonlyArray<Pick<ApiMatchTelemetry, "status">>,
): ApiTelemetryTotals {
	return {
		completed: telemetry.filter((entry) => entry.status === "ok").length,
		skipped: telemetry.filter((entry) => entry.status === "skipped").length,
		failed: telemetry.filter((entry) => entry.status === "failed").length,
	};
}

export function collectSuccessfulApiMatchups(
	telemetry: ReadonlyArray<Pick<ApiMatchTelemetry, "matchup" | "status">>,
): Set<string> {
	const matchups = new Set<string>();
	for (const entry of telemetry) {
		if (entry.status === "ok") {
			matchups.add(entry.matchup);
		}
	}
	return matchups;
}

export function buildApiLaneIntegritySummary(params: {
	telemetry: ReadonlyArray<Pick<ApiMatchTelemetry, "matchup" | "status">>;
	apiGamesPerMatchup: number;
	runScopedAggregate: Aggregate;
	runScopedMetrics: ApiLaneMetrics;
	rawAggregate: Aggregate;
	rawMetrics: ApiLaneMetrics;
}): ApiLaneIntegritySummary {
	const totals = countApiTelemetryTotals(params.telemetry);
	const successfulMatchups = collectSuccessfulApiMatchups(params.telemetry);
	const expectedGamesFromTelemetry =
		totals.completed * Math.max(0, params.apiGamesPerMatchup);
	return {
		notes: {
			telemetryTotalsUnit: "matchups",
			laneTotalsUnit: "games",
			primaryApiLaneScope: "runScopedSuccessfulMatchups",
		},
		runScoped: {
			successfulMatchupCount: successfulMatchups.size,
			expectedGamesFromTelemetry,
			aggregateGames: params.runScopedAggregate.games,
			metricsGames: params.runScopedMetrics.totalGames,
			aggregateMatchesMetrics:
				params.runScopedAggregate.games === params.runScopedMetrics.totalGames,
			aggregateMatchesTelemetryExpectation:
				params.runScopedAggregate.games === expectedGamesFromTelemetry,
		},
		rawOnDisk: {
			aggregateGames: params.rawAggregate.games,
			metricsGames: params.rawMetrics.totalGames,
			aggregateMatchesMetrics:
				params.rawAggregate.games === params.rawMetrics.totalGames,
		},
	};
}

function normalizeApiGraduationLane(
	value: string | undefined,
): ApiGraduationLane {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "api_smoke" || normalized === "smoke") {
		return "api_smoke";
	}
	return "api_full";
}

function completionRateThresholdForLane(lane: ApiGraduationLane): number {
	return lane === "api_smoke" ? 0.95 : 0.9;
}

export function buildApiGraduationSummary(params: {
	lane: ApiGraduationLane;
	telemetryTotals: ApiTelemetryTotals;
	illegalMoves: number;
	maxTurnsEndingRate: number;
	p95WallClockPerMatchMs: number;
	runName: string;
	runTimestamp: string;
	priorConsecutivePasses: number;
}): ApiGraduationSummary {
	const completionRateThreshold = completionRateThresholdForLane(params.lane);
	const attemptedMatchups =
		Math.max(0, params.telemetryTotals.completed) +
		Math.max(0, params.telemetryTotals.failed);
	const completionRate =
		attemptedMatchups > 0
			? Math.max(0, params.telemetryTotals.completed) / attemptedMatchups
			: 0;
	const checks = {
		illegalMoves: {
			operator: "==",
			threshold: 0,
			value: params.illegalMoves,
			pass: params.illegalMoves === 0,
		},
		completionRate: {
			operator: ">=",
			threshold: completionRateThreshold,
			value: completionRate,
			pass: completionRate >= completionRateThreshold,
		},
		maxTurnsEndingRate: {
			operator: "<=",
			threshold: 0.2,
			value: params.maxTurnsEndingRate,
			pass: params.maxTurnsEndingRate <= 0.2,
		},
		p95WallClockPerMatchMs: {
			operator: "<=",
			threshold: 360_000,
			value: params.p95WallClockPerMatchMs,
			pass: params.p95WallClockPerMatchMs <= 360_000,
		},
	} as const;
	const pass = Object.values(checks).every((check) => check.pass);
	const priorConsecutivePasses = Math.max(0, params.priorConsecutivePasses);
	const currentConsecutivePasses = pass ? priorConsecutivePasses + 1 : 0;
	const requiredConsecutivePasses = 2 as const;

	return {
		lane: params.lane,
		illegalMoves: params.illegalMoves,
		completionRate,
		maxTurnsEndingRate: params.maxTurnsEndingRate,
		p95WallClockPerMatchMs: params.p95WallClockPerMatchMs,
		p95WallClockPerMatchMinutes: params.p95WallClockPerMatchMs / 60_000,
		checks,
		pass,
		consecutivePassTracking: {
			contractKey: `api_graduation_v1:${params.lane}`,
			requiredConsecutivePasses,
			lane: params.lane,
			runName: params.runName,
			runTimestamp: params.runTimestamp,
			currentRunPass: pass,
			priorConsecutivePasses,
			currentConsecutivePasses,
			meetsRequiredConsecutivePasses:
				currentConsecutivePasses >= requiredConsecutivePasses,
		},
	};
}

function readApiGraduationHistory(
	filePath: string,
): ApiGraduationHistoryEntry[] {
	if (!existsSync(filePath)) return [];
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter(
				(entry): entry is ApiGraduationHistoryEntry =>
					typeof entry === "object" &&
					entry != null &&
					(entry as { lane?: unknown }).lane != null &&
					(entry as { runName?: unknown }).runName != null &&
					(entry as { runTimestamp?: unknown }).runTimestamp != null &&
					(entry as { pass?: unknown }).pass != null,
			)
			.map((entry) => ({
				lane:
					entry.lane === "api_smoke" || entry.lane === "api_full"
						? entry.lane
						: "api_full",
				runName: String(entry.runName),
				runTimestamp: String(entry.runTimestamp),
				pass: Boolean(entry.pass),
			}));
	} catch {
		return [];
	}
}

function writeApiGraduationHistory(
	filePath: string,
	entries: ApiGraduationHistoryEntry[],
): void {
	const parentDir = path.dirname(filePath);
	mkdirSync(parentDir, { recursive: true });
	writeFileSync(filePath, JSON.stringify(entries, null, 2));
}

export function countTrailingLanePasses(
	entries: ReadonlyArray<ApiGraduationHistoryEntry>,
	lane: ApiGraduationLane,
): number {
	const laneEntries = entries.filter((entry) => entry.lane === lane);
	let streak = 0;
	for (let idx = laneEntries.length - 1; idx >= 0; idx--) {
		const entry = laneEntries[idx];
		if (!entry) break;
		if (!entry.pass) break;
		streak += 1;
	}
	return streak;
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

function percentile(values: number[], fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = Math.max(
		0,
		Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1),
	);
	return sorted[idx] ?? 0;
}

async function runWithConcurrency<T>(
	items: T[],
	concurrency: number,
	worker: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	const workers = Array.from(
		{ length: Math.max(1, Math.min(concurrency, items.length || 1)) },
		() =>
			(async () => {
				while (true) {
					const idx = next;
					next += 1;
					if (idx >= items.length) return;
					const item = items[idx];
					if (!item) return;
					await worker(item);
				}
			})(),
	);
	await Promise.all(workers);
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
	const contractOnlyApiPhase = withApi && skipFastLane;
	const resume = parseBoolArg("--resume", false);
	const gamesPerMatchup = Number.parseInt(
		parseArg("--gamesPerMatchup") ?? "4",
		10,
	);
	const apiGamesPerMatchup = Number.parseInt(
		parseArg("--apiGamesPerMatchup") ?? "1",
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
	const parsedApiParallelMatchups = Number.parseInt(
		parseArg("--apiParallelMatchups") ?? "2",
		10,
	);
	const apiParallelMatchups = Number.isNaN(parsedApiParallelMatchups)
		? 2
		: Math.min(3, Math.max(1, parsedApiParallelMatchups));
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
	const apiCommandTimeoutMs = Number.parseInt(
		parseArg("--apiCommandTimeoutMs") ?? "240000",
		10,
	);
	const apiCommandRetries = Number.parseInt(
		parseArg("--apiCommandRetries") ?? "1",
		10,
	);
	const apiContinueOnError = parseArg("--apiContinueOnError") !== "false";
	const apiGraduationLane = normalizeApiGraduationLane(parseArg("--apiLane"));
	const apiMaxP95Turns = Number.parseFloat(
		parseArg("--apiMaxP95Turns") ?? "75",
	);
	const apiMaxMaxTurnsRate = Number.parseFloat(
		parseArg("--apiMaxMaxTurnsRate") ?? "0.1",
	);
	const apiMaxDrawRate = Number.parseFloat(
		parseArg("--apiMaxDrawRate") ?? "0.2",
	);
	const apiRuntimeBudgetMs = Number.parseInt(
		parseArg("--apiRuntimeBudgetMs") ?? "600000",
		10,
	);
	const maxDrawRate = Number.parseFloat(parseArg("--maxDrawRate") ?? "0.02");
	const minTempoSpread = Number.parseFloat(
		parseArg("--minTempoSpread") ?? "10",
	);
	const minProfileSeparation = Number.parseFloat(
		parseArg("--minProfileSeparation") ?? "0.04",
	);
	const minArchetypeSeparation = Number.parseFloat(
		parseArg("--minArchetypeSeparation") ?? String(minProfileSeparation),
	);
	const minMacroIndex = Number.parseFloat(parseArg("--minMacroIndex") ?? "0.3");
	const minTerrainLeverage = Number.parseFloat(
		parseArg("--minTerrainLeverage") ?? "0.3",
	);
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const runName = parseArg("--name") ?? `benchmark_v2_${timestamp}`;
	const outputBaseInSim = path.join("results", runName);
	const outputBaseAbs = path.join(simDir, outputBaseInSim);
	const apiHistoryPath = path.join(
		simDir,
		"results",
		"api_graduation_history.json",
	);
	const apiGraduationHistory = withApi
		? readApiGraduationHistory(apiHistoryPath)
		: [];
	const priorConsecutivePasses = withApi
		? countTrailingLanePasses(apiGraduationHistory, apiGraduationLane)
		: 0;

	const matchups = collectMatchups(baseSeed);
	mkdirSync(outputBaseAbs, { recursive: true });

	console.log(`Benchmark output: ${outputBaseAbs}`);
	console.log(`Matchups: ${matchups.length}`);
	console.log(`Games per matchup: ${gamesPerMatchup}`);
	console.log(`Skip fast lane: ${skipFastLane}`);
	console.log(`Resume completed matchups: ${resume}`);
	console.log(`API parallel matchups: ${apiParallelMatchups}`);
	const apiFailures: string[] = [];
	const skippedFastMatchups: string[] = [];
	const skippedApiMatchups: string[] = [];
	const apiMatchTelemetry: ApiMatchTelemetry[] = [];

	const fastLaneDirInSim = path.join(outputBaseInSim, "fast_lane");
	if (!skipFastLane) {
		for (const matchup of matchups) {
			const output = path.join(
				fastLaneDirInSim,
				`${matchup.scenario}__${matchup.bot1}_vs_${matchup.bot2}`,
			);
			if (
				shouldSkipCompletedMatchup(
					path.join(simDir, output),
					gamesPerMatchup,
					resume,
				)
			) {
				skippedFastMatchups.push(path.basename(output));
				continue;
			}
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
					"--storeFullPrompt",
					"true",
					"--storeFullOutput",
					"true",
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
		const apiTasks: Array<{
			scenario: Scenario;
			bot1: Strategy;
			bot2: Strategy;
			seed: number;
			output: string;
			matchup: string;
		}> = [];
		for (const scenario of scenarios) {
			for (const [bot1, bot2] of apiPairs) {
				const output = path.join(
					apiLaneDirInSim,
					`${scenario}__${bot1}_vs_${bot2}`,
				);
				const matchup = `${scenario}__${bot1}_vs_${bot2}`;
				if (
					shouldSkipCompletedMatchup(
						path.join(simDir, output),
						apiGamesPerMatchup,
						resume,
					)
				) {
					skippedApiMatchups.push(path.basename(output));
					apiMatchTelemetry.push({
						matchup,
						scenario,
						bot1,
						bot2,
						seed: apiSeed,
						output,
						status: "skipped",
						durationMs: 0,
						attempts: 0,
					});
					apiSeed += 1;
					continue;
				}
				apiTasks.push({ scenario, bot1, bot2, seed: apiSeed, output, matchup });
				apiSeed += 1;
			}
		}
		await runWithConcurrency(apiTasks, apiParallelMatchups, async (task) => {
			const result = await runCmdAsync(
				repoRoot,
				[
					"-C",
					"apps/sim",
					"exec",
					"tsx",
					"src/cli.ts",
					"mass",
					"--games",
					String(apiGamesPerMatchup),
					"--parallel",
					"1",
					"--output",
					task.output,
					"--artifactDir",
					path.join(task.output, "artifacts"),
					"--storeFullPrompt",
					"true",
					"--storeFullOutput",
					"true",
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
					task.scenario,
					"--bot1",
					"llm",
					"--bot2",
					"llm",
					"--model1",
					model,
					"--model2",
					model,
					"--strategy1",
					task.bot1,
					"--strategy2",
					task.bot2,
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
					String(task.seed),
					"--quiet",
				],
				dryRun,
				{
					timeoutMs: Math.max(0, apiCommandTimeoutMs),
					retries: Math.max(0, apiCommandRetries),
					continueOnError: apiContinueOnError,
				},
			);
			const status: ApiMatchStatus = result.ok ? "ok" : "failed";
			if (!result.ok) {
				apiFailures.push(task.matchup);
			}
			apiMatchTelemetry.push({
				matchup: task.matchup,
				scenario: task.scenario,
				bot1: task.bot1,
				bot2: task.bot2,
				seed: task.seed,
				output: task.output,
				status,
				durationMs: result.durationMs,
				attempts: result.attempts,
			});
		});
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
	if (existsSync(fastLaneAbs)) {
		for (const entry of readdirSync(fastLaneAbs)) {
			const lanePath = path.join(fastLaneAbs, entry);
			try {
				behaviorByMatchup[entry] = analyzeBehaviorFromArtifacts(lanePath);
			} catch {
				// Ignore entries that do not contain artifact payloads.
			}
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
	let resourceCurveSeparationSum = 0;
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
			const aSpend =
				behaviorByMatchup[aName]?.archetypeSeparation.resourceSpendCurveSignal;
			const bSpend =
				behaviorByMatchup[bName]?.archetypeSeparation.resourceSpendCurveSignal;
			const spendP = [aSpend?.early ?? 0, aSpend?.mid ?? 0, aSpend?.late ?? 0];
			const spendQ = [bSpend?.early ?? 0, bSpend?.mid ?? 0, bSpend?.late ?? 0];
			resourceCurveSeparationSum += jsDivergence(spendP, spendQ);
			pairCount++;
		}
	}
	const actionProfileSeparation = pairCount > 0 ? separationSum / pairCount : 0;
	const resourceSpendCurveSeparation =
		pairCount > 0 ? resourceCurveSeparationSum / pairCount : 0;
	const archetypeSeparationCombined =
		(actionProfileSeparation + resourceSpendCurveSeparation) / 2;

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

	const weightedNullable = (
		selector: (
			metrics: ReturnType<typeof analyzeBehaviorFromArtifacts>,
		) => number | null,
	): { value: number | null; weightedGames: number } => {
		let weightedSum = 0;
		let weightedGames = 0;
		for (const name of matchupNames) {
			const metrics = behaviorByMatchup[name];
			if (!metrics) continue;
			const value = selector(metrics);
			if (value == null || Number.isNaN(value)) continue;
			weightedSum += value * metrics.games;
			weightedGames += metrics.games;
		}
		return {
			value: weightedGames > 0 ? weightedSum / weightedGames : null,
			weightedGames,
		};
	};

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

	const macroIndexSummary = {
		avgScore: weightedNullable((metrics) => metrics.macroIndex.score),
		avgFirstRecruitTurn: weightedNullable(
			(metrics) => metrics.macroIndex.recruitTiming.meanFirstRecruitTurn,
		),
		avgNodeControlDurationProxy: weightedNullable(
			(metrics) =>
				metrics.macroIndex.nodeControlDurationProxy.avgControlledNodeShare,
		),
	};
	const terrainLeverageSummary = {
		avgLeverageRate: weightedNullable(
			(metrics) => metrics.terrainLeverage.leverageRate,
		),
		totalFightsInitiated: matchupNames.reduce(
			(sum, name) =>
				sum + (behaviorByMatchup[name]?.terrainLeverage.fightsInitiated ?? 0),
			0,
		),
		totalFightsWithTerrainData: matchupNames.reduce(
			(sum, name) =>
				sum +
				(behaviorByMatchup[name]?.terrainLeverage.fightsWithTerrainData ?? 0),
			0,
		),
	};
	const fortifyROISummary = {
		avgRoi: weightedNullable((metrics) => metrics.fortifyROI.roi),
		totalWoodSpentEstimate: matchupNames.reduce(
			(sum, name) =>
				sum + (behaviorByMatchup[name]?.fortifyROI.woodSpentEstimate ?? 0),
			0,
		),
		totalDamagePreventedEstimate: matchupNames.reduce(
			(sum, name) =>
				sum +
				(behaviorByMatchup[name]?.fortifyROI.damagePreventedEstimate ?? 0),
			0,
		),
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
		archetypeSeparation: {
			threshold: minArchetypeSeparation,
			value: archetypeSeparationCombined,
			pass: archetypeSeparationCombined >= minArchetypeSeparation,
		},
		macroIndex: {
			threshold: minMacroIndex,
			value: macroIndexSummary.avgScore.value ?? 0,
			pass:
				macroIndexSummary.avgScore.value == null
					? false
					: macroIndexSummary.avgScore.value >= minMacroIndex,
		},
		terrainLeverage: {
			threshold: minTerrainLeverage,
			value: terrainLeverageSummary.avgLeverageRate.value ?? 0,
			pass:
				terrainLeverageSummary.avgLeverageRate.value == null
					? false
					: terrainLeverageSummary.avgLeverageRate.value >= minTerrainLeverage,
		},
	};
	const apiLaneAbs = path.join(outputBaseAbs, "api_lane");
	const successfulApiMatchups = withApi
		? collectSuccessfulApiMatchups(apiMatchTelemetry)
		: null;
	const apiLaneAggregateRaw = withApi ? aggregateSummaries(apiLaneAbs) : null;
	const apiLaneMetricsRaw = withApi
		? aggregateApiLaneMetrics(apiLaneAbs)
		: null;
	const apiLaneAggregateRunScoped = withApi
		? aggregateSummaries(apiLaneAbs, successfulApiMatchups ?? undefined)
		: null;
	const apiLaneMetricsRunScoped = withApi
		? aggregateApiLaneMetrics(apiLaneAbs, successfulApiMatchups ?? undefined)
		: null;
	const apiLaneAggregate = apiLaneAggregateRunScoped;
	const apiLaneMetrics = apiLaneMetricsRunScoped;
	const apiTelemetryTotals = withApi
		? countApiTelemetryTotals(apiMatchTelemetry)
		: null;
	const apiLaneIntegrity = withApi
		? buildApiLaneIntegritySummary({
				telemetry: apiMatchTelemetry,
				apiGamesPerMatchup,
				runScopedAggregate: apiLaneAggregateRunScoped ?? {
					games: 0,
					draws: 0,
					illegalMoves: 0,
					avgTurns: 0,
					byScenario: {},
				},
				runScopedMetrics: apiLaneMetricsRunScoped ?? summarizeApiGameRows([]),
				rawAggregate: apiLaneAggregateRaw ?? {
					games: 0,
					draws: 0,
					illegalMoves: 0,
					avgTurns: 0,
					byScenario: {},
				},
				rawMetrics: apiLaneMetricsRaw ?? summarizeApiGameRows([]),
			})
		: null;
	const apiAttemptedDurations = apiMatchTelemetry
		.filter((m) => m.status !== "skipped")
		.map((m) => m.durationMs);
	const apiDurationStats = {
		avg:
			apiAttemptedDurations.length > 0
				? apiAttemptedDurations.reduce((sum, v) => sum + v, 0) /
					apiAttemptedDurations.length
				: 0,
		p95: percentile(apiAttemptedDurations, 0.95),
		total: apiAttemptedDurations.reduce((sum, v) => sum + v, 0),
	};
	const apiGates =
		withApi && !contractOnlyApiPhase
			? {
					p95Turns: {
						threshold: apiMaxP95Turns,
						value: apiLaneMetrics?.turns.p95 ?? 0,
						pass: (apiLaneMetrics?.turns.p95 ?? 0) <= apiMaxP95Turns,
					},
					maxTurnsEndingRate: {
						threshold: apiMaxMaxTurnsRate,
						value: apiLaneMetrics?.maxTurnsEndingRate ?? 0,
						pass:
							(apiLaneMetrics?.maxTurnsEndingRate ?? 0) <= apiMaxMaxTurnsRate,
					},
					drawRate: {
						threshold: apiMaxDrawRate,
						value: apiLaneMetrics?.drawRate ?? 0,
						pass: (apiLaneMetrics?.drawRate ?? 0) <= apiMaxDrawRate,
					},
					runtimeBudgetMs: {
						threshold: Math.max(0, apiRuntimeBudgetMs),
						value: apiDurationStats.total,
						pass: apiDurationStats.total <= Math.max(0, apiRuntimeBudgetMs),
					},
				}
			: null;
	const summaryTimestamp = new Date().toISOString();
	const apiGraduation = withApi
		? buildApiGraduationSummary({
				lane: apiGraduationLane,
				telemetryTotals: apiTelemetryTotals ?? {
					completed: 0,
					skipped: 0,
					failed: 0,
				},
				illegalMoves: apiLaneAggregate?.illegalMoves ?? 0,
				maxTurnsEndingRate: apiLaneMetrics?.maxTurnsEndingRate ?? 0,
				p95WallClockPerMatchMs: apiDurationStats.p95,
				runName,
				runTimestamp: summaryTimestamp,
				priorConsecutivePasses,
			})
		: null;

	const benchmarkSummary = {
		version: "benchmark_v2",
		timestamp: summaryTimestamp,
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
			apiGraduationLane: withApi ? apiGraduationLane : null,
			apiModel: withApi ? model : null,
			apiGateThresholds:
				withApi && !contractOnlyApiPhase
					? {
							apiMaxP95Turns,
							apiMaxMaxTurnsRate,
							apiMaxDrawRate,
							apiRuntimeBudgetMs: Math.max(0, apiRuntimeBudgetMs),
						}
					: null,
			apiContractMode: contractOnlyApiPhase ? "minimal_graduation_v1" : null,
			behaviorGateThresholds: {
				maxDrawRate,
				minTempoSpread,
				minProfileSeparation,
				minArchetypeSeparation,
				minMacroIndex,
				minTerrainLeverage,
			},
		},
		fastLane: fastLaneAggregate,
		apiLane: apiLaneAggregate,
		apiLaneMetrics,
		apiLaneRawOnDisk: apiLaneAggregateRaw,
		apiLaneMetricsRawOnDisk: apiLaneMetricsRaw,
		apiGraduation,
		apiLaneScope: withApi
			? {
					primary: "runScopedSuccessfulMatchups",
					runScopedSuccessfulMatchups: [
						...(successfulApiMatchups ?? []),
					].sort(),
					runScopedSuccessfulMatchupCount: successfulApiMatchups?.size ?? 0,
					rawOnDiskMatchupCount: existsSync(apiLaneAbs)
						? readdirSync(apiLaneAbs).length
						: 0,
					legacyCompatibilityNote:
						"apiLane and apiLaneMetrics are run-scoped; use apiLaneRawOnDisk/apiLaneMetricsRawOnDisk for raw disk totals.",
				}
			: null,
		behaviorByMatchup,
		metaDiversity: {
			scenarioTempoSpread,
			actionProfileSeparation,
			archetypeSeparation: {
				actionMix: actionProfileSeparation,
				resourceSpendCurve: resourceSpendCurveSeparation,
				combined: archetypeSeparationCombined,
			},
			upgradeSummary,
			macroIndexSummary,
			terrainLeverageSummary,
			fortifyROISummary,
		},
		apiReliability: withApi
			? {
					matchups: [...apiMatchTelemetry].sort((a, b) =>
						a.matchup.localeCompare(b.matchup),
					),
					totals: apiTelemetryTotals ?? {
						completed: 0,
						skipped: 0,
						failed: 0,
					},
					totalsLabel: "current-run matchup counts",
					durationMs: apiDurationStats,
					failedMatchups: apiFailures,
					failedMatchupCount: apiFailures.length,
					skippedApiMatchups,
					skippedApiMatchupCount: skippedApiMatchups.length,
					apiParallelMatchups,
					apiCommandTimeoutMs: Math.max(0, apiCommandTimeoutMs),
					apiCommandRetries: Math.max(0, apiCommandRetries),
					integrity: apiLaneIntegrity,
				}
			: null,
		fastLaneExecution: {
			skippedFastMatchups,
			skippedFastMatchupCount: skippedFastMatchups.length,
		},
		gates,
		apiGates,
	};

	const summaryPath = path.join(outputBaseAbs, "benchmark-summary.json");
	writeFileSync(summaryPath, JSON.stringify(benchmarkSummary, null, 2));
	if (withApi && apiGraduation) {
		const nextHistory: ApiGraduationHistoryEntry[] = [
			...apiGraduationHistory,
			{
				lane: apiGraduationLane,
				runName,
				runTimestamp: summaryTimestamp,
				pass: apiGraduation.pass,
			},
		];
		writeApiGraduationHistory(apiHistoryPath, nextHistory.slice(-500));
	}

	console.log("\nBenchmark complete.");
	console.log(`Summary: ${summaryPath}`);
}

const isExecutedDirectly = (() => {
	const invokedPath = process.argv[1];
	if (!invokedPath) return false;
	try {
		return (
			path.resolve(invokedPath) === path.resolve(fileURLToPath(import.meta.url))
		);
	} catch {
		return false;
	}
})();

if (isExecutedDirectly) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
