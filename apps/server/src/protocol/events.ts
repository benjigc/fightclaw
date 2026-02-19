import type { SpectatorEvent } from "@fightclaw/engine";

export const EVENT_VERSION = 1 as const;

type EventOf<E extends SpectatorEvent["event"]> = Extract<
	SpectatorEvent,
	{ event: E }
>;

export type MatchFoundEvent = EventOf<"match_found">;
export type YourTurnEvent = EventOf<"your_turn">;
export type StateEvent = EventOf<"state">;
export type EngineEventsEvent = EventOf<"engine_events">;
export type MatchEndedEvent = EventOf<"match_ended">;
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

export const buildEngineEventsEvent = (
	matchId: string,
	payload: Omit<EngineEventsEvent, "eventVersion" | "event" | "matchId">,
): EngineEventsEvent => ({
	eventVersion: EVENT_VERSION,
	event: "engine_events",
	matchId,
	...payload,
});

export const buildMatchEndedEvent = (
	matchId: string,
	winnerAgentId: MatchEndedEvent["winnerAgentId"],
	loserAgentId: MatchEndedEvent["loserAgentId"],
	reason: string,
): MatchEndedEvent => ({
	eventVersion: EVENT_VERSION,
	event: "match_ended",
	matchId,
	winnerAgentId,
	loserAgentId,
	reason,
	reasonCode: reason,
});

export const buildGameEndedAliasEvent = (
	matchEnded: MatchEndedEvent,
): GameEndedEvent => ({
	...matchEnded,
	event: "game_ended",
});

export const buildNoEventsEvent = (): NoEventsEvent => ({
	eventVersion: EVENT_VERSION,
	event: "no_events",
});
