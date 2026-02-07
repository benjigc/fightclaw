import * as os from "node:os";
import { z } from "zod";

/** Configuration for simulation parameters */
export interface SimulationOptions {
	/** Number of matches to run */
	games: number;
	/** Maximum turns per match */
	maxTurns: number;
	/** Number of parallel workers (default: CPU cores - 1) */
	parallelism: number;
	/** Random seed for deterministic results */
	seed: number;
	/** Output directory for results */
	outputDir: string;
	/** Anomaly detection thresholds */
	anomalyThresholds: AnomalyThresholds;
}

/** Configurable thresholds for anomaly detection */
export interface AnomalyThresholds {
	/** IQR multiplier for outlier detection */
	outlierIqrMultiplier: number;
	/** Minimum games for statistical significance */
	minGamesForSignificance: number;
	/** Turn threshold for instant surrender detection */
	instantSurrenderTurns: number;
	/** Illegal move threshold for spree detection */
	illegalMoveSpreeThreshold: number;
	/** Repetition threshold for same move detection */
	sameMoveRepetitionThreshold: number;
	/** Win rate threshold for extreme win rate detection (0-1) */
	extremeWinRateThreshold: number;
	/** Draw percentage threshold for draw pattern detection (0-1) */
	drawPatternThreshold: number;
}

/** Types of anomalies that can be detected */
export type AnomalyType =
	| "instant_surrender"
	| "illegal_move_spree"
	| "same_move_repetition"
	| "timeout_pattern"
	| "deterministic_loop"
	| "extreme_win_rate"
	| "draw_pattern"
	| "statistical_outlier";

/** Anomaly detected during simulation */
export interface Anomaly {
	type: AnomalyType;
	severity: "info" | "warn" | "critical";
	description: string;
	seed: number;
	context: Record<string, unknown>;
}

/** Win rate statistics with confidence interval */
export interface WinRateStats {
	wins: number;
	losses: number;
	total: number;
	rate: number;
	ci95Lower: number;
	ci95Upper: number;
}

/** Match length statistics */
export interface LengthStats {
	min: number;
	max: number;
	mean: number;
	median: number;
	stdDev: number;
	p25: number;
	p75: number;
	p95: number;
	outliers: number[];
}

/** Aggregate statistics across all matches */
export interface SimulationStats {
	totalGames: number;
	completedGames: number;
	draws: number;
	totalIllegalMoves: number;
	wins: Record<string, number>;
	winRates: Record<string, WinRateStats>;
	matchLengths: LengthStats;
	moveCounts: Record<string, number>;
	totalAnomalies: number;
	anomaliesByType: Record<AnomalyType, number>;
	anomaliesBySeverity: Record<"info" | "warn" | "critical", number>;
	strategyDistribution: Record<string, number>;
}

/** Schema for validating simulation options */
export const SimulationOptionsSchema = z.object({
	games: z.number().positive("games must be a positive number"),
	maxTurns: z.number().positive("maxTurns must be a positive number"),
	parallelism: z.number().positive("parallelism must be a positive number"),
	seed: z.number().int("seed must be an integer"),
	outputDir: z.string().min(1, "outputDir cannot be empty"),
	anomalyThresholds: z.object({
		outlierIqrMultiplier: z
			.number()
			.positive("outlierIqrMultiplier must be positive"),
		minGamesForSignificance: z
			.number()
			.positive("minGamesForSignificance must be positive"),
		instantSurrenderTurns: z
			.number()
			.positive("instantSurrenderTurns must be positive"),
		illegalMoveSpreeThreshold: z
			.number()
			.nonnegative("illegalMoveSpreeThreshold cannot be negative"),
		sameMoveRepetitionThreshold: z
			.number()
			.positive("sameMoveRepetitionThreshold must be positive"),
		extremeWinRateThreshold: z
			.number()
			.min(0)
			.max(1, "extremeWinRateThreshold must be between 0 and 1"),
		drawPatternThreshold: z
			.number()
			.min(0)
			.max(1, "drawPatternThreshold must be between 0 and 1"),
	}),
});

/** Default configuration values */
export const defaultSimulationOptions: SimulationOptions = {
	games: 10000,
	maxTurns: 200,
	parallelism: Math.max(1, os.cpus().length - 1),
	seed: 42,
	outputDir: "./results",
	anomalyThresholds: {
		outlierIqrMultiplier: 1.5,
		minGamesForSignificance: 10,
		instantSurrenderTurns: 5,
		illegalMoveSpreeThreshold: 10,
		sameMoveRepetitionThreshold: 10,
		extremeWinRateThreshold: 0.95,
		drawPatternThreshold: 0.5,
	},
};

/**
 * Creates a full SimulationOptions from partial options, applying defaults
 */
export function createSimulationOptions(
	options: Partial<SimulationOptions> = {},
): SimulationOptions {
	const merged = {
		...defaultSimulationOptions,
		...options,
		anomalyThresholds: {
			...defaultSimulationOptions.anomalyThresholds,
			...options.anomalyThresholds,
		},
	};

	const result = SimulationOptionsSchema.safeParse(merged);

	if (!result.success) {
		const errors = result.error.errors
			.map((e) => `${e.path.join(".")}: ${e.message}`)
			.join("; ");
		throw new Error(`Invalid simulation options: ${errors}`);
	}

	return merged;
}
