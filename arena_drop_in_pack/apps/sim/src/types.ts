export type AgentId = string;

// Replace these with your real engine types via engineAdapter.ts.
export type Move = unknown;
export type GameState = unknown;

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
