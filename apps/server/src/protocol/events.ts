import type { SpectatorEvent } from "@fightclaw/engine";

export const EVENT_VERSION = 1 as const;

type EventOf<E extends SpectatorEvent["event"]> = Extract<
	SpectatorEvent,
	{ event: E }
>;

export type MatchFoundEvent = EventOf<"match_found">;
export type YourTurnEvent = EventOf<"your_turn">;
export type StateEvent = EventOf<"state">;
export type GameEndedEvent = EventOf<"game_ended">;
export type NoEventsEvent = EventOf<"no_events">;

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
	matchId: string,
	stateVersion: number,
): YourTurnEvent => ({
	eventVersion: EVENT_VERSION,
	event: "your_turn",
	matchId,
	stateVersion,
});

export const buildStateEvent = (
	matchId: string,
	state: StateEvent["state"],
): StateEvent => ({
	eventVersion: EVENT_VERSION,
	event: "state",
	matchId,
	state,
});

export const buildGameEndedEvent = (
	matchId: string,
	winnerAgentId: GameEndedEvent["winnerAgentId"],
	loserAgentId: GameEndedEvent["loserAgentId"],
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
