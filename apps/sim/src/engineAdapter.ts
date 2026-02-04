/**
 * Engine adapter: wire this to your real engine exports.
 *
 * The sim runner is intentionally engine-agnostic. You just map your engine
 * functions into this shape.
 */

import type { AgentId, GameState, Move } from "./types";
import {
  initialState,
  currentPlayer,
  isTerminal,
  winner,
  listLegalMoves,
  applyMove,
} from "@fightclaw/engine";

export const Engine = {
  initialState(seed: number, players: AgentId[]): GameState {
    return initialState(seed, players);
  },

  currentPlayer(state: GameState): AgentId {
    return currentPlayer(state);
  },

  isTerminal(state: GameState): boolean {
    return isTerminal(state);
  },

  winner(state: GameState): AgentId | null {
    return winner(state);
  },

  listLegalMoves(state: GameState): Move[] {
    return listLegalMoves(state);
  },

  applyMove(state: GameState, move: Move): GameState {
    return applyMove(state, move);
  },
};
