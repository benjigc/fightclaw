import {
	getDiagnosticsCollector,
	resetDiagnosticsCollector,
} from "./diagnostics/collector";
import { Engine } from "./engineAdapter";
import { mulberry32 } from "./rng";
import { createCombatScenario } from "./scenarios/combatScenarios";
import type {
	AgentId,
	Bot,
	EngineConfigInput,
	EngineEvent,
	MatchLog,
	MatchResult,
	MatchState,
	Move,
} from "./types";

export async function playMatch(opts: {
	seed: number;
	players: Bot[]; // turn order
	maxTurns: number;
	verbose?: boolean;
	record?: boolean;
	autofixIllegal?: boolean;
	enableDiagnostics?: boolean;
	engineConfig?: EngineConfigInput;
	scenario?: "melee" | "ranged" | "stronghold_rush" | "midfield";
}): Promise<MatchResult> {
	const rng = mulberry32(opts.seed);
	const playerIds = opts.players.map((p) => p.id);
	if (playerIds.length !== 2) {
		throw new Error("playMatch requires exactly two players.");
	}
	// biome-ignore lint/style/noNonNullAssertion: length checked above
	const playerPair: [AgentId, AgentId] = [playerIds[0]!, playerIds[1]!];

	// Initialize diagnostics if enabled
	if (opts.enableDiagnostics) {
		resetDiagnosticsCollector();
		const collector = getDiagnosticsCollector();
		collector.startGame(
			opts.seed,
			opts.players[0]?.name ?? "unknown",
			opts.players[1]?.name ?? "unknown",
		);
	}

	let state: MatchState = opts.scenario
		? createCombatScenario(opts.seed, playerIds, opts.scenario)
		: Engine.createInitialState(opts.seed, playerIds, opts.engineConfig);
	let illegalMoves = 0;
	const moves: Move[] = [];
	const engineEvents: EngineEvent[] = [];

	const logIfNeeded = (): MatchLog | undefined => {
		if (!opts.record) return undefined;
		return {
			seed: opts.seed,
			players: playerPair,
			moves: [...moves],
			engineEvents: [...engineEvents],
			finalState: state,
		};
	};

	for (let turn = 1; turn <= opts.maxTurns; turn++) {
		const active = Engine.currentPlayer(state);
		const bot = opts.players.find((p) => p.id === active);
		if (!bot) throw new Error(`No bot for active player id ${String(active)}`);

		const terminal = Engine.isTerminal(state);
		if (terminal.ended) {
			const result: MatchResult = {
				seed: opts.seed,
				turns: turn - 1,
				winner: terminal.winner ?? null,
				illegalMoves,
				reason: "terminal",
				log: logIfNeeded(),
			};
			if (opts.enableDiagnostics) {
				getDiagnosticsCollector().endGame(result.winner, result.reason);
			}
			return result;
		}

		const legalMoves = Engine.listLegalMoves(state);
		if (!Array.isArray(legalMoves) || legalMoves.length === 0) {
			throw new Error(
				"Engine.listLegalMoves returned empty list — game cannot progress",
			);
		}

		let move: Move;
		try {
			move = await bot.chooseMove({ state, legalMoves, turn, rng });
		} catch (e) {
			illegalMoves++;
			if (!opts.autofixIllegal) {
				if (opts.verbose)
					console.error(`[turn ${turn}] bot ${bot.name} crashed`, e);
				const result: MatchResult = {
					seed: opts.seed,
					turns: turn - 1,
					winner: null,
					illegalMoves,
					reason: "illegal",
					log: logIfNeeded(),
				};
				if (opts.enableDiagnostics) {
					getDiagnosticsCollector().endGame(result.winner, result.reason);
				}
				return result;
			}
			move = legalMoves[0] as Move;
			if (opts.verbose)
				console.error(`[turn ${turn}] bot ${bot.name} crashed; fallback`, e);
		}

		const isLegal = legalMoves.some(
			(m) => safeJson(stripReasoning(m)) === safeJson(stripReasoning(move)),
		);
		if (!isLegal) {
			illegalMoves++;
			if (!opts.autofixIllegal) {
				if (opts.verbose)
					console.warn(`[turn ${turn}] bot ${bot.name} chose illegal move`);
				const result: MatchResult = {
					seed: opts.seed,
					turns: turn - 1,
					winner: null,
					illegalMoves,
					reason: "illegal",
					log: logIfNeeded(),
				};
				if (opts.enableDiagnostics) {
					getDiagnosticsCollector().endGame(result.winner, result.reason);
				}
				return result;
			}
			if (opts.verbose)
				console.warn(
					`[turn ${turn}] bot ${bot.name} chose illegal move; forcing legal`,
				);
			move = legalMoves[Math.floor(rng() * legalMoves.length)] as Move;
		}

		const result = Engine.applyMove(state, move);
		engineEvents.push(...result.engineEvents);
		moves.push(move);
		if (!result.ok) {
			illegalMoves++;
			if (!opts.autofixIllegal) {
				const result: MatchResult = {
					seed: opts.seed,
					turns: turn - 1,
					winner: null,
					illegalMoves,
					reason: "illegal",
					log: logIfNeeded(),
				};
				if (opts.enableDiagnostics) {
					getDiagnosticsCollector().endGame(result.winner, result.reason);
				}
				return result;
			}
			if (opts.verbose)
				console.warn(`[turn ${turn}] engine rejected move; forcing legal`);
			const fallback = legalMoves[
				Math.floor(rng() * legalMoves.length)
			] as Move;
			const fallbackResult = Engine.applyMove(state, fallback);
			engineEvents.push(...fallbackResult.engineEvents);
			moves.push(fallback);
			if (fallbackResult.ok) {
				state = fallbackResult.state;
			} else {
				const result: MatchResult = {
					seed: opts.seed,
					turns: turn - 1,
					winner: null,
					illegalMoves,
					reason: "illegal",
					log: logIfNeeded(),
				};
				if (opts.enableDiagnostics) {
					getDiagnosticsCollector().endGame(result.winner, result.reason);
				}
				return result;
			}
		} else {
			state = result.state;
		}

		// Log turn diagnostics
		if (opts.enableDiagnostics) {
			getDiagnosticsCollector().logTurn(
				turn,
				bot.name,
				move.action,
				state as unknown as {
					players: {
						A: { units: unknown[]; vp: number };
						B: { units: unknown[]; vp: number };
					};
				},
			);
		}

		if (opts.verbose) {
			console.log(`[turn ${turn}] ${bot.name} -> ${short(move)}`);
		}
	}

	const result: MatchResult = {
		seed: opts.seed,
		turns: opts.maxTurns,
		winner: Engine.winner(state),
		illegalMoves,
		reason: "maxTurns",
		log: logIfNeeded(),
	};

	// End game diagnostics
	if (opts.enableDiagnostics) {
		getDiagnosticsCollector().endGame(result.winner, result.reason);
	}

	return result;
}

export function replayMatch(log: MatchLog): {
	ok: boolean;
	mismatchAt?: number;
	error?: string;
} {
	let state = Engine.createInitialState(log.seed, log.players);
	const events: EngineEvent[] = [];

	for (let i = 0; i < log.moves.length; i++) {
		const result = Engine.applyMove(state, log.moves[i]);
		events.push(...result.engineEvents);
		if (result.ok) {
			state = result.state;
		}
	}

	if (log.engineEvents && safeJson(events) !== safeJson(log.engineEvents)) {
		const mismatchAt = firstMismatchIndex(events, log.engineEvents);
		return { ok: false, mismatchAt, error: "Engine events mismatch." };
	}

	if (log.finalState && safeJson(state) !== safeJson(log.finalState)) {
		return { ok: false, error: "Final state mismatch." };
	}

	return { ok: true };
}

function stripReasoning(m: Move): Move {
	const { reasoning: _, ...rest } = m as Move & { reasoning?: string };
	return rest as Move;
}

function safeJson(x: unknown): string {
	try {
		return JSON.stringify(x);
	} catch {
		return String(x);
	}
}

function firstMismatchIndex(a: unknown[], b: unknown[]): number {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		if (safeJson(a[i]) !== safeJson(b[i])) return i;
	}
	return len;
}

function short(x: unknown): string {
	const s = safeJson(x);
	return s.length > 140 ? s.slice(0, 140) + "…" : s;
}
