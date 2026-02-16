import { Client } from "boardgame.io/dist/cjs/client.js";
import { Local } from "boardgame.io/dist/cjs/multiplayer.js";
import {
	getDiagnosticsCollector,
	resetDiagnosticsCollector,
} from "../diagnostics/collector";
import { Engine } from "../engineAdapter";
import { mulberry32 } from "../rng";
import type { Bot, MatchLog, MatchResult, Move } from "../types";
import { applyEngineMoveChecked, mapActiveSideToPlayerID } from "./adapter";
import { ArtifactBuilder, sha256, stableStringify } from "./artifact";
import { createFightclawGame } from "./createGame";
import type {
	HarnessConfig,
	MoveValidationMode,
	ScenarioName,
	TurnPlanMeta,
} from "./types";

interface BoardgameRunnerOptions {
	seed: number;
	players: Bot[];
	maxTurns: number;
	verbose?: boolean;
	record?: boolean;
	enableDiagnostics?: boolean;
	engineConfig?: HarnessConfig["engineConfig"];
	scenario?: ScenarioName;
	invalidPolicy: HarnessConfig["invalidPolicy"];
	strict: boolean;
	moveValidationMode: MoveValidationMode;
	artifactDir?: string;
	storeFullPrompt: boolean;
	storeFullOutput: boolean;
}

export async function playMatchBoardgameIO(
	opts: BoardgameRunnerOptions,
): Promise<MatchResult> {
	const rng = mulberry32(opts.seed);
	const playerIds = opts.players.map((p) => p.id);
	if (playerIds.length !== 2) {
		throw new Error("playMatchBoardgameIO requires exactly two players");
	}
	const playerPair: [string, string] = [
		String(playerIds[0]),
		String(playerIds[1]),
	];
	const harnessConfig: HarnessConfig = {
		seed: opts.seed,
		players: [playerIds[0], playerIds[1]],
		maxTurns: opts.maxTurns,
		engineConfig: opts.engineConfig,
		scenario: opts.scenario,
		invalidPolicy: opts.invalidPolicy,
		strict: opts.strict,
		moveValidationMode: opts.moveValidationMode,
		artifactDir: opts.artifactDir,
		storeFullPrompt: opts.storeFullPrompt,
		storeFullOutput: opts.storeFullOutput,
	};

	if (opts.enableDiagnostics) {
		resetDiagnosticsCollector();
		getDiagnosticsCollector().startGame(
			opts.seed,
			opts.players[0]?.name ?? "unknown",
			opts.players[1]?.name ?? "unknown",
		);
	}

	const client = Client({
		game: createFightclawGame(harnessConfig),
		numPlayers: 2,
		multiplayer: Local(),
	});
	client.start();

	const artifact = new ArtifactBuilder(harnessConfig);
	const acceptedMoves: Move[] = [];
	const engineEvents = [] as unknown[];
	let illegalMoves = 0;
	let completedTurns = 0;
	let forfeitWinner: string | null = null;
	let forfeitTriggered = false;

	try {
		for (let turnIndex = 1; turnIndex <= opts.maxTurns; turnIndex++) {
			const state = requireState(client.getState());
			const terminal = Engine.isTerminal(state.G.matchState);
			if (terminal.ended) {
				const result = finalizeResult({
					seed: opts.seed,
					turns: completedTurns,
					winner: terminal.winner ?? null,
					illegalMoves,
					reason: "terminal",
					state: state.G.matchState,
					acceptedMoves,
					engineEvents,
					playerPair,
					record: opts.record,
				});
				artifact.setResult(
					resultSummaryFromResult(result),
					hashState(state.G.matchState),
				);
				artifact.setBoardgameLog(state.log ?? null);
				artifact.write(opts.artifactDir);
				if (opts.enableDiagnostics) {
					getDiagnosticsCollector().endGame(result.winner, result.reason);
				}
				return result;
			}

			const activeAgent = Engine.currentPlayer(state.G.matchState);
			const actingPlayerID = state.ctx.currentPlayer;
			const expectedPlayerID = mapActiveSideToPlayerID(state.G.matchState);
			if (actingPlayerID !== expectedPlayerID) {
				const msg = `Harness divergence: ctx.currentPlayer=${actingPlayerID} expected=${expectedPlayerID}`;
				if (opts.strict) {
					throw new Error(msg);
				}
				console.warn(msg);
			}

			const bot = opts.players.find((p) => p.id === activeAgent);
			if (!bot) {
				throw new Error(`No bot for active player ${String(activeAgent)}`);
			}

			const legalMoves = Engine.listLegalMoves(state.G.matchState);
			const plan = await chooseTurnPlan({
				bot,
				turnIndex,
				legalMoves,
				state: state.G.matchState,
				rng,
			});
			const turnRecordIdx = artifact.startTurn(
				{
					turnIndex,
					prompt: opts.storeFullPrompt ? plan.meta.prompt : undefined,
					rawOutput: opts.storeFullOutput ? plan.meta.rawOutput : undefined,
					model: plan.meta.model,
				},
				actingPlayerID,
			);

			let turnComplete = false;
			let commandIndex = 0;

			for (const move of plan.moves) {
				const current = requireState(client.getState());
				const midTerminal = Engine.isTerminal(current.G.matchState);
				if (midTerminal.ended) {
					turnComplete = true;
					break;
				}
				if (Engine.currentPlayer(current.G.matchState) !== activeAgent) {
					turnComplete = true;
					break;
				}

				const preHash = hashState(current.G.matchState);
				const checked = applyEngineMoveChecked({
					state: current.G.matchState,
					move,
					validationMode: opts.moveValidationMode,
				});
				if (!checked.accepted) {
					illegalMoves++;
					artifact.recordCommandAttempt(turnRecordIdx, {
						commandIndex,
						move,
						accepted: false,
						rejectionReason: checked.rejectionReason,
					});
					if (opts.invalidPolicy === "forfeit") {
						forfeitTriggered = true;
						forfeitWinner = String(
							playerIds.find((id) => id !== activeAgent) ?? "",
						);
						turnComplete = true;
						break;
					}
					if (opts.invalidPolicy === "stop_turn") {
						turnComplete = true;
						break;
					}
					commandIndex++;
					continue;
				}

				client.updatePlayerID(actingPlayerID);
				client.moves.applyMove({
					move,
					turnIndex,
					commandIndex,
				});

				const next = requireState(client.getState());
				const postHash = hashState(next.G.matchState);
				artifact.recordCommandAttempt(turnRecordIdx, {
					commandIndex,
					move,
					accepted: true,
				});
				artifact.recordAcceptedMove({
					ply: acceptedMoves.length + 1,
					playerID: actingPlayerID,
					engineMove: move,
					preHash,
					postHash,
				});
				acceptedMoves.push(move);

				if (opts.enableDiagnostics) {
					getDiagnosticsCollector().logTurn(
						turnIndex,
						bot.name,
						move.action,
						next.G.matchState as unknown as {
							players: {
								A: { units: unknown[]; vp: number };
								B: { units: unknown[]; vp: number };
							};
						},
					);
				}
				if (opts.verbose) {
					console.log(
						`[bgio turn ${turnIndex}] ${bot.name} -> ${JSON.stringify(move)}`,
					);
				}

				if (Engine.currentPlayer(next.G.matchState) !== activeAgent) {
					turnComplete = true;
					break;
				}
				commandIndex++;
			}

			if (forfeitTriggered) {
				break;
			}

			const afterBatch = requireState(client.getState());
			const afterTerminal = Engine.isTerminal(afterBatch.G.matchState);
			const engineChangedPlayer =
				Engine.currentPlayer(afterBatch.G.matchState) !== activeAgent;
			const engineTurnComplete =
				turnComplete || afterTerminal.ended || engineChangedPlayer;

			if (
				engineTurnComplete &&
				afterBatch.ctx.currentPlayer === actingPlayerID
			) {
				client.updatePlayerID(actingPlayerID);
				client.events.endTurn?.();
				const postTurn = requireState(client.getState());
				const mapped = mapActiveSideToPlayerID(postTurn.G.matchState);
				if (mapped !== postTurn.ctx.currentPlayer) {
					const msg = `Post-endTurn divergence: ctx.currentPlayer=${postTurn.ctx.currentPlayer} expected=${mapped}`;
					if (opts.strict) {
						throw new Error(msg);
					}
					console.warn(msg);
				}
			}

			completedTurns = turnIndex;
		}

		const finalState = requireState(client.getState());
		const result: MatchResult = forfeitTriggered
			? finalizeResult({
					seed: opts.seed,
					turns: completedTurns,
					winner: forfeitWinner,
					illegalMoves,
					reason: "illegal",
					state: finalState.G.matchState,
					acceptedMoves,
					engineEvents,
					playerPair,
					record: opts.record,
				})
			: finalizeResult({
					seed: opts.seed,
					turns: opts.maxTurns,
					winner: Engine.winner(finalState.G.matchState),
					illegalMoves,
					reason: "maxTurns",
					state: finalState.G.matchState,
					acceptedMoves,
					engineEvents,
					playerPair,
					record: opts.record,
				});

		artifact.setResult(
			resultSummaryFromResult(result),
			hashState(finalState.G.matchState),
		);
		artifact.setBoardgameLog(finalState.log ?? null);
		artifact.write(opts.artifactDir);

		if (opts.enableDiagnostics) {
			getDiagnosticsCollector().endGame(result.winner, result.reason);
		}
		return result;
	} finally {
		client.stop();
	}
}

function requireState<T>(state: T | null): T {
	if (!state) {
		throw new Error("boardgame client state is null");
	}
	return state;
}

function hashState(state: unknown): string {
	return sha256(stableStringify(state));
}

function resultSummaryFromResult(result: MatchResult) {
	return {
		winner: result.winner,
		reason: result.reason,
		turns: result.turns,
		illegalMoves: result.illegalMoves,
	};
}

async function chooseTurnPlan(opts: {
	bot: Bot;
	state: BoardgameRunnerOptions["engineConfig"] extends never
		? never
		: Parameters<Bot["chooseMove"]>[0]["state"];
	legalMoves: Move[];
	turnIndex: number;
	rng: () => number;
}): Promise<{ moves: Move[]; meta: TurnPlanMeta }> {
	const detailed = opts.bot as Bot & {
		chooseTurnWithMeta?: (ctx: {
			state: Parameters<Bot["chooseMove"]>[0]["state"];
			legalMoves: Move[];
			turn: number;
			rng: () => number;
		}) => Promise<{
			moves: Move[];
			prompt?: string;
			rawOutput?: string;
			model?: string;
		}>;
	};

	if (detailed.chooseTurnWithMeta) {
		const r = await detailed.chooseTurnWithMeta({
			state: opts.state,
			legalMoves: opts.legalMoves,
			turn: opts.turnIndex,
			rng: opts.rng,
		});
		return {
			moves: r.moves,
			meta: {
				turnIndex: opts.turnIndex,
				prompt: r.prompt,
				rawOutput: r.rawOutput,
				model: r.model,
			},
		};
	}

	if (opts.bot.chooseTurn) {
		const moves = await opts.bot.chooseTurn({
			state: opts.state,
			legalMoves: opts.legalMoves,
			turn: opts.turnIndex,
			rng: opts.rng,
		});
		return {
			moves,
			meta: { turnIndex: opts.turnIndex },
		};
	}

	const move = await opts.bot.chooseMove({
		state: opts.state,
		legalMoves: opts.legalMoves,
		turn: opts.turnIndex,
		rng: opts.rng,
	});
	const planMoves: Move[] =
		move.action === "end_turn"
			? [move]
			: [move, { action: "end_turn" } as Move];
	return {
		moves: planMoves,
		meta: { turnIndex: opts.turnIndex },
	};
}

function finalizeResult(input: {
	seed: number;
	turns: number;
	winner: string | null;
	illegalMoves: number;
	reason: "terminal" | "maxTurns" | "illegal";
	state: unknown;
	acceptedMoves: Move[];
	engineEvents: unknown[];
	playerPair: [string, string];
	record?: boolean;
}): MatchResult {
	const log: MatchLog | undefined = input.record
		? {
				seed: input.seed,
				players: input.playerPair,
				moves: [...input.acceptedMoves],
				engineEvents: input.engineEvents as never,
				finalState: input.state as never,
			}
		: undefined;

	return {
		seed: input.seed,
		turns: input.turns,
		winner: input.winner,
		illegalMoves: input.illegalMoves,
		reason: input.reason,
		log,
	};
}
