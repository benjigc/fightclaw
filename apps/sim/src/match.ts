import { playMatchBoardgameIO } from "./boardgameio/runner";
import type {
	HarnessMode,
	InvalidPolicy,
	MoveValidationMode,
	ScenarioName,
} from "./boardgameio/types";
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
	scenario?: ScenarioName;
	harness?: HarnessMode;
	invalidPolicy?: InvalidPolicy;
	strict?: boolean;
	moveValidationMode?: MoveValidationMode;
	artifactDir?: string;
	storeFullPrompt?: boolean;
	storeFullOutput?: boolean;
}): Promise<MatchResult> {
	if (opts.harness === "boardgameio") {
		return playMatchBoardgameIO({
			seed: opts.seed,
			players: opts.players,
			maxTurns: opts.maxTurns,
			verbose: opts.verbose,
			record: opts.record,
			enableDiagnostics: opts.enableDiagnostics,
			engineConfig: opts.engineConfig,
			scenario: opts.scenario,
			invalidPolicy: opts.invalidPolicy ?? "skip",
			strict: opts.strict ?? process.env.HARNESS_STRICT === "1",
			moveValidationMode: opts.moveValidationMode ?? "strict",
			artifactDir: opts.artifactDir,
			storeFullPrompt: opts.storeFullPrompt ?? process.env.CI !== "true",
			storeFullOutput: opts.storeFullOutput ?? process.env.CI !== "true",
		});
	}
	return playMatchLegacy(opts);
}

async function playMatchLegacy(opts: {
	seed: number;
	players: Bot[]; // turn order
	maxTurns: number;
	verbose?: boolean;
	record?: boolean;
	autofixIllegal?: boolean;
	enableDiagnostics?: boolean;
	engineConfig?: EngineConfigInput;
	scenario?: ScenarioName;
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
		? createCombatScenario(
				opts.seed,
				playerIds,
				opts.scenario,
				opts.engineConfig,
			)
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

		/* ── batch turn path: bot.chooseTurn returns all moves for the turn ── */
		if (bot.chooseTurn) {
			let turnMoves: Move[];
			try {
				turnMoves = await bot.chooseTurn({ state, legalMoves, turn, rng });
			} catch (e) {
				illegalMoves++;
				if (!opts.autofixIllegal) {
					if (opts.verbose)
						console.error(`[turn ${turn}] bot ${bot.name} crashed (batch)`, e);
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
				turnMoves = [{ action: "end_turn" }];
			}

			for (const batchMove of turnMoves) {
				const midTerminal = Engine.isTerminal(state);
				if (midTerminal.ended) break;
				if (Engine.currentPlayer(state) !== bot.id) break;

				const currentLegal = Engine.listLegalMoves(state);
				if (currentLegal.length === 0) break;

				const isLegal = currentLegal.some(
					(m) =>
						safeJson(stripReasoning(m)) === safeJson(stripReasoning(batchMove)),
				);

				if (!isLegal) {
					illegalMoves++;
					if (!opts.autofixIllegal) {
						if (opts.verbose) {
							console.warn(
								`[turn ${turn}] bot ${bot.name} chose illegal batch move: ${short(batchMove)}`,
							);
						}
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
					if (opts.verbose) {
						console.warn(
							`[turn ${turn}] batch move skipped: ${short(batchMove)}`,
						);
					}
					continue; // skip this move when autofix is enabled
				}

				const engineBatchMove = stripReasoning(batchMove);
				const result = Engine.applyMove(state, engineBatchMove);
				if (!result.ok) {
					illegalMoves++;
					if (!opts.autofixIllegal) {
						if (opts.verbose) {
							console.warn(
								`[turn ${turn}] bot ${bot.name} produced invalid batch move application: ${short(engineBatchMove)}`,
							);
						}
						const terminal: MatchResult = {
							seed: opts.seed,
							turns: turn - 1,
							winner: null,
							illegalMoves,
							reason: "illegal",
							log: logIfNeeded(),
						};
						if (opts.enableDiagnostics) {
							getDiagnosticsCollector().endGame(
								terminal.winner,
								terminal.reason,
							);
						}
						return terminal;
					}
					if (opts.verbose) {
						console.warn(
							`[turn ${turn}] batch move application skipped: ${short(engineBatchMove)}`,
						);
					}
					continue;
				}
				engineEvents.push(...result.engineEvents);
				moves.push(engineBatchMove);
				state = result.state;

				if (opts.verbose) {
					console.log(`[turn ${turn}] ${bot.name} -> ${short(batchMove)}`);
				}

				if (opts.enableDiagnostics) {
					getDiagnosticsCollector().logTurn(
						turn,
						bot.name,
						batchMove.action,
						state as unknown as {
							players: {
								A: { units: unknown[]; vp: number };
								B: { units: unknown[]; vp: number };
							};
						},
					);
				}
			}
			continue; // back to outer loop to re-check active player
		}

		/* ── single-move path: bot.chooseMove (unchanged) ── */
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

		const engineMove = stripReasoning(move);
		const result = Engine.applyMove(state, engineMove);
		engineEvents.push(...result.engineEvents);
		moves.push(engineMove);
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
			const fallbackResult = Engine.applyMove(state, stripReasoning(fallback));
			engineEvents.push(...fallbackResult.engineEvents);
			moves.push(stripReasoning(fallback));
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
	const {
		reasoning: _,
		metadata: __,
		...rest
	} = m as Move & {
		reasoning?: string;
		metadata?: unknown;
	};
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
	return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}
