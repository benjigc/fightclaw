import type {
	AgentThoughtEvent,
	EngineEventsEvent,
	GameEndedEvent,
	MatchEndedEvent,
	MatchFoundEvent,
	NoEventsEvent,
	StateEvent,
	YourTurnEvent,
} from "@fightclaw/protocol";
import { EVENT_VERSION } from "@fightclaw/protocol";

export { EVENT_VERSION };
export type {
	AgentThoughtEvent,
	EngineEventsEvent,
	GameEndedEvent,
	MatchEndedEvent,
	MatchFoundEvent,
	NoEventsEvent,
	StateEvent,
	YourTurnEvent,
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
	state: unknown,
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

export const buildAgentThoughtEvent = (
	matchId: string,
	payload: Omit<AgentThoughtEvent, "eventVersion" | "event" | "matchId">,
): AgentThoughtEvent => ({
	eventVersion: EVENT_VERSION,
	event: "agent_thought",
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
