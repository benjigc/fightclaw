import type { Move, SpectatorEvent } from "@fightclaw/engine";
import type { RouteTable } from "./routes";

export type ErrorEnvelope = {
	ok: false;
	error: string;
	code?: string;
	requestId?: string;
} & Record<string, unknown>;

export type ClientLogEvent = {
	type: "request" | "response" | "runner";
	message: string;
	details?: Record<string, unknown>;
};

export type ArenaClientOptions = {
	baseUrl: string;
	agentApiKey?: string;
	routeOverrides?: Partial<RouteTable>;
	fetchImpl?: typeof fetch;
	requestIdProvider?: () => string;
	onLog?: (event: ClientLogEvent) => void;
};

export type RegisterResponse = {
	agentId: string;
	name: string;
	verified: boolean;
	apiKey: string;
	claimCode: string;
	apiKeyId: string | null;
	apiKeyPrefix: string | null;
};

export type VerifyResponse = {
	agentId: string;
	verifiedAt: string | null;
};

export type MeResponse = {
	agentId: string;
	name: string;
	verified: boolean;
	verifiedAt: string | null;
	createdAt: string | null;
	apiKeyId: string | null;
};

export type QueueJoinResponse = {
	status: "waiting" | "ready";
	matchId: string;
	opponentId?: string;
};

export type QueueStatusResponse =
	| { status: "idle" }
	| { status: "waiting"; matchId: string }
	| { status: "ready"; matchId: string; opponentId: string };

export type MoveSubmitResponse =
	| {
			ok: true;
			state: {
				stateVersion: number;
				status?: "active" | "ended";
				winnerAgentId?: string | null;
				endReason?: string;
				game?: {
					activePlayer?: string;
					players?: Record<string, { id?: string }>;
				};
			};
	  }
	| {
			ok: false;
			error: string;
			stateVersion?: number;
			forfeited?: boolean;
			matchStatus?: "ended";
			winnerAgentId?: string | null;
			reason?: string;
			reasonCode?: string;
	  };

export type MatchStateResponse = {
	state: {
		stateVersion: number;
		status: "active" | "ended";
		winnerAgentId?: string | null;
		loserAgentId?: string | null;
		endReason?: string;
		game?: {
			activePlayer?: string;
			players?: Record<string, { id?: string }>;
		};
	} | null;
};

export type QueueWaitResponse = {
	events: SpectatorEvent[];
};

export type RunnerEvent =
	| { type: "your_turn"; stateVersion: number }
	| { type: "state"; stateVersion: number; payload: unknown }
	| {
			type: "match_ended";
			reason?: string;
			winnerAgentId?: string | null;
			loserAgentId?: string | null;
	  }
	| { type: "error"; error: string };

export type MoveProviderContext = {
	agentId: string;
	matchId: string;
	stateVersion: number;
};

export type MoveProvider = {
	nextMove: (context: MoveProviderContext) => Promise<Move>;
};

export type MatchEventHandler = (event: RunnerEvent) => Promise<void> | void;

export type MatchEventSource = {
	kind: "ws" | "http";
	start: (handler: MatchEventHandler) => Promise<() => void>;
};

export type RunMatchOptions = {
	moveProvider: MoveProvider;
	preferredTransport?: "ws" | "http";
	allowTransportFallback?: boolean;
	queueTimeoutMs?: number;
	queueWaitTimeoutSeconds?: number;
	httpPollIntervalMs?: number;
	moveProviderTimeoutMs?: number;
	moveProviderTimeoutFallbackMove?: Move;
};

export type RunMatchResult = {
	matchId: string;
	transport: "ws" | "http";
	reason: string;
	winnerAgentId: string | null;
	loserAgentId: string | null;
};
