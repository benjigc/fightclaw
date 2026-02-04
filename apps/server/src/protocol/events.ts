import type { GameState } from "@fightclaw/engine";

export const EVENT_VERSION = 1 as const;

export type MatchFoundEvent = {
	eventVersion: 1;
	event: "match_found";
	matchId: string;
	opponentId: string;
};

export type YourTurnEvent = {
	eventVersion: 1;
	event: "your_turn";
	matchId: string;
	agentId: string;
	stateVersion: number;
};

export type StateEvent = {
	eventVersion: 1;
	event: "state";
	matchId: string | null;
	state: GameState;
};

export type GameEndedEvent = {
	eventVersion: 1;
	event: "game_ended";
	matchId: string | null;
	winnerAgentId: string | null;
	loserAgentId: string | null;
	reason: string;
	reasonCode: string;
};

export type NoEventsEvent = {
	eventVersion: 1;
	event: "no_events";
};

export const buildMatchFoundEvent = (
	matchId: string,
	opponentId: string,
): MatchFoundEvent => ({
	eventVersion: EVENT_VERSION,
	event: "match_found",
	matchId,
	opponentId,
});

export const buildYourTurnEvent = (
	matchId: string | null,
	agentId: string,
	stateVersion: number,
): YourTurnEvent => ({
	eventVersion: EVENT_VERSION,
	event: "your_turn",
	matchId: matchId ?? "",
	agentId,
	stateVersion,
});

export const buildStateEvent = (
	matchId: string | null,
	state: GameState,
): StateEvent => ({
	eventVersion: EVENT_VERSION,
	event: "state",
	matchId,
	state,
});

export const buildGameEndedEvent = (
	matchId: string | null,
	winnerAgentId: string | null,
	loserAgentId: string | null,
	reason: string,
): GameEndedEvent => ({
	eventVersion: EVENT_VERSION,
	event: "game_ended",
	matchId,
	winnerAgentId,
	loserAgentId,
	reason,
	reasonCode: reason,
});

export const buildNoEventsEvent = (): NoEventsEvent => ({
	eventVersion: EVENT_VERSION,
	event: "no_events",
});
