import { pickOne } from "../rng";
import type { Bot, Move } from "../types";

function scoreMove(m: Move): number {
	switch (m.action) {
		case "attack":
			return 10;
		case "recruit":
			return 7;
		case "move":
			return 3;
		case "fortify":
			return 2;
		case "end_turn":
		case "pass":
			return 0;
	}
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
