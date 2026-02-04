/**
 * Engine adapter: wire this to your real engine exports.
 *
 * The sim runner is intentionally engine-agnostic. You just map your engine
 * functions into this shape.
 */

import type { AgentId, GameState, Move } from "./types";

// TODO: replace these imports with your engine package path.
// Example:
// import { initialState, currentPlayer, isTerminal, winner, listLegalMoves, applyMove } from "@arena/engine";

export const Engine = {
  initialState(_seed: number, _players: AgentId[]): GameState {
    throw new Error("Engine.initialState not implemented — update apps/sim/src/engineAdapter.ts");
  },

  currentPlayer(_state: GameState): AgentId {
    throw new Error("Engine.currentPlayer not implemented — update apps/sim/src/engineAdapter.ts");
  },

  isTerminal(_state: GameState): boolean {
    throw new Error("Engine.isTerminal not implemented — update apps/sim/src/engineAdapter.ts");
  },

  winner(_state: GameState): AgentId | null {
    return null;
  },

  listLegalMoves(_state: GameState): Move[] {
    throw new Error("Engine.listLegalMoves not implemented — add a legal-move generator in your engine");
  },

  applyMove(_state: GameState, _move: Move): GameState {
    throw new Error("Engine.applyMove not implemented — update apps/sim/src/engineAdapter.ts");
  },
};
