import { Client } from "boardgame.io/dist/cjs/client.js";
import { Local } from "boardgame.io/dist/cjs/multiplayer.js";
import { encodeState } from "../bots/stateEncoder";
import {
	getDiagnosticsCollector,
	resetDiagnosticsCollector,
} from "../diagnostics/collector";
import { Engine } from "../engineAdapter";
import { mulberry32 } from "../rng";
import type { Bot, MatchLog, MatchResult, Move } from "../types";
import {
	applyEngineMoveChecked,
	bindHarnessMatchState,
	mapActiveSideToPlayerID,
} from "./adapter";
import { ArtifactBuilder, sha256, stableStringify } from "./artifact";
import { createFightclawGame } from "./createGame";
import type {
	BoardgameHarnessState,
	HarnessConfig,
	MoveValidationMode,
	ScenarioName,
	TurnMetricsV2,
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

type EngineMatchState = Parameters<Bot["chooseMove"]>[0]["state"];

type BoardgameClientState = {
	G: BoardgameHarnessState;
	ctx: {
		currentPlayer: string;
	};
	log?: unknown[];
};

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
			reportPlayerMappingDivergence({
				actualPlayerID: actingPlayerID,
				expectedPlayerID,
				strict: opts.strict,
				context: "Harness divergence",
			});

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
				playerID: actingPlayerID,
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
			const initialExplainability = buildInitialTurnExplainability(
				plan.moves,
				plan.meta.rawOutput,
			);
			artifact.setTurnExplainability(turnRecordIdx, initialExplainability);
			const turnStartState = state.G.matchState;

			let turnComplete = false;
			let commandIndex = 0;

			for (const move of plan.moves) {
				const current = requireState(client.getState());
				if (shouldStopPlannedTurn(current.G.matchState, activeAgent)) {
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
					const invalidPolicyOutcome = evaluateInvalidMovePolicy({
						policy: opts.invalidPolicy,
						activeAgent,
						playerIds,
						stopTurnOnForfeit: true,
					});
					if (invalidPolicyOutcome.forfeitTriggered) {
						forfeitTriggered = true;
						forfeitWinner = invalidPolicyOutcome.forfeitWinner;
					}
					if (invalidPolicyOutcome.stopTurn) {
						turnComplete = true;
						break;
					}
					commandIndex++;
					continue;
				}

				engineEvents.push(...checked.engineEvents);
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
				const engineMove = stripMoveAnnotations(move);
				artifact.recordAcceptedMove({
					ply: acceptedMoves.length + 1,
					playerID: actingPlayerID,
					engineMove,
					preHash,
					postHash,
				});
				acceptedMoves.push(engineMove);

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

			// Ensure each harness "turn" closes the active player's engine turn.
			// This avoids counting partial turns (single move plans with AP remaining)
			// as full turns, which can artificially inflate maxTurns endings.
			if (!forfeitTriggered) {
				const current = requireState(client.getState());

				if (shouldForceEndTurn(current.G.matchState, activeAgent)) {
					const forcedEndTurn: Move = { action: "end_turn" };
					const checked = applyEngineMoveChecked({
						state: current.G.matchState,
						move: forcedEndTurn,
						validationMode: opts.moveValidationMode,
					});

					if (checked.accepted) {
						engineEvents.push(...checked.engineEvents);
						client.updatePlayerID(actingPlayerID);
						client.moves.applyMove({
							move: forcedEndTurn,
							turnIndex,
							commandIndex,
						});
						artifact.recordCommandAttempt(turnRecordIdx, {
							commandIndex,
							move: forcedEndTurn,
							accepted: true,
						});
						acceptedMoves.push(forcedEndTurn);
						turnComplete = true;
					} else {
						illegalMoves++;
						artifact.recordCommandAttempt(turnRecordIdx, {
							commandIndex,
							move: forcedEndTurn,
							accepted: false,
							rejectionReason: checked.rejectionReason,
						});
						const invalidPolicyOutcome = evaluateInvalidMovePolicy({
							policy: opts.invalidPolicy,
							activeAgent,
							playerIds,
							stopTurnOnForfeit: false,
						});
						if (invalidPolicyOutcome.forfeitTriggered) {
							forfeitTriggered = true;
							forfeitWinner = invalidPolicyOutcome.forfeitWinner;
						}
						if (invalidPolicyOutcome.stopTurn) {
							turnComplete = true;
						}
					}
				}
			}

			if (forfeitTriggered) {
				break;
			}

			const afterBatch = requireState(client.getState());
			if (
				shouldEmitBoardgameEndTurn({
					state: afterBatch.G.matchState,
					ctxCurrentPlayerID: afterBatch.ctx.currentPlayer,
					actingPlayerID,
					activeAgent,
					turnComplete,
				})
			) {
				client.updatePlayerID(actingPlayerID);
				client.events.endTurn?.();
				const postTurn = requireState(client.getState());
				const mapped = mapActiveSideToPlayerID(postTurn.G.matchState);
				reportPlayerMappingDivergence({
					actualPlayerID: postTurn.ctx.currentPlayer,
					expectedPlayerID: mapped,
					strict: opts.strict,
					context: "Post-endTurn divergence",
				});
			}

			const turnEndState = requireState(client.getState()).G.matchState;
			const turnMetrics = buildTurnMetricsV2(
				turnStartState,
				turnEndState,
				actingPlayerID,
				artifact.getTurnCommandAttempts(turnRecordIdx),
			);
			artifact.setTurnMetrics(turnRecordIdx, turnMetrics);
			artifact.setTurnExplainability(
				turnRecordIdx,
				buildMetricsExplainability(
					turnMetrics,
					artifact.getTurnCommandAttempts(turnRecordIdx),
				),
			);

			completedTurns = turnIndex;
		}

		const finalState = requireState(client.getState());
		const finalTerminal = Engine.isTerminal(finalState.G.matchState);
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
			: finalTerminal.ended
				? finalizeResult({
						seed: opts.seed,
						turns: completedTurns,
						winner: finalTerminal.winner ?? null,
						illegalMoves,
						reason: "terminal",
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

function requireState(
	state: BoardgameClientState | null,
): BoardgameClientState {
	if (!state) {
		throw new Error("boardgame client state is null");
	}
	const matchState = bindHarnessMatchState(state.G);
	if (state.G.matchState === matchState) return state;
	return {
		...state,
		G: {
			...state.G,
			matchState,
		},
	};
}

function reportPlayerMappingDivergence(input: {
	actualPlayerID: string;
	expectedPlayerID: string;
	strict: boolean;
	context: string;
}): void {
	if (input.actualPlayerID === input.expectedPlayerID) {
		return;
	}
	const msg = `${input.context}: ctx.currentPlayer=${input.actualPlayerID} expected=${input.expectedPlayerID}`;
	if (input.strict) {
		throw new Error(msg);
	}
	console.warn(msg);
}

function shouldStopPlannedTurn(
	state: EngineMatchState,
	activeAgent: string,
): boolean {
	if (Engine.isTerminal(state).ended) {
		return true;
	}
	return Engine.currentPlayer(state) !== activeAgent;
}

function shouldForceEndTurn(
	state: EngineMatchState,
	activeAgent: string,
): boolean {
	if (Engine.isTerminal(state).ended) {
		return false;
	}
	if (Engine.currentPlayer(state) !== activeAgent) {
		return false;
	}
	return state.actionsRemaining > 0;
}

function evaluateInvalidMovePolicy(input: {
	policy: HarnessConfig["invalidPolicy"];
	activeAgent: string;
	playerIds: string[];
	stopTurnOnForfeit: boolean;
}): {
	forfeitTriggered: boolean;
	forfeitWinner: string | null;
	stopTurn: boolean;
} {
	if (input.policy === "forfeit") {
		return {
			forfeitTriggered: true,
			forfeitWinner: resolveForfeitWinner(input.activeAgent, input.playerIds),
			stopTurn: input.stopTurnOnForfeit,
		};
	}
	if (input.policy === "stop_turn") {
		return {
			forfeitTriggered: false,
			forfeitWinner: null,
			stopTurn: true,
		};
	}
	return {
		forfeitTriggered: false,
		forfeitWinner: null,
		stopTurn: false,
	};
}

function resolveForfeitWinner(
	activeAgent: string,
	playerIds: string[],
): string {
	return String(playerIds.find((id) => id !== activeAgent) ?? "");
}

function shouldEmitBoardgameEndTurn(input: {
	state: EngineMatchState;
	ctxCurrentPlayerID: string;
	actingPlayerID: string;
	activeAgent: string;
	turnComplete: boolean;
}): boolean {
	const terminal = Engine.isTerminal(input.state);
	const engineChangedPlayer =
		Engine.currentPlayer(input.state) !== input.activeAgent;
	const engineTurnComplete =
		input.turnComplete || terminal.ended || engineChangedPlayer;
	return (
		!terminal.ended &&
		engineTurnComplete &&
		input.ctxCurrentPlayerID === input.actingPlayerID
	);
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

function stripMoveAnnotations(move: Move): Move {
	const clean = {
		...(move as Move & { reasoning?: string; metadata?: unknown }),
	};
	delete clean.reasoning;
	delete clean.metadata;
	return clean as Move;
}

function buildInitialTurnExplainability(
	moves: Move[],
	rawOutput?: string,
): {
	declaredPlan?: string;
	whyThisMove?: string;
} {
	const declaredFromOutput = extractDeclaredPlan(rawOutput);
	const declaredFromMoves = summarizePlanFromMoves(moves);
	const whyFromMoves = extractWhyThisMoveFromMoves(moves);
	const whyFromOutput = extractReasoningFromOutput(rawOutput);
	return {
		declaredPlan: declaredFromOutput ?? declaredFromMoves,
		whyThisMove: whyFromMoves ?? whyFromOutput,
	};
}

function buildMetricsExplainability(
	metrics: TurnMetricsV2,
	attempts: Array<{ accepted: boolean; move: Move }>,
): {
	powerSpikeTriggered: boolean;
	swingEvent?: string;
	whyThisMove?: string;
} {
	const enemyUnitsLost = Math.max(0, -metrics.combat.enemyUnitsDelta);
	const ownUnitsLost = Math.max(0, -metrics.combat.ownUnitsDelta);
	const enemyHpLoss = Math.max(0, -metrics.combat.enemyHpDelta);
	const ownHpLoss = Math.max(0, -metrics.combat.ownHpDelta);
	const vpSwing = metrics.resources.ownVpDelta - metrics.resources.enemyVpDelta;
	const swingScore =
		(enemyUnitsLost - ownUnitsLost) * 6 +
		(enemyHpLoss - ownHpLoss) +
		vpSwing * 5 +
		(metrics.combat.finisherSuccesses > 0 ? 4 : 0);

	const powerSpikeTriggered =
		swingScore >= 8 ||
		(metrics.combat.favorableTrade &&
			(enemyHpLoss >= 4 || enemyUnitsLost >= 1 || vpSwing >= 2));

	let swingEvent: string | undefined;
	if (swingScore >= 12) {
		swingEvent = `decisive_swing(score=${swingScore})`;
	} else if (enemyUnitsLost > ownUnitsLost && enemyUnitsLost > 0) {
		swingEvent = `unit_trade(enemy=${enemyUnitsLost},own=${ownUnitsLost})`;
	} else if (enemyHpLoss - ownHpLoss >= 4) {
		swingEvent = `hp_swing(net=${enemyHpLoss - ownHpLoss})`;
	} else if (vpSwing >= 2) {
		swingEvent = `vp_swing(net=${vpSwing})`;
	}

	return {
		powerSpikeTriggered,
		swingEvent,
		whyThisMove: extractWhyThisMoveFromAttempts(attempts),
	};
}

function extractDeclaredPlan(rawOutput?: string): string | undefined {
	if (!rawOutput) return undefined;
	const commandBlock = rawOutput.split("---")[0] ?? rawOutput;
	const lines = commandBlock
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"))
		.slice(0, 3);
	if (lines.length === 0) return undefined;
	return clipText(lines.join(" | "), 220);
}

function summarizePlanFromMoves(moves: Move[]): string | undefined {
	if (moves.length === 0) return undefined;
	const summary = moves
		.slice(0, 5)
		.map((move) => summarizeMove(move))
		.join(" -> ");
	return clipText(summary, 220);
}

function summarizeMove(move: Move): string {
	switch (move.action) {
		case "attack":
			return `attack ${move.unitId} ${move.target}`;
		case "move":
			return `move ${move.unitId} ${move.to}`;
		case "recruit":
			return `recruit ${move.unitType} ${move.at}`;
		case "fortify":
			return `fortify ${move.unitId}`;
		case "upgrade":
			return `upgrade ${move.unitId}`;
		default:
			return move.action;
	}
}

function extractReasoningFromOutput(rawOutput?: string): string | undefined {
	if (!rawOutput) return undefined;
	const sections = rawOutput.split("---");
	if (sections.length < 2) return undefined;
	const reasoning = sections.slice(1).join("---").trim();
	return reasoning.length > 0 ? clipText(reasoning, 240) : undefined;
}

function extractWhyThisMoveFromAttempts(
	attempts: Array<{ accepted: boolean; move: Move }>,
): string | undefined {
	const accepted = attempts.filter((attempt) => attempt.accepted);
	const preferred = accepted.length > 0 ? accepted : attempts;
	for (const attempt of preferred) {
		const why = extractWhyThisMoveFromMove(attempt.move);
		if (why) return why;
	}
	return undefined;
}

function extractWhyThisMoveFromMoves(moves: Move[]): string | undefined {
	for (const move of moves) {
		const why = extractWhyThisMoveFromMove(move);
		if (why) return why;
	}
	return undefined;
}

function extractWhyThisMoveFromMove(move: Move): string | undefined {
	const annotated = move as Move & {
		reasoning?: string;
		metadata?: { whyThisMove?: string };
	};
	const why = annotated.metadata?.whyThisMove ?? annotated.reasoning;
	if (!why || why.trim().length === 0) return undefined;
	return clipText(why.trim(), 240);
}

function clipText(input: string, maxChars: number): string {
	if (input.length <= maxChars) return input;
	return `${input.slice(0, maxChars - 3)}...`;
}

function buildTurnMetricsV2(
	before: EngineMatchState,
	after: EngineMatchState,
	playerID: string,
	attempts: Array<{ accepted: boolean; move: Move }>,
): TurnMetricsV2 {
	const side = before.players.A.id === playerID ? "A" : "B";
	const enemySide = side === "A" ? "B" : "A";
	const accepted = attempts.filter((a) => a.accepted);
	const rejected = attempts.filter((a) => !a.accepted);
	const byTypeAccepted: Record<string, number> = {};
	const byTypeRejected: Record<string, number> = {};
	for (const a of accepted) {
		byTypeAccepted[a.move.action] = (byTypeAccepted[a.move.action] ?? 0) + 1;
	}
	for (const a of rejected) {
		byTypeRejected[a.move.action] = (byTypeRejected[a.move.action] ?? 0) + 1;
	}

	const beforeOwn = before.players[side];
	const beforeEnemy = before.players[enemySide];
	const afterOwn = after.players[side];
	const afterEnemy = after.players[enemySide];

	const beforeEnemyByPos = new Map(
		beforeEnemy.units.map((u) => [u.position, u]),
	);
	const afterEnemyIds = new Set(afterEnemy.units.map((u) => u.id));
	const acceptedAttacks = accepted.filter((a) => a.move.action === "attack");
	let finisherOpportunities = 0;
	let finisherSuccesses = 0;
	for (const a of acceptedAttacks) {
		if (a.move.action !== "attack") continue;
		const target = beforeEnemyByPos.get(a.move.target);
		if (!target) continue;
		if (target.hp <= 1) {
			finisherOpportunities++;
			if (!afterEnemyIds.has(target.id)) {
				finisherSuccesses++;
			}
		}
	}

	const beforeEnemyHp = sumHp(beforeEnemy.units);
	const beforeOwnHp = sumHp(beforeOwn.units);
	const afterEnemyHp = sumHp(afterEnemy.units);
	const afterOwnHp = sumHp(afterOwn.units);
	const enemyHpDelta = afterEnemyHp - beforeEnemyHp;
	const ownHpDelta = afterOwnHp - beforeOwnHp;
	const enemyUnitsDelta = afterEnemy.units.length - beforeEnemy.units.length;
	const ownUnitsDelta = afterOwn.units.length - beforeOwn.units.length;
	const enemyHpLoss = beforeEnemyHp - afterEnemyHp;
	const ownHpLoss = beforeOwnHp - afterOwnHp;
	const enemyUnitsLost = beforeEnemy.units.length - afterEnemy.units.length;
	const ownUnitsLost = beforeOwn.units.length - afterOwn.units.length;
	const favorableTrade =
		enemyHpLoss > ownHpLoss || enemyUnitsLost > ownUnitsLost;

	const startAvgDist = avgDistanceToEnemyStronghold(before, side);
	const endAvgDist = avgDistanceToEnemyStronghold(after, side);
	const upgradeSpend = estimateUpgradeSpend(before, side, accepted);

	return {
		side,
		actions: {
			accepted: accepted.length,
			rejected: rejected.length,
			byTypeAccepted,
			byTypeRejected,
		},
		combat: {
			attacksAccepted: acceptedAttacks.length,
			finisherOpportunities,
			finisherSuccesses,
			enemyHpDelta,
			ownHpDelta,
			enemyUnitsDelta,
			ownUnitsDelta,
			favorableTrade,
		},
		position: {
			startAvgDistToEnemyStronghold: startAvgDist,
			endAvgDistToEnemyStronghold: endAvgDist,
			deltaAvgDistToEnemyStronghold:
				startAvgDist !== null && endAvgDist !== null
					? endAvgDist - startAvgDist
					: null,
		},
		resources: {
			ownGoldDelta: afterOwn.gold - beforeOwn.gold,
			ownWoodDelta: afterOwn.wood - beforeOwn.wood,
			enemyGoldDelta: afterEnemy.gold - beforeEnemy.gold,
			enemyWoodDelta: afterEnemy.wood - beforeEnemy.wood,
			ownVpDelta: afterOwn.vp - beforeOwn.vp,
			enemyVpDelta: afterEnemy.vp - beforeEnemy.vp,
		},
		upgrade: {
			upgradesAccepted: upgradeSpend.upgradesAccepted,
			estimatedGoldSpend: upgradeSpend.estimatedGoldSpend,
			estimatedWoodSpend: upgradeSpend.estimatedWoodSpend,
		},
	};
}

function estimateUpgradeSpend(
	before: EngineMatchState,
	side: "A" | "B",
	accepted: Array<{ accepted: boolean; move: Move }>,
): {
	upgradesAccepted: number;
	estimatedGoldSpend: number;
	estimatedWoodSpend: number;
} {
	const unitById = new Map(before.players[side].units.map((u) => [u.id, u]));
	let upgradesAccepted = 0;
	let estimatedGoldSpend = 0;
	let estimatedWoodSpend = 0;
	for (const a of accepted) {
		if (a.move.action !== "upgrade") continue;
		const unit = unitById.get(a.move.unitId);
		if (!unit) continue;
		upgradesAccepted++;
		if (unit.type === "infantry") {
			estimatedGoldSpend += 9;
			estimatedWoodSpend += 3;
		} else if (unit.type === "cavalry") {
			estimatedGoldSpend += 15;
			estimatedWoodSpend += 5;
		} else if (unit.type === "archer") {
			estimatedGoldSpend += 12;
			estimatedWoodSpend += 4;
		}
	}
	return {
		upgradesAccepted,
		estimatedGoldSpend,
		estimatedWoodSpend,
	};
}

function sumHp(units: Array<{ hp: number }>): number {
	return units.reduce((s, u) => s + u.hp, 0);
}

function avgDistanceToEnemyStronghold(
	state: EngineMatchState,
	side: "A" | "B",
): number | null {
	const enemyStrongholdType = side === "A" ? "stronghold_b" : "stronghold_a";
	const enemyStrongholdCols = state.board
		.filter((h) => h.type === enemyStrongholdType)
		.map((h) => parseCol(h.id))
		.filter((v): v is number => v !== null);
	if (enemyStrongholdCols.length === 0) return null;
	const targetCol = Math.min(...enemyStrongholdCols);
	const ownUnits = state.players[side].units;
	if (ownUnits.length === 0) return null;
	const dists = ownUnits
		.map((u) => parseCol(u.position))
		.filter((v): v is number => v !== null)
		.map((col) => Math.abs(col - targetCol));
	if (dists.length === 0) return null;
	return dists.reduce((s, d) => s + d, 0) / dists.length;
}

function parseCol(hexId: string): number | null {
	const n = Number.parseInt(hexId.replace(/^[A-Z]/i, ""), 10);
	return Number.isFinite(n) ? n : null;
}

async function chooseTurnPlan(opts: {
	bot: Bot;
	state: BoardgameRunnerOptions["engineConfig"] extends never
		? never
		: EngineMatchState;
	legalMoves: Move[];
	turnIndex: number;
	rng: () => number;
	playerID: string;
}): Promise<{ moves: Move[]; meta: TurnPlanMeta }> {
	const side = opts.state.players.A.id === opts.playerID ? "A" : "B";
	const fallbackPrompt = encodeState(opts.state, side);
	const detailed = opts.bot as Bot & {
		chooseTurnWithMeta?: (ctx: {
			state: EngineMatchState;
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
				prompt: r.prompt ?? fallbackPrompt,
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
			meta: { turnIndex: opts.turnIndex, prompt: fallbackPrompt },
		};
	}

	const move = await opts.bot.chooseMove({
		state: opts.state,
		legalMoves: opts.legalMoves,
		turn: opts.turnIndex,
		rng: opts.rng,
	});
	return {
		moves: [move],
		meta: { turnIndex: opts.turnIndex, prompt: fallbackPrompt },
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
