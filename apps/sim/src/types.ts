export type {
	AgentId,
	EngineEvent,
	GameState,
	MatchState,
	Move,
	TerminalState,
} from "@fightclaw/engine";

export type MatchResult = {
	seed: number;
	turns: number;
	winner: AgentId | null;
	illegalMoves: number;
	reason: "terminal" | "maxTurns" | "illegal";
	log?: MatchLog;
};

export type MatchLog = {
	seed: number;
	players: [AgentId, AgentId];
	moves: Move[];
	engineEvents: EngineEvent[];
	finalState?: MatchState;
};

export type Bot = {
	id: AgentId;
	name: string;
	chooseMove: (ctx: {
		state: MatchState;
		legalMoves: Move[];
		turn: number;
		rng: () => number;
	}) => Promise<Move> | Move;
};
