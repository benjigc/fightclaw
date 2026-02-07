import type { Anomaly, LengthStats, WinRateStats } from "../simulation/config";

/**
 * Statistical analyzer for detecting anomalies in simulation results.
 * Uses IQR-based outlier detection and Wilson score intervals.
 */
export class StatisticalAnalyzer {
	private static readonly Z95 = 1.96;

	/**
	 * Detects outliers using the Interquartile Range (IQR) method.
	 */
	detectOutliers(data: number[], threshold = 1.5): number[] {
		if (data.length < 4) {
			return [];
		}

		const sorted = [...data].sort((a, b) => a - b);
		const q1 = this.percentile(sorted, 0.25);
		const q3 = this.percentile(sorted, 0.75);
		const iqr = q3 - q1;

		const lowerBound = q1 - threshold * iqr;
		const upperBound = q3 + threshold * iqr;

		return data.filter((value) => value < lowerBound || value > upperBound);
	}

	/**
	 * Detects unusual win rates across players.
	 */
	detectUnusualWinRates(winRates: Record<string, number>): Anomaly[] {
		const anomalies: Anomaly[] = [];
		const players = Object.keys(winRates);

		if (players.length < 2) {
			return anomalies;
		}

		const expectedRate = 1 / players.length;
		const values = Object.values(winRates);

		const mean = values.reduce((a, b) => a + b, 0) / values.length;
		const variance =
			values.reduce((sum, val) => sum + (val - mean) ** 2, 0) / values.length;
		const stdDev = Math.sqrt(variance);

		for (const [player, rate] of Object.entries(winRates)) {
			const deviation = Math.abs(rate - expectedRate);
			const zScore = stdDev > 0 ? deviation / stdDev : 0;

			let severity: "info" | "warn" | "critical";
			if (zScore > 2) {
				severity = "critical";
			} else if (zScore > 1) {
				severity = "warn";
			} else {
				severity = "info";
			}

			if (deviation > 0.1) {
				anomalies.push({
					type: "extreme_win_rate",
					severity,
					description: `Player "${player}" has unusual win rate of ${(rate * 100).toFixed(1)}% (expected ~${(expectedRate * 100).toFixed(1)}%, deviation: ${(deviation * 100).toFixed(1)}%)`,
					seed: 0,
					context: {
						player,
						winRate: rate,
						expectedRate,
						deviation,
						zScore,
					},
				});
			}
		}

		return anomalies;
	}

	/**
	 * Detects unusual match lengths using IQR-based outlier detection.
	 */
	detectUnusualLengths(matchLengths: number[]): Anomaly[] {
		const anomalies: Anomaly[] = [];

		if (matchLengths.length < 4) {
			return anomalies;
		}

		const sorted = [...matchLengths].sort((a, b) => a - b);
		const q1 = this.percentile(sorted, 0.25);
		const q3 = this.percentile(sorted, 0.75);
		const iqr = q3 - q1;
		const median = this.percentile(sorted, 0.5);
		const stdDev = this.standardDeviation(matchLengths);

		const lowerBound = q1 - 1.5 * iqr;
		const upperBound = q3 + 1.5 * iqr;

		for (const value of matchLengths) {
			if (value < lowerBound || value > upperBound) {
				const deviation = Math.abs(value - median);
				const zScore = stdDev > 0 ? deviation / stdDev : 0;

				let severity: "info" | "warn" | "critical";
				if (zScore > 2) {
					severity = "critical";
				} else if (zScore > 1) {
					severity = "warn";
				} else {
					severity = "info";
				}

				anomalies.push({
					type: "statistical_outlier",
					severity,
					description: `Match length ${value} turns is ${value < lowerBound ? "unusually short" : "unusually long"} (median: ${median.toFixed(1)}, IQR: ${iqr.toFixed(1)})`,
					seed: 0,
					context: {
						length: value,
						median,
						q1,
						q3,
						iqr,
						lowerBound,
						upperBound,
						zScore,
					},
				});
			}
		}

		return anomalies;
	}

	/**
	 * Computes comprehensive statistics for match lengths.
	 */
	computeLengthStats(lengths: number[]): LengthStats {
		if (lengths.length === 0) {
			return {
				min: 0,
				max: 0,
				mean: 0,
				median: 0,
				stdDev: 0,
				p25: 0,
				p75: 0,
				p95: 0,
				outliers: [],
			};
		}

		const sorted = [...lengths].sort((a, b) => a - b);
		const min = sorted[0] ?? 0;
		const max = sorted[sorted.length - 1] ?? 0;
		const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
		const median = this.percentile(sorted, 0.5);
		const stdDev = this.standardDeviation(lengths);
		const p25 = this.percentile(sorted, 0.25);
		const p75 = this.percentile(sorted, 0.75);
		const p95 = this.percentile(sorted, 0.95);

		const outliers = this.detectOutliers(lengths, 1.5);

		return {
			min,
			max,
			mean: Number(mean.toFixed(2)),
			median: Number(median.toFixed(2)),
			stdDev: Number(stdDev.toFixed(2)),
			p25: Number(p25.toFixed(2)),
			p75: Number(p75.toFixed(2)),
			p95: Number(p95.toFixed(2)),
			outliers,
		};
	}

	/**
	 * Computes win rate statistics with Wilson score 95% confidence intervals.
	 */
	computeWinRateStats(
		results: { winner: string | null }[],
		playerIds: string[],
	): Record<string, WinRateStats> {
		const stats: Record<
			string,
			{ wins: number; losses: number; total: number }
		> = {};

		for (const id of playerIds) {
			stats[id] = { wins: 0, losses: 0, total: 0 };
		}

		for (const result of results) {
			for (const id of playerIds) {
				const s = stats[id];
				if (!s) continue;
				s.total++;
				if (result.winner === id) {
					s.wins++;
				} else if (result.winner !== null) {
					s.losses++;
				}
			}
		}

		const winRateStats: Record<string, WinRateStats> = {};
		for (const [player, s] of Object.entries(stats)) {
			const rate = s.total > 0 ? s.wins / s.total : 0;
			const { lower, upper } = this.wilsonScoreInterval(s.wins, s.total);

			winRateStats[player] = {
				wins: s.wins,
				losses: s.losses,
				total: s.total,
				rate: Number(rate.toFixed(4)),
				ci95Lower: Number(lower.toFixed(4)),
				ci95Upper: Number(upper.toFixed(4)),
			};
		}

		return winRateStats;
	}

	/**
	 * Generates a human-readable summary text.
	 */
	generateSummaryText(
		totalMatches: number,
		winRateStats: Record<string, WinRateStats>,
		lengthStats: LengthStats,
		anomalyCount: number,
	): string {
		const lines: string[] = [];

		lines.push(`Analysis Report: ${totalMatches} matches analyzed`);
		lines.push(`Total anomalies: ${anomalyCount}`);

		const winRateEntries = Object.entries(winRateStats);
		if (winRateEntries.length > 0) {
			lines.push("\nWin Rates:");
			for (const [player, stats] of winRateEntries) {
				lines.push(
					`  ${player}: ${(stats.rate * 100).toFixed(1)}% (${stats.wins}/${stats.total}) [95% CI: ${(stats.ci95Lower * 100).toFixed(1)}%-${(stats.ci95Upper * 100).toFixed(1)}%]`,
				);
			}
		}

		lines.push("\nMatch Lengths:");
		lines.push(
			`  Mean: ${lengthStats.mean}, Median: ${lengthStats.median}, StdDev: ${lengthStats.stdDev}`,
		);
		lines.push(
			`  Range: ${lengthStats.min}-${lengthStats.max} (95th percentile: ${lengthStats.p95})`,
		);
		if (lengthStats.outliers.length > 0) {
			lines.push(`  Outliers: ${lengthStats.outliers.length} detected`);
		}

		return lines.join("\n");
	}

	private wilsonScoreInterval(
		successes: number,
		trials: number,
	): { lower: number; upper: number } {
		if (trials === 0) {
			return { lower: 0, upper: 1 };
		}

		const z = StatisticalAnalyzer.Z95;
		const p = successes / trials;
		const z2 = z * z;
		const n = trials;

		const denominator = 1 + z2 / n;
		const centre = (p + z2 / (2 * n)) / denominator;
		const halfWidth =
			(z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;

		return {
			lower: Math.max(0, centre - halfWidth),
			upper: Math.min(1, centre + halfWidth),
		};
	}

	private percentile(sorted: number[], p: number): number {
		if (sorted.length === 0) return 0;
		if (sorted.length === 1) return sorted[0] ?? 0;

		const index = (sorted.length - 1) * p;
		const lower = Math.floor(index);
		const upper = Math.ceil(index);

		if (lower >= sorted.length) {
			return sorted[sorted.length - 1] ?? 0;
		}

		if (upper >= sorted.length) {
			return sorted[lower] ?? 0;
		}

		const lowerVal = sorted[lower] ?? 0;
		const upperVal = sorted[upper] ?? 0;
		const weight = index - lower;

		return lowerVal * (1 - weight) + upperVal * weight;
	}

	private standardDeviation(values: number[]): number {
		if (values.length === 0) return 0;
		const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
		const squaredDiffs = values.map((v) => (v - mean) ** 2);
		const avgSquaredDiff =
			squaredDiffs.reduce((sum, v) => sum + v, 0) / values.length;
		return Math.sqrt(avgSquaredDiff);
	}
}
