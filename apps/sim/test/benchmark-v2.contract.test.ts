import { describe, expect, test } from "bun:test";
import {
	buildApiGraduationSummary,
	buildApiLaneIntegritySummary,
	countTrailingLanePasses,
	summarizeApiGameRows,
} from "../scripts/benchmark-v2";

describe("benchmark-v2 api graduation contract", () => {
	test("applies smoke/full completion thresholds and wall-clock contract", () => {
		const smoke = buildApiGraduationSummary({
			lane: "api_smoke",
			telemetryTotals: { completed: 19, failed: 1, skipped: 0 },
			illegalMoves: 0,
			maxTurnsEndingRate: 0.2,
			p95WallClockPerMatchMs: 350_000,
			runName: "smoke_run",
			runTimestamp: "2026-02-18T00:00:00.000Z",
			priorConsecutivePasses: 1,
		});
		expect(smoke.checks.completionRate.pass).toBe(true);
		expect(smoke.checks.p95WallClockPerMatchMs.pass).toBe(true);
		expect(smoke.consecutivePassTracking.currentConsecutivePasses).toBe(2);
		expect(smoke.consecutivePassTracking.meetsRequiredConsecutivePasses).toBe(
			true,
		);

		const full = buildApiGraduationSummary({
			lane: "api_full",
			telemetryTotals: { completed: 9, failed: 1, skipped: 0 },
			illegalMoves: 0,
			maxTurnsEndingRate: 0.21,
			p95WallClockPerMatchMs: 370_000,
			runName: "full_run",
			runTimestamp: "2026-02-18T00:00:00.000Z",
			priorConsecutivePasses: 3,
		});
		expect(full.checks.completionRate.pass).toBe(true);
		expect(full.checks.maxTurnsEndingRate.pass).toBe(false);
		expect(full.checks.p95WallClockPerMatchMs.pass).toBe(false);
		expect(full.consecutivePassTracking.currentConsecutivePasses).toBe(0);
		expect(full.consecutivePassTracking.meetsRequiredConsecutivePasses).toBe(
			false,
		);
	});

	test("summarizes api rows for max-turn and draw rate contract signals", () => {
		const metrics = summarizeApiGameRows([
			{ turns: 80, winner: "P1", reason: "maxTurns" },
			{ turns: 60, winner: "P2", reason: "terminal" },
			{ turns: 80, winner: null, reason: "maxTurns" },
		]);
		expect(metrics.totalGames).toBe(3);
		expect(metrics.draws).toBe(1);
		expect(metrics.maxTurnsEndings).toBe(2);
		expect(metrics.maxTurnsEndingRate).toBeCloseTo(2 / 3, 5);
		expect(metrics.turns.p95).toBe(80);
	});

	test("reports run-scoped integrity against telemetry expectations", () => {
		const integrity = buildApiLaneIntegritySummary({
			telemetry: [
				{ matchup: "m1", status: "ok" },
				{ matchup: "m2", status: "ok" },
				{ matchup: "m3", status: "failed" },
			],
			apiGamesPerMatchup: 1,
			runScopedAggregate: {
				games: 2,
				draws: 0,
				illegalMoves: 0,
				avgTurns: 50,
				byScenario: {},
			},
			runScopedMetrics: {
				totalGames: 2,
				draws: 0,
				maxTurnsEndings: 0,
				drawRate: 0,
				maxTurnsEndingRate: 0,
				turns: { mean: 50, p95: 60, max: 60 },
			},
			rawAggregate: {
				games: 3,
				draws: 1,
				illegalMoves: 0,
				avgTurns: 60,
				byScenario: {},
			},
			rawMetrics: {
				totalGames: 3,
				draws: 1,
				maxTurnsEndings: 1,
				drawRate: 1 / 3,
				maxTurnsEndingRate: 1 / 3,
				turns: { mean: 60, p95: 80, max: 80 },
			},
		});
		expect(integrity.runScoped.expectedGamesFromTelemetry).toBe(2);
		expect(integrity.runScoped.aggregateMatchesTelemetryExpectation).toBe(true);
		expect(integrity.rawOnDisk.aggregateMatchesMetrics).toBe(true);
	});

	test("counts trailing pass streak by lane", () => {
		const streak = countTrailingLanePasses(
			[
				{
					lane: "api_smoke",
					runName: "a",
					runTimestamp: "t1",
					pass: true,
				},
				{
					lane: "api_full",
					runName: "b",
					runTimestamp: "t2",
					pass: true,
				},
				{
					lane: "api_smoke",
					runName: "c",
					runTimestamp: "t3",
					pass: true,
				},
				{
					lane: "api_smoke",
					runName: "d",
					runTimestamp: "t4",
					pass: false,
				},
				{
					lane: "api_smoke",
					runName: "e",
					runTimestamp: "t5",
					pass: true,
				},
				{
					lane: "api_smoke",
					runName: "f",
					runTimestamp: "t6",
					pass: true,
				},
			],
			"api_smoke",
		);
		expect(streak).toBe(2);
	});
});
