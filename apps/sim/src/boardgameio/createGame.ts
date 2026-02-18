import { Engine } from "../engineAdapter";
import { createCombatScenario } from "../scenarios/combatScenarios";
import type { Move } from "../types";
import {
	applyEngineMoveChecked,
	assertActivePlayerMapped,
	bindHarnessMatchState,
	createPlayerMap,
	mapActiveSideToPlayerID,
} from "./adapter";
import type {
	BoardgameHarnessState,
	HarnessConfig,
	MoveApplyPayload,
	TurnPlanMeta,
} from "./types";

export function createFightclawGame(config: HarnessConfig) {
	const game: {
		[key: string]: unknown;
	} = {
		name: "fightclaw-sim-harness",
		events: {
			endTurn: true,
		},
		setup: () => {
			const { playerMap, reversePlayerMap } = createPlayerMap(config.players);
			const initialState = config.scenario
				? createCombatScenario(
						config.seed,
						config.players,
						config.scenario,
						config.engineConfig,
					)
				: Engine.createInitialState(
						config.seed,
						config.players,
						config.engineConfig,
					);
			const engineConfig = Engine.getEngineConfig(initialState);
			const matchState = Engine.bindEngineConfig(initialState, engineConfig);
			assertActivePlayerMapped(matchState, config.players);
			return {
				matchState,
				engineConfig,
				turnIndex: 1,
				playerMap,
				reversePlayerMap,
			};
		},
		turn: {
			order: {
				first: ({
					G,
					ctx,
				}: {
					G: BoardgameHarnessState;
					ctx: { playOrder: string[] };
				}) => {
					const playerID = mapActiveSideToPlayerID(G.matchState);
					const idx = ctx.playOrder.indexOf(playerID);
					return idx >= 0 ? idx : 0;
				},
				next: ({
					G,
					ctx,
				}: {
					G: BoardgameHarnessState;
					ctx: { playOrder: string[] };
				}) => {
					const playerID = mapActiveSideToPlayerID(G.matchState);
					const idx = ctx.playOrder.indexOf(playerID);
					return idx >= 0 ? idx : undefined;
				},
			},
			onBegin: ({ G }: { G: BoardgameHarnessState }) => ({
				...G,
				matchState: bindHarnessMatchState(G),
				turnIndex: G.turnIndex + 1,
			}),
		},
		endIf: ({ G }: { G: BoardgameHarnessState }) => {
			const matchState = bindHarnessMatchState(G);
			const terminal = Engine.isTerminal(matchState);
			if (!terminal.ended) return undefined;
			return {
				winner: terminal.winner ?? undefined,
				reason: terminal.reason,
			};
		},
		moves: {
			applyMove: (
				{ G }: { G: BoardgameHarnessState },
				payload: MoveApplyPayload,
			) => {
				const boundState = bindHarnessMatchState(G);
				const result = applyEngineMoveChecked({
					state: boundState,
					move: payload.move,
					validationMode: config.moveValidationMode,
				});
				if (!result.accepted) {
					return {
						...G,
						matchState: boundState,
					};
				}
				return {
					...G,
					matchState: result.nextState,
				};
			},
			setTurnPlanMeta: (
				{ G }: { G: BoardgameHarnessState },
				_payload: TurnPlanMeta,
			) => {
				return G;
			},
		},
	};
	return game;
}

export type BoardgameMoveDispatchers = {
	applyMove: (payload: MoveApplyPayload) => void;
	setTurnPlanMeta: (payload: TurnPlanMeta) => void;
};

export function normalizeMove(move: Move): Move {
	return { ...move };
}
