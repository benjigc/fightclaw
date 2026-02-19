import type { SpectatorEvent } from "@fightclaw/engine";
import WebSocket from "ws";
import type { ArenaClient } from "./client";
import { isRecord } from "./errors";
import type { MatchEventHandler, MatchEventSource } from "./types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const toWebSocketUrl = (baseUrl: string, path: string) => {
	const url = new URL(path, baseUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
};

export class WsEventSource implements MatchEventSource {
	readonly kind = "ws" as const;
	private readonly client: ArenaClient;
	private readonly matchId: string;
	private readonly openTimeoutMs: number;

	constructor(client: ArenaClient, matchId: string, openTimeoutMs = 15_000) {
		this.client = client;
		this.matchId = matchId;
		this.openTimeoutMs = openTimeoutMs;
	}

	async start(handler: MatchEventHandler): Promise<() => void> {
		const wsPath = this.client.resolveRoute("match_ws", {
			matchId: this.matchId,
		});
		const url = toWebSocketUrl(this.client.getBaseUrl(), wsPath);
		const ws = new WebSocket(url, {
			headers: {
				...this.client.buildAgentAuthHeaders(),
			},
		});
		let closedByClient = false;

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				ws.terminate();
				reject(new Error("Timed out opening websocket event source."));
			}, this.openTimeoutMs);
			ws.once("open", () => {
				clearTimeout(timer);
				resolve();
			});
			ws.once("error", (error: Error) => {
				clearTimeout(timer);
				reject(error);
			});
		});

		ws.on("message", (raw: WebSocket.RawData) => {
			const text = raw.toString();
			let parsed: unknown = null;
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = null;
			}
			if (!isRecord(parsed) || typeof parsed.type !== "string") return;
			if (parsed.type === "your_turn") {
				if (typeof parsed.stateVersion === "number") {
					void handler({
						type: "your_turn",
						stateVersion: parsed.stateVersion,
					});
				}
				return;
			}
			if (parsed.type === "state") {
				if (typeof parsed.stateVersion === "number") {
					void handler({
						type: "state",
						stateVersion: parsed.stateVersion,
						payload: parsed.stateSnapshot,
					});
				}
				return;
			}
			if (parsed.type === "match_ended") {
				void handler({
					type: "match_ended",
					reason:
						typeof parsed.endReason === "string" ? parsed.endReason : undefined,
					winnerAgentId:
						typeof parsed.winnerAgentId === "string" ||
						parsed.winnerAgentId === null
							? parsed.winnerAgentId
							: null,
					loserAgentId: null,
				});
				return;
			}
			if (parsed.type === "error" && typeof parsed.error === "string") {
				void handler({ type: "error", error: parsed.error });
			}
		});
		ws.on("error", (error: Error) => {
			void handler({ type: "error", error: error.message });
		});
		ws.on("close", () => {
			if (closedByClient) return;
			void handler({ type: "error", error: "ws_closed" });
		});

		return () => {
			closedByClient = true;
			ws.close();
		};
	}
}

export class HttpLongPollEventSource implements MatchEventSource {
	readonly kind = "http" as const;
	private readonly client: ArenaClient;
	private readonly matchId: string;
	private readonly agentId: string;
	private readonly pollIntervalMs: number;
	private lastObservedVersion = -1;
	private lastTurnNotifiedVersion = -1;
	private ended = false;

	constructor(
		client: ArenaClient,
		matchId: string,
		agentId: string,
		pollIntervalMs = 1_500,
	) {
		this.client = client;
		this.matchId = matchId;
		this.agentId = agentId;
		this.pollIntervalMs = pollIntervalMs;
	}

	async start(handler: MatchEventHandler): Promise<() => void> {
		let closed = false;
		const loop = async () => {
			while (!closed) {
				try {
					await this.tick(handler);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					await handler({ type: "error", error: message });
				}
				if (this.ended || closed) break;
				await sleep(this.pollIntervalMs);
			}
		};
		void loop();
		return () => {
			closed = true;
		};
	}

	private async tick(handler: MatchEventHandler) {
		const payload = await this.client.getMatchState(this.matchId);
		const state = payload.state;
		if (!state) return;

		if (state.stateVersion !== this.lastObservedVersion) {
			this.lastObservedVersion = state.stateVersion;
			await handler({
				type: "state",
				stateVersion: state.stateVersion,
				payload: state,
			});
		}

		if (state.status === "ended") {
			this.ended = true;
			await handler({
				type: "match_ended",
				reason: state.endReason,
				winnerAgentId: state.winnerAgentId ?? null,
				loserAgentId: state.loserAgentId ?? null,
			});
			return;
		}

		const activeAgentId = this.extractActiveAgentId(state);
		if (
			activeAgentId === this.agentId &&
			state.stateVersion !== this.lastTurnNotifiedVersion
		) {
			this.lastTurnNotifiedVersion = state.stateVersion;
			await handler({
				type: "your_turn",
				stateVersion: state.stateVersion,
			});
		}
	}

	private extractActiveAgentId(state: unknown): string | null {
		if (!isRecord(state)) return null;
		const game = state.game;
		if (!isRecord(game)) return null;
		const activePlayer = game.activePlayer;
		const players = game.players;
		if (typeof activePlayer !== "string" || !isRecord(players)) return null;
		const active = players[activePlayer];
		if (!isRecord(active) || typeof active.id !== "string") return null;
		return active.id;
	}
}

export const parseQueueEvent = (events: SpectatorEvent[]) => {
	for (const event of events) {
		if (event.event === "match_found") {
			return {
				type: "match_found" as const,
				matchId: event.matchId,
			};
		}
	}
	return null;
};
