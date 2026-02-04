import type { Bot, Move } from "../types";
import { pickOne } from "../rng";

/**
 * Greedy-ish bot stub.
 * Once your Move shape is known (e.g. { type: "attack" | "move" | "endTurn", ... }),
 * update scoreMove() to prefer certain actions.
 */
function scoreMove(_m: Move): number {
  return 0; // TODO: customize
}

export function makeGreedyBot(id: string): Bot {
  return {
    id,
    name: "GreedyBot",
    chooseMove: async ({ legalMoves, rng }) => {
      let bestScore = -Infinity;
      let best: Move[] = [];
      for (const m of legalMoves) {
        const s = scoreMove(m);
        if (s > bestScore) {
          bestScore = s;
          best = [m];
        } else if (s === bestScore) {
          best.push(m);
        }
      }
      return pickOne(best.length ? best : legalMoves, rng);
    },
  };
}
