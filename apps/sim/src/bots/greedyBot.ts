import { pickOne } from "../rng";
import type { Bot, Move } from "../types";

/**
 * Greedy-ish bot stub.
 * Once your Move shape is known (e.g. { action: "move" | "attack" | "recruit" | "fortify" | "pass", ... }),
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
			let bestScore = Number.NEGATIVE_INFINITY;
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
