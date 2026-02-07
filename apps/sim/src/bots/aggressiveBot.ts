import { pickOne } from "../rng";
import type { Bot, Move } from "../types";

/**
 * Aggressive bot that strongly prefers attacks, then moves, then recruits.
 * Falls back to random selection within the highest-priority bucket.
 */
export function makeAggressiveBot(id: string): Bot {
	return {
		id,
		name: "AggressiveBot",
		chooseMove: async ({ legalMoves, rng }) => {
			const byAction = (action: Move["action"]) =>
				legalMoves.filter((m) => m.action === action);

			const attacks = byAction("attack");
			if (attacks.length > 0) return pickOne(attacks, rng);

			const moves = byAction("move");
			if (moves.length > 0) return pickOne(moves, rng);

			const recruits = byAction("recruit");
			if (recruits.length > 0) return pickOne(recruits, rng);

			const fortifies = byAction("fortify");
			if (fortifies.length > 0) return pickOne(fortifies, rng);

			return pickOne(legalMoves, rng);
		},
	};
}
