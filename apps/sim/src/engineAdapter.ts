/**
 * Engine adapter: wire this to your real engine exports.
 *
 * The sim runner is intentionally engine-agnostic. You just map your engine
 * functions into this shape.
 */

import {
	applyMove,
	createInitialState,
	currentPlayer,
	isTerminal,
	listLegalMoves,
	winner,
} from "@fightclaw/engine";
import type { AgentId, EngineConfigInput, MatchState, Move } from "./types";

export const Engine = {
	createInitialState(
		seed: number,
		players: AgentId[],
		configInput?: EngineConfigInput,
	): MatchState {
		return createInitialState(seed, configInput, players);
	},

	currentPlayer(state: MatchState): AgentId {
		return currentPlayer(state);
	},

	isTerminal(state: MatchState) {
		return isTerminal(state);
	},

	winner(state: MatchState): AgentId | null {
		return winner(state);
	},

	listLegalMoves(state: MatchState): Move[] {
		return listLegalMoves(state);
	},

	applyMove(state: MatchState, move: Move) {
		return applyMove(state, move);
	},
};
