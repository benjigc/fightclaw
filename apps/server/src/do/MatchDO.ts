import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import {
	applyMove,
	type GameState,
	initialState,
	isTerminal,
	listLegalMoves,
	type Move,
	MoveSchema,
	winner,
} from "@fightclaw/engine";
import { z } from "zod";
import {
	buildGameEndedEvent,
	buildStateEvent,
	buildYourTurnEvent,
} from "../protocol/events";
import { formatSse } from "../protocol/sse";

type MatchEnv = {
	DB: D1Database;
	MATCHMAKER: DurableObjectNamespace;
	INTERNAL_RUNNER_KEY?: string;
	TEST_MODE?: string;
};

type MatchState = {
	stateVersion: number;
	status: "active" | "ended";
	updatedAt: string;
	createdAt: string;
	players: string[];
	game: GameState;
	lastMove: Move | null;
	endedAt?: string;
	winnerAgentId?: string;
	loserAgentId?: string;
};

type MoveResult =
	| { ok: true; state: MatchState }
	| { ok: false; error: string };

type MovePayload = {
	moveId: string;
	expectedVersion: number;
	move: unknown;
};

type MoveResponse =
	| { ok: true; state: MatchState }
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

type FinishPayload = {
	reason?: "forfeit";
};

type FinishResponse =
	| { ok: true; state: MatchState }
	| { ok: false; error: string };

type IdempotencyEntry = {
	status: number;
	body: MoveResponse;
};

type StreamWriter = WritableStreamDefaultWriter<Uint8Array>;

const IDEMPOTENCY_PREFIX = "move:";
const IDEMPOTENCY_INDEX_KEY = "idempotency:index";
// Bound idempotency cache size to avoid unbounded DO storage growth.
const IDEMPOTENCY_MAX = 200;
const MATCH_ID_KEY = "matchId";
const SSE_WRITE_TIMEOUT_MS = 5000;
const ELO_K = 32;
const ELO_START = 1500;

const initPayloadSchema = z
	.object({
		players: z.array(z.string()).length(2),
		seed: z.number().int().optional(),
	})
	.strict();

export class MatchDO extends DurableObject<MatchEnv> {
	private readonly encoder = new TextEncoder();
	private spectators = new Set<StreamWriter>();
	private agentStreams = new Map<string, Set<StreamWriter>>();
	private matchId: string | null = null;

	constructor(ctx: DurableObjectState, env: MatchEnv) {
		super(ctx, env);
		this.matchId = ctx.id.name ?? null;
	}

	async fetch(request: Request): Promise<Response> {
		const headerMatchId = request.headers.get("x-match-id");
		if (!this.matchId) {
			this.matchId = this.ctx.id.name ?? headerMatchId ?? null;
		}

		const url = new URL(request.url);

		if (request.method === "POST" && url.pathname === "/init") {
			const body = await request.json().catch(() => null);
			const parsed = initPayloadSchema.safeParse(body);
			if (!parsed.success) {
				return Response.json(
					{ ok: false, error: "Init payload must include two players." },
					{ status: 400 },
				);
			}

			const existing = await this.ctx.storage.get<MatchState>("state");
			if (existing) {
				return Response.json({ ok: true, state: existing });
			}

			const seed = parsed.data.seed ?? Math.floor(Math.random() * 1_000_000);
			const nextState = createInitialState(parsed.data.players, seed);
			if (this.matchId) {
				await this.ctx.storage.put(MATCH_ID_KEY, this.matchId);
			}
			await this.ctx.storage.put("state", nextState);
			await this.recordEvent(nextState, "match_started", {
				players: nextState.players,
				seed,
			});
			await this.broadcastState(nextState);
			this.broadcastYourTurn(nextState);
			return Response.json({ ok: true, state: nextState });
		}

		if (request.method === "POST" && url.pathname === "/move") {
			const body = await request.json().catch(() => null);
			if (!isMovePayload(body)) {
				return Response.json(
					{
						ok: false,
						error:
							"Move payload must include moveId, expectedVersion, and move.",
					},
					{ status: 400 },
				);
			}

			const agentId = request.headers.get("x-agent-id");
			if (!agentId) {
				return Response.json(
					{ ok: false, error: "Agent id is required." },
					{ status: 400 },
				);
			}

			const idempotencyKey = `${IDEMPOTENCY_PREFIX}${body.moveId}`;
			const cached =
				await this.ctx.storage.get<IdempotencyEntry>(idempotencyKey);
			if (cached) {
				return Response.json(cached.body, { status: cached.status });
			}

			const state = await this.ctx.storage.get<MatchState>("state");
			if (!state) {
				const response = {
					ok: false,
					error: "Match not initialized.",
				} satisfies MoveResponse;
				await this.storeIdempotency(
					body.moveId,
					{ status: 409, body: response },
					-1,
				);
				return Response.json(response, { status: 409 });
			}

			if (state.status === "ended") {
				const response = {
					ok: false,
					error: "Match has ended.",
					stateVersion: state.stateVersion,
				} satisfies MoveResponse;
				await this.storeIdempotency(
					body.moveId,
					{ status: 409, body: response },
					state.stateVersion,
				);
				return Response.json(response, { status: 409 });
			}

			if (body.expectedVersion !== state.stateVersion) {
				const response = {
					ok: false,
					error: "Version mismatch.",
					stateVersion: state.stateVersion,
				} satisfies MoveResponse;
				await this.storeIdempotency(
					body.moveId,
					{ status: 409, body: response },
					state.stateVersion,
				);
				return Response.json(response, { status: 409 });
			}

			const moveParse = MoveSchema.safeParse(body.move);
			if (!moveParse.success) {
				const forfeited = await this.forfeitMatch(
					state,
					agentId,
					"invalid_move_schema",
				);
				const response = {
					ok: false,
					error: "Invalid move schema.",
					stateVersion: forfeited.stateVersion,
					forfeited: true,
					matchStatus: "ended",
					winnerAgentId: forfeited.winnerAgentId ?? null,
					reason: "invalid_move_schema",
					reasonCode: "invalid_move_schema",
				} satisfies MoveResponse;
				await this.storeIdempotency(
					body.moveId,
					{ status: 400, body: response },
					forfeited.stateVersion,
				);
				return Response.json(response, { status: 400 });
			}

			if (!state.players.includes(agentId)) {
				const response = {
					ok: false,
					error: "Agent not part of match.",
				} satisfies MoveResponse;
				await this.storeIdempotency(
					body.moveId,
					{ status: 403, body: response },
					state.stateVersion,
				);
				return Response.json(response, { status: 403 });
			}

			const active = getActiveAgentId(state.game);
			if (!active || active !== agentId) {
				const response = {
					ok: false,
					error: "Not your turn.",
				} satisfies MoveResponse;
				await this.storeIdempotency(
					body.moveId,
					{ status: 409, body: response },
					state.stateVersion,
				);
				return Response.json(response, { status: 409 });
			}

			const legalMoves = listLegalMoves(state.game);
			const isLegal = legalMoves.some(
				(m) => m.action === moveParse.data.action,
			);
			if (!isLegal) {
				const forfeited = await this.forfeitMatch(
					state,
					agentId,
					"illegal_move",
				);
				const response = {
					ok: false,
					error: "Illegal move.",
					stateVersion: forfeited.stateVersion,
					forfeited: true,
					matchStatus: "ended",
					winnerAgentId: forfeited.winnerAgentId ?? null,
					reason: "illegal_move",
					reasonCode: "illegal_move",
				} satisfies MoveResponse;
				await this.storeIdempotency(
					body.moveId,
					{ status: 400, body: response },
					forfeited.stateVersion,
				);
				return Response.json(response, { status: 400 });
			}

			const result = applyMoveToState(state, moveParse.data);

			if (!result.ok) {
				const forfeited = await this.forfeitMatch(
					state,
					agentId,
					"invalid_move",
				);
				const response = {
					ok: false,
					error: result.error,
					stateVersion: forfeited.stateVersion,
					forfeited: true,
					matchStatus: "ended",
					winnerAgentId: forfeited.winnerAgentId ?? null,
					reason: "invalid_move",
					reasonCode: "invalid_move",
				} satisfies MoveResponse;
				await this.storeIdempotency(
					body.moveId,
					{ status: 400, body: response },
					forfeited.stateVersion,
				);
				return Response.json(response, { status: 400 });
			}

			await this.ctx.storage.put("state", result.state);

			const response = { ok: true, state: result.state } satisfies MoveResponse;
			await this.storeIdempotency(
				body.moveId,
				{ status: 200, body: response },
				result.state.stateVersion,
			);

			if (result.state.status === "ended") {
				await this.finalizeMatch(result.state, "terminal");
			}

			await this.recordEvent(result.state, "move_applied", {
				agentId,
				move: moveParse.data,
				stateVersion: result.state.stateVersion,
			});

			await this.broadcastState(result.state);
			this.broadcastYourTurn(result.state);
			if (result.state.status === "ended") {
				await this.recordEvent(result.state, "match_ended", {
					winnerAgentId: result.state.winnerAgentId ?? null,
					loserAgentId: result.state.loserAgentId ?? null,
					reason: "terminal",
				});
				await this.broadcastGameEnd(result.state, "terminal");
			}

			return Response.json(response);
		}

		if (request.method === "POST" && url.pathname === "/finish") {
			const body = await request.json().catch(() => null);
			if (!isFinishPayload(body)) {
				return Response.json(
					{
						ok: false,
						error: "Finish payload must be empty or include reason.",
					},
					{ status: 400 },
				);
			}

			const agentId = request.headers.get("x-agent-id");
			if (!agentId) {
				return Response.json(
					{ ok: false, error: "Agent id is required." },
					{ status: 400 },
				);
			}

			const state = await this.ctx.storage.get<MatchState>("state");
			if (!state) {
				return Response.json(
					{ ok: false, error: "Match not initialized." },
					{ status: 409 },
				);
			}

			if (state.status === "ended") {
				const response: FinishResponse = { ok: true, state };
				return Response.json(response);
			}

			if (!state.players.includes(agentId)) {
				return Response.json(
					{ ok: false, error: "Agent not part of match." },
					{ status: 403 },
				);
			}

			const nextState = await this.forfeitMatch(state, agentId, "forfeit");

			const response: FinishResponse = { ok: true, state: nextState };
			return Response.json(response);
		}

		if (request.method === "GET" && url.pathname === "/state") {
			const state = await this.ctx.storage.get<MatchState>("state");
			return Response.json({ state: state ?? null });
		}

		if (request.method === "GET" && url.pathname === "/stream") {
			const agentId = request.headers.get("x-agent-id");
			if (!agentId) {
				return new Response("Agent id is required.", { status: 400 });
			}
			const state = await this.ctx.storage.get<MatchState>("state");
			if (state && !state.players.includes(agentId)) {
				return new Response("Agent not part of match.", { status: 403 });
			}

			const { readable, writer, close } = this.createStream();
			this.registerAgentStream(agentId, writer);
			this.handleAbort(request, () => {
				this.unregisterAgentStream(agentId, writer);
				void close();
			});

			if (state) {
				const matchId = await this.resolveMatchId();
				if (!matchId) {
					return new Response("Match id unavailable.", { status: 409 });
				}
				void this.sendEvent(
					writer,
					"state",
					buildStateEvent(matchId, state.game),
				).catch(() => {
					this.unregisterAgentStream(agentId, writer);
				});
				this.sendYourTurnIfActive(state, agentId, writer);
			}

			return this.streamResponse(readable);
		}

		if (request.method === "GET" && url.pathname === "/spectate") {
			return this.handleSpectate(request);
		}

		if (request.method === "GET" && url.pathname === "/events") {
			return this.handleSpectate(request);
		}

		return new Response("Not found", { status: 404 });
	}

	private createStream() {
		const stream = new TransformStream<Uint8Array, Uint8Array>();
		const writer = stream.writable.getWriter();
		return {
			readable: stream.readable,
			writer,
			close: async () => {
				try {
					await writer.close();
				} catch {
					// ignore
				}
			},
		};
	}

	private handleAbort(request: Request, onAbort: () => void) {
		if (request.signal.aborted) {
			onAbort();
			return;
		}
		request.signal.addEventListener("abort", onAbort, { once: true });
	}

	private streamResponse(readable: ReadableStream<Uint8Array>) {
		return new Response(readable, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	}

	private registerAgentStream(agentId: string, writer: StreamWriter) {
		const existing = this.agentStreams.get(agentId) ?? new Set<StreamWriter>();
		existing.add(writer);
		this.agentStreams.set(agentId, existing);
	}

	private unregisterAgentStream(agentId: string, writer: StreamWriter) {
		const set = this.agentStreams.get(agentId);
		if (!set) return;
		set.delete(writer);
		if (set.size === 0) this.agentStreams.delete(agentId);
	}

	private async sendEvent(writer: StreamWriter, event: string, data: unknown) {
		await this.sendEventWithTimeout(writer, event, data, SSE_WRITE_TIMEOUT_MS);
	}

	private async broadcastState(state: MatchState) {
		const matchId = this.matchId ?? this.ctx.id.name;
		if (!matchId) return;
		await this.broadcast(
			[...this.spectators, ...this.allAgentWriters()],
			"state",
			buildStateEvent(matchId, state.game),
		);
	}

	private broadcastYourTurn(state: MatchState) {
		if (state.status !== "active") return;
		const active = getActiveAgentId(state.game);
		if (!active) return;
		const writers = this.agentStreams.get(active);
		if (!writers) return;
		const matchId = this.matchId ?? this.ctx.id.name;
		if (!matchId) return;
		const payload = buildYourTurnEvent(matchId, state.stateVersion);
		for (const writer of writers) {
			void this.sendEvent(writer, "your_turn", payload).catch(() => {
				writers.delete(writer);
			});
		}
	}

	private sendYourTurnIfActive(
		state: MatchState,
		agentId: string,
		writer: StreamWriter,
	) {
		if (state.status !== "active") return;
		const active = getActiveAgentId(state.game);
		if (!active || active !== agentId) return;
		const matchId = this.matchId ?? this.ctx.id.name;
		if (!matchId) return;
		void this.sendEvent(
			writer,
			"your_turn",
			buildYourTurnEvent(matchId, state.stateVersion),
		);
	}

	private async broadcastGameEnd(state: MatchState, reason: string) {
		const matchId = this.matchId ?? this.ctx.id.name;
		if (!matchId) return;
		const payload = buildGameEndedEvent(
			matchId,
			state.winnerAgentId ?? null,
			state.loserAgentId ?? null,
			reason,
		);
		await this.broadcast(
			[...this.spectators, ...this.allAgentWriters()],
			"game_ended",
			payload,
		);
	}

	private allAgentWriters(): StreamWriter[] {
		const writers: StreamWriter[] = [];
		for (const set of this.agentStreams.values()) {
			writers.push(...set);
		}
		return writers;
	}

	private async broadcast(
		writers: StreamWriter[],
		event: string,
		data: unknown,
	) {
		for (const writer of writers) {
			try {
				await this.sendEvent(writer, event, data);
			} catch {
				this.spectators.delete(writer);
				for (const [agentId, set] of this.agentStreams.entries()) {
					if (set.delete(writer) && set.size === 0) {
						this.agentStreams.delete(agentId);
					}
				}
			}
		}
	}

	private async sendEventWithTimeout(
		writer: StreamWriter,
		event: string,
		data: unknown,
		timeoutMs: number,
	) {
		const payload = formatSse(event, data);
		const write = writer.write(this.encoder.encode(payload));
		let timeoutId: ReturnType<typeof setTimeout> | null = null;
		const timeout = new Promise((_, reject) => {
			timeoutId = setTimeout(
				() => reject(new Error("SSE write timeout")),
				timeoutMs,
			);
		});
		try {
			await Promise.race([write, timeout]);
		} finally {
			if (timeoutId !== null) clearTimeout(timeoutId);
		}
	}

	private async storeIdempotency(
		moveId: string,
		entry: IdempotencyEntry,
		stateVersion?: number,
	) {
		const key = `${IDEMPOTENCY_PREFIX}${moveId}`;
		await this.ctx.storage.put(key, entry);
		const index =
			(await this.ctx.storage.get<{ moveId: string; stateVersion: number }[]>(
				IDEMPOTENCY_INDEX_KEY,
			)) ?? [];
		index.push({ moveId, stateVersion: stateVersion ?? -1 });

		if (index.length > IDEMPOTENCY_MAX) {
			const currentVersion = stateVersion ?? -1;
			const protectedMin = currentVersion >= 0 ? currentVersion - 1 : -1;
			const retained = index.filter(
				(item) => item.stateVersion >= protectedMin,
			);
			const trimmed =
				retained.length > IDEMPOTENCY_MAX
					? retained.slice(retained.length - IDEMPOTENCY_MAX)
					: retained;
			const keep = new Set(trimmed.map((item) => item.moveId));
			const evicted = index
				.filter((item) => !keep.has(item.moveId))
				.map((item) => `${IDEMPOTENCY_PREFIX}${item.moveId}`);

			if (evicted.length > 0) {
				await this.ctx.storage.delete(evicted);
			}
			await this.ctx.storage.put(IDEMPOTENCY_INDEX_KEY, trimmed);
			return;
		}

		await this.ctx.storage.put(IDEMPOTENCY_INDEX_KEY, index);
	}

	private async recordEvent(
		state: MatchState,
		eventType: string,
		payload: unknown,
	) {
		const matchId = await this.resolveMatchId();
		if (!matchId) return;
		try {
			await this.env.DB.prepare(
				"INSERT INTO match_events(match_id, turn, event_type, payload_json) VALUES (?, ?, ?, ?)",
			)
				.bind(
					matchId,
					state.game.turn,
					eventType,
					JSON.stringify(payload ?? null),
				)
				.run();
		} catch (error) {
			console.error("Failed to record match event", error);
		}
	}

	private async forfeitMatch(
		state: MatchState,
		loserAgentId: string,
		reason: string,
	) {
		if (state.status === "ended") return state;
		const winnerAgentId = state.players.find(
			(player) => player !== loserAgentId,
		);
		const endedAt = new Date().toISOString();
		const nextState: MatchState = {
			...state,
			game: { ...state.game, status: "ended" },
			status: "ended",
			endedAt,
			updatedAt: endedAt,
			stateVersion: state.stateVersion + 1,
			winnerAgentId: winnerAgentId ?? undefined,
			loserAgentId,
		};

		await this.ctx.storage.put("state", nextState);
		await this.broadcastState(nextState);
		await this.broadcastGameEnd(nextState, reason);
		await this.finalizeMatch(nextState, reason);
		await this.recordEvent(nextState, "move_forfeit", {
			loserAgentId,
			winnerAgentId: winnerAgentId ?? null,
			reason,
		});
		await this.recordEvent(nextState, "match_ended", {
			winnerAgentId: winnerAgentId ?? null,
			loserAgentId,
			reason,
		});
		return nextState;
	}

	private async persistFinalization(state: MatchState, reason: string) {
		const matchId = await this.resolveMatchId();
		if (!matchId) {
			console.warn("Match id unavailable for finalization");
			return;
		}

		const result = await this.env.DB.prepare(
			"INSERT OR IGNORE INTO match_results(match_id, winner_agent_id, loser_agent_id, reason) VALUES (?, ?, ?, ?)",
		)
			.bind(
				matchId,
				state.winnerAgentId ?? null,
				state.loserAgentId ?? null,
				reason,
			)
			.run();

		const updateMatch = this.env.DB.prepare(
			"UPDATE matches SET status='ended', ended_at=?, winner_agent_id=? WHERE id=? AND ended_at IS NULL",
		).bind(state.endedAt ?? null, state.winnerAgentId ?? null, matchId);

		if (!result.changes) {
			await this.env.DB.batch([updateMatch]);
			return;
		}

		if (!state.winnerAgentId || !state.loserAgentId) {
			await this.env.DB.batch([updateMatch]);
			await this.notifyFeaturedEnded(matchId);
			return;
		}

		await this.env.DB.batch([
			this.env.DB.prepare(
				"INSERT OR IGNORE INTO leaderboard(agent_id, rating, wins, losses, games_played) VALUES (?, ?, 0, 0, 0)",
			).bind(state.winnerAgentId, ELO_START),
			this.env.DB.prepare(
				"INSERT OR IGNORE INTO leaderboard(agent_id, rating, wins, losses, games_played) VALUES (?, ?, 0, 0, 0)",
			).bind(state.loserAgentId, ELO_START),
		]);

		const winnerRow = await this.env.DB.prepare(
			"SELECT rating FROM leaderboard WHERE agent_id = ?",
		)
			.bind(state.winnerAgentId)
			.first<{ rating: number }>();

		const loserRow = await this.env.DB.prepare(
			"SELECT rating FROM leaderboard WHERE agent_id = ?",
		)
			.bind(state.loserAgentId)
			.first<{ rating: number }>();

		const winnerRating =
			typeof winnerRow?.rating === "number" ? winnerRow.rating : ELO_START;
		const loserRating =
			typeof loserRow?.rating === "number" ? loserRow.rating : ELO_START;

		const { winnerNext, loserNext } = calculateElo(winnerRating, loserRating);

		await this.env.DB.batch([
			updateMatch,
			this.env.DB.prepare(
				"UPDATE leaderboard SET rating=?, wins=wins+1, games_played=games_played+1, updated_at=datetime('now') WHERE agent_id=?",
			).bind(winnerNext, state.winnerAgentId),
			this.env.DB.prepare(
				"UPDATE leaderboard SET rating=?, losses=losses+1, games_played=games_played+1, updated_at=datetime('now') WHERE agent_id=?",
			).bind(loserNext, state.loserAgentId),
		]);
		await this.notifyFeaturedEnded(matchId);
	}

	private async handleSpectate(request: Request) {
		const state = await this.ctx.storage.get<MatchState>("state");
		const { readable, writer, close } = this.createStream();
		this.spectators.add(writer);
		this.handleAbort(request, () => {
			this.spectators.delete(writer);
			void close();
		});

		if (state) {
			const matchId = await this.resolveMatchId();
			if (!matchId) {
				return new Response("Match id unavailable.", { status: 409 });
			}
			void this.sendEvent(
				writer,
				"state",
				buildStateEvent(matchId, state.game),
			).catch(() => {
				this.spectators.delete(writer);
			});
			if (state.status === "ended") {
				void this.sendEvent(
					writer,
					"game_ended",
					buildGameEndedEvent(
						matchId,
						state.winnerAgentId ?? null,
						state.loserAgentId ?? null,
						"ended",
					),
				).catch(() => {
					this.spectators.delete(writer);
				});
			}
		}

		return this.streamResponse(readable);
	}

	private async notifyFeaturedEnded(matchId: string) {
		const key = this.env.INTERNAL_RUNNER_KEY;
		if (!key) {
			console.warn("INTERNAL_RUNNER_KEY missing; featured rotation skipped");
			return;
		}

		try {
			const id = this.env.MATCHMAKER.idFromName("global");
			const stub = this.env.MATCHMAKER.get(id);
			await stub.fetch("https://do/featured/ended", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-runner-key": key,
				},
				body: JSON.stringify({ matchId }),
			});
		} catch (error) {
			console.error("Failed to notify featured rotation", error);
		}
	}

	private async finalizeMatch(state: MatchState, reason: string) {
		const task = this.persistFinalization(state, reason);
		if (this.env.TEST_MODE) {
			await task;
			return;
		}
		this.ctx.waitUntil(task);
	}

	private async resolveMatchId(): Promise<string | null> {
		if (this.matchId) return this.matchId;
		const stored = await this.ctx.storage.get<string>(MATCH_ID_KEY);
		if (stored) {
			this.matchId = stored;
			return stored;
		}
		return null;
	}
}

const createInitialState = (players: string[], seed: number): MatchState => {
	const now = new Date().toISOString();
	return {
		stateVersion: 0,
		status: "active",
		updatedAt: now,
		createdAt: now,
		players,
		game: initialState(seed, players),
		lastMove: null,
	};
};

const applyMoveToState = (state: MatchState, move: Move): MoveResult => {
	try {
		const applied = applyMove(state.game, move);
		if (!applied.ok) {
			return { ok: false, error: applied.error };
		}
		const nextGame = applied.state;
		const now = new Date().toISOString();

		let nextState: MatchState = {
			...state,
			game: nextGame,
			lastMove: move,
			updatedAt: now,
			stateVersion: state.stateVersion + 1,
		};

		const terminal = isTerminal(nextGame);
		if (nextGame.status === "ended" || terminal.ended) {
			const winnerAgentId = winner(nextGame) ?? undefined;
			const loserAgentId = winnerAgentId
				? state.players.find((player) => player !== winnerAgentId)
				: undefined;

			nextState = {
				...nextState,
				status: "ended",
				endedAt: now,
				winnerAgentId,
				loserAgentId,
			};
		}

		return { ok: true, state: nextState };
	} catch (error) {
		return { ok: false, error: (error as Error).message };
	}
};

const getActiveAgentId = (game: GameState) => {
	const side = game.activePlayer;
	const player = game.players[side];
	return player?.id ?? null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isMovePayload = (value: unknown): value is MovePayload => {
	if (!isRecord(value)) return false;
	const moveId = value.moveId;
	const expectedVersion = value.expectedVersion;
	const hasMove = Object.hasOwn(value, "move");
	return (
		typeof moveId === "string" &&
		moveId.length > 0 &&
		typeof expectedVersion === "number" &&
		Number.isInteger(expectedVersion) &&
		hasMove
	);
};

const isFinishPayload = (value: unknown): value is FinishPayload => {
	if (!isRecord(value)) return false;
	const reason = value.reason;
	return reason === undefined || reason === "forfeit";
};

const calculateElo = (winnerRating: number, loserRating: number) => {
	const expectedWinner = 1 / (1 + 10 ** ((loserRating - winnerRating) / 400));
	const expectedLoser = 1 / (1 + 10 ** ((winnerRating - loserRating) / 400));
	const winnerNext = Math.round(winnerRating + ELO_K * (1 - expectedWinner));
	const loserNext = Math.round(loserRating + ELO_K * (0 - expectedLoser));
	return { winnerNext, loserNext };
};
