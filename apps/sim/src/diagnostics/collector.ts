import * as fs from "node:fs";
import * as path from "node:path";

export interface LlmDiagnostics {
	timestamp: string;
	botId: string;
	model: string;
	turn: number;
	apiLatencyMs: number;
	apiSuccess: boolean;
	parsingSuccess: boolean;
	usedRandomFallback: boolean;
	commandsReturned: number;
	commandsMatched: number;
	commandsSkipped: number;
	responsePreview: string;
	reasoning?: string;
	parseError?: string;
	apiError?: string;
}

export interface GameDiagnostics {
	seed: number;
	bot1Model: string;
	bot2Model: string;
	startTime: string;
	turns: Array<{
		turn: number;
		player: string;
		action: string;
		unitsA: number;
		unitsB: number;
		vpA: number;
		vpB: number;
	}>;
	endTime?: string;
	winner?: string | null;
	reason: string;
	totalApiCalls: number;
	avgApiLatencyMs: number;
	failedApiCalls: number;
	failedParsing: number;
	randomFallbacks: number;
}

export class DiagnosticsCollector {
	private llmLogs: LlmDiagnostics[] = [];
	private gameLog?: GameDiagnostics;
	private logDir: string;

	constructor(logDir = "./diagnostics") {
		this.logDir = logDir;
		if (!fs.existsSync(logDir)) {
			fs.mkdirSync(logDir, { recursive: true });
		}
	}

	startGame(seed: number, bot1Model: string, bot2Model: string) {
		this.gameLog = {
			seed,
			bot1Model,
			bot2Model,
			startTime: new Date().toISOString(),
			turns: [],
			totalApiCalls: 0,
			avgApiLatencyMs: 0,
			failedApiCalls: 0,
			failedParsing: 0,
			randomFallbacks: 0,
			reason: "in_progress",
		};
	}

	logTurn(
		turn: number,
		player: string,
		action: string,
		state: {
			players: {
				A: { units: unknown[]; vp: number };
				B: { units: unknown[]; vp: number };
			};
		},
	) {
		if (this.gameLog) {
			this.gameLog.turns.push({
				turn,
				player,
				action,
				unitsA: state.players.A.units.length,
				unitsB: state.players.B.units.length,
				vpA: state.players.A.vp,
				vpB: state.players.B.vp,
			});
		}
	}

	logLlmCall(diag: LlmDiagnostics) {
		this.llmLogs.push(diag);
		if (this.gameLog) {
			this.gameLog.totalApiCalls++;
			if (!diag.apiSuccess) this.gameLog.failedApiCalls++;
			if (!diag.parsingSuccess) this.gameLog.failedParsing++;
			if (diag.usedRandomFallback) this.gameLog.randomFallbacks++;
		}
	}

	endGame(winner: string | null, reason: string) {
		if (this.gameLog) {
			this.gameLog.endTime = new Date().toISOString();
			this.gameLog.winner = winner;
			this.gameLog.reason = reason;

			// Calculate average latency
			const latencies = this.llmLogs
				.filter((l) => l.apiSuccess)
				.map((l) => l.apiLatencyMs);
			this.gameLog.avgApiLatencyMs =
				latencies.length > 0
					? latencies.reduce((a, b) => a + b, 0) / latencies.length
					: 0;
		}

		this.save();
	}

	private save() {
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

		if (this.gameLog) {
			const gamePath = path.join(this.logDir, `game-${timestamp}.json`);
			fs.writeFileSync(gamePath, JSON.stringify(this.gameLog, null, 2));
		}

		if (this.llmLogs.length > 0) {
			const llmPath = path.join(this.logDir, `llm-${timestamp}.json`);
			fs.writeFileSync(llmPath, JSON.stringify(this.llmLogs, null, 2));
		}

		// Also save a summary
		this.saveSummary(timestamp);
	}

	private saveSummary(timestamp: string) {
		const summary = {
			timestamp,
			game: this.gameLog,
			llmStats: {
				totalCalls: this.llmLogs.length,
				avgLatencyMs: this.gameLog?.avgApiLatencyMs ?? 0,
				failures: this.llmLogs.filter((l) => !l.apiSuccess).length,
				parsingFailures: this.llmLogs.filter((l) => !l.parsingSuccess).length,
				randomFallbacks: this.llmLogs.filter((l) => l.usedRandomFallback)
					.length,
			},
		};

		const summaryPath = path.join(this.logDir, `summary-${timestamp}.json`);
		fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
	}
}

// Global collector instance
let globalCollector: DiagnosticsCollector | null = null;

export function getDiagnosticsCollector(): DiagnosticsCollector {
	if (!globalCollector) {
		globalCollector = new DiagnosticsCollector();
	}
	return globalCollector;
}

export function resetDiagnosticsCollector(): void {
	globalCollector = new DiagnosticsCollector();
}
