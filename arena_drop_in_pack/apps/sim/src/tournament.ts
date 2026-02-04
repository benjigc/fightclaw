import type { Bot } from "./types";
import { playMatch } from "./match";

export async function runTournament(opts: {
  games: number;
  seed: number;
  maxTurns: number;
  players: [Bot, Bot];
}) {
  const results = [];
  for (let i = 0; i < opts.games; i++) {
    const matchSeed = (opts.seed + i) >>> 0;
    const r = await playMatch({
      seed: matchSeed,
      players: opts.players,
      maxTurns: opts.maxTurns,
      verbose: false,
    });
    results.push(r);
  }

  const wins: Record<string, number> = {};
  let draws = 0;
  let totalTurns = 0;
  let totalIllegal = 0;

  for (const r of results) {
    totalTurns += r.turns;
    totalIllegal += r.illegalMoves;
    if (r.winner == null) draws++;
    else wins[r.winner] = (wins[r.winner] ?? 0) + 1;
  }

  const summary = {
    games: opts.games,
    seed: opts.seed,
    maxTurns: opts.maxTurns,
    wins,
    draws,
    avgTurns: Number((totalTurns / opts.games).toFixed(2)),
    illegalMoveRate: Number((totalIllegal / Math.max(1, totalTurns)).toFixed(4)),
  };

  return { summary, results };
}
