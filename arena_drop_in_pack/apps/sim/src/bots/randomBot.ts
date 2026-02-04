import type { Bot } from "../types";
import { pickOne } from "../rng";

export function makeRandomLegalBot(id: string): Bot {
  return {
    id,
    name: "RandomLegalBot",
    chooseMove: async ({ legalMoves, rng }) => pickOne(legalMoves, rng),
  };
}
