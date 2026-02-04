import type { Bot, MatchResult, GameState, Move } from "./types";
import { mulberry32 } from "./rng";
import { Engine } from "./engineAdapter";

export async function playMatch(opts: {
  seed: number;
  players: Bot[];   // turn order
  maxTurns: number;
  verbose?: boolean;
}): Promise<MatchResult> {
  const rng = mulberry32(opts.seed);
  const playerIds = opts.players.map((p) => p.id);

  let state: GameState = Engine.initialState(opts.seed, playerIds);
  let illegalMoves = 0;

  for (let turn = 1; turn <= opts.maxTurns; turn++) {
    const active = Engine.currentPlayer(state);
    const bot = opts.players.find((p) => p.id === active);
    if (!bot) throw new Error(`No bot for active player id ${String(active)}`);

    if (Engine.isTerminal(state)) {
      return {
        seed: opts.seed,
        turns: turn - 1,
        winner: Engine.winner(state),
        illegalMoves,
        reason: "terminal",
      };
    }

    const legalMoves = Engine.listLegalMoves(state);
    if (!Array.isArray(legalMoves) || legalMoves.length === 0) {
      throw new Error("Engine.listLegalMoves returned empty list — game cannot progress");
    }

    let move: Move;
    try {
      move = await bot.chooseMove({ state, legalMoves, turn, rng });
    } catch (e) {
      illegalMoves++;
      move = legalMoves[0] as Move;
      if (opts.verbose) console.error(`[turn ${turn}] bot ${bot.name} crashed; fallback`, e);
    }

    const isLegal = legalMoves.some((m) => safeJson(m) === safeJson(move));
    if (!isLegal) {
      illegalMoves++;
      if (opts.verbose) console.warn(`[turn ${turn}] bot ${bot.name} chose illegal move; forcing legal`);
      move = legalMoves[Math.floor(rng() * legalMoves.length)] as Move;
    }

    state = Engine.applyMove(state, move);

    if (opts.verbose) {
      console.log(`[turn ${turn}] ${bot.name} -> ${short(move)}`);
    }
  }

  return {
    seed: opts.seed,
    turns: opts.maxTurns,
    winner: Engine.winner(state),
    illegalMoves,
    reason: "maxTurns",
  };
}

function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function short(x: unknown): string {
  const s = safeJson(x);
  return s.length > 140 ? s.slice(0, 140) + "…" : s;
}
