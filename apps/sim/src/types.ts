export type { AgentId, Move, GameState } from "@fightclaw/engine";

export type MatchResult = {
  seed: number;
  turns: number;
  winner: AgentId | null;
  illegalMoves: number;
  reason: "terminal" | "maxTurns";
};

export type Bot = {
  id: AgentId;
  name: string;
  chooseMove: (ctx: {
    state: GameState;
    legalMoves: Move[];
    turn: number;
    rng: () => number;
  }) => Promise<Move> | Move;
};
