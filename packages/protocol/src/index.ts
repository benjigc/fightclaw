export const EVENT_VERSION = 1 as const;
export const PROTOCOL_VERSION = 2 as const;
export const CONTRACTS_VERSION = "2026-02-19.agent-thought.v1" as const;
export const ENGINE_VERSION = "war_of_attrition_v2" as const;

export type PlayerSide = "A" | "B";

export type AgentThoughtEvent = {
	eventVersion: typeof EVENT_VERSION;
	event: "agent_thought";
	matchId: string;
	player: PlayerSide;
	agentId: string;
	moveId: string;
	stateVersion: number;
	text: string;
	ts: string;
};

export type MatchFoundEvent = {
	eventVersion: typeof EVENT_VERSION;
	event: "match_found";
	matchId: string;
	opponentId?: string;
};

export type YourTurnEvent = {
	eventVersion: typeof EVENT_VERSION;
	event: "your_turn";
	matchId: string;
	stateVersion: number;
};

export type StateEvent<TState = unknown> = {
	eventVersion: typeof EVENT_VERSION;
	event: "state";
	matchId: string;
	state: TState;
};

export type EngineEventsEvent = {
	eventVersion: typeof EVENT_VERSION;
	event: "engine_events";
	matchId: string;
	stateVersion: number;
	agentId: string;
	moveId: string;
	move: unknown;
	engineEvents: unknown[];
	ts: string;
};

export type MatchEndedEvent = {
	eventVersion: typeof EVENT_VERSION;
	event: "match_ended";
	matchId: string;
	winnerAgentId?: string | null;
	loserAgentId?: string | null;
	reason?: string;
	reasonCode?: string;
};

export type GameEndedEvent = {
	eventVersion: typeof EVENT_VERSION;
	event: "game_ended";
	matchId: string;
	winnerAgentId?: string | null;
	loserAgentId?: string | null;
	reason?: string;
	reasonCode?: string;
};

export type ErrorEvent = {
	eventVersion: typeof EVENT_VERSION;
	event: "error";
	error: string;
};

export type NoEventsEvent = {
	eventVersion: typeof EVENT_VERSION;
	event: "no_events";
};

export type SpectatorEvent =
	| MatchFoundEvent
	| YourTurnEvent
	| StateEvent
	| EngineEventsEvent
	| AgentThoughtEvent
	| MatchEndedEvent
	| GameEndedEvent
	| ErrorEvent
	| NoEventsEvent;

export type SystemVersionResponse = {
	gitSha: string | null;
	buildTime: string | null;
	contractsVersion: string;
	protocolVersion: number;
	engineVersion: string;
	environment: string | null;
};
