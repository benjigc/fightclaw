import { DurableObject } from "cloudflare:workers";
import type { AppBindings } from "../appTypes";
import { emitMetric } from "../obs/metrics";
import {
	buildMatchFoundEvent,
	buildNoEventsEvent,
	type MatchFoundEvent,
	type NoEventsEvent,
} from "../protocol/events";

const FEATURED_MATCH_KEY = "featuredMatchId";
const FEATURED_QUEUE_KEY = "featuredQueue";
const FEATURED_CACHE_KEY = "featuredCache";
const FEATURED_CACHE_TTL_MS = 10_000;
const EVENT_BUFFER_PREFIX = "events:";
const EVENT_BUFFER_MAX = 25;
const ELO_START = 1500;
const ELO_RANGE_DEFAULT = 200;
const QUEUE_KEY = "queue";
const ACTIVE_MATCH_PREFIX = "activeMatch:";
const RECENT_PREFIX = "recent:";
const QUEUE_TTL_MS = 10 * 60 * 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

type MatchmakerEnv = {
	DB: D1Database;
	MATCH: DurableObjectNamespace;
	INTERNAL_RUNNER_KEY?: string;
	MATCHMAKING_ELO_RANGE?: string;
	TEST_MODE?: string;
} & Partial<Pick<AppBindings, "OBS" | "SENTRY_ENVIRONMENT">>;

type QueueJoinResponse = {
	matchId: string;
	status: "waiting" | "ready";
	opponentId?: string;
};
type QueueStatusResponse =
	| { status: "idle" }
	| { status: "waiting"; matchId: string }
	| { status: "ready"; matchId: string; opponentId: string };
type QueueEntry = {
	agentId: string;
	matchId: string;
	rating: number;
	enqueuedAtMs: number;
};
type ActiveMatchEntry = {
	matchId: string;
	opponentId: string;
	setAtMs: number;
};
type MatchmakerEvent = MatchFoundEvent | NoEventsEvent;
type FeaturedStatus = "active" | "ended";
type FeaturedSnapshot = {
	matchId: string | null;
	status: FeaturedStatus | null;
	players: string[] | null;
};
type FeaturedCache = FeaturedSnapshot & { checkedAt: number };

export class MatchmakerDO extends DurableObject<MatchmakerEnv> {
	private waiters = new Map<string, Set<(event: MatchmakerEvent) => void>>();

	private isDurableObjectResetError(error: unknown) {
		if (!error || typeof error !== "object") return false;
		const anyErr = error as { message?: unknown; durableObjectReset?: unknown };
		if (anyErr.durableObjectReset === true) return true;
		const message = typeof anyErr.message === "string" ? anyErr.message : "";
		return message.includes("invalidating this Durable Object");
	}

	private async doFetchWithRetry(
		stub: { fetch: (input: string, init?: RequestInit) => Promise<Response> },
		input: string,
		init?: RequestInit,
		retries = 2,
	) {
		let attempt = 0;
		for (;;) {
			try {
				return await stub.fetch(input, init);
			} catch (error) {
				if (attempt >= retries || !this.isDurableObjectResetError(error)) {
					throw error;
				}
				attempt += 1;
				await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
			}
		}
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "POST" && url.pathname === "/__test__/reset") {
			if (!this.env.TEST_MODE) {
				return Response.json({ error: "Not found." }, { status: 404 });
			}
			const auth = this.requireRunnerKey(request);
			if (!auth.ok) return auth.response;
			await this.ctx.storage.deleteAll();
			this.waiters.clear();
			return Response.json({ ok: true });
		}

		if (
			request.method === "POST" &&
			(url.pathname === "/queue" || url.pathname === "/queue/join")
		) {
			return this.handleQueueJoin(request);
		}

		if (request.method === "GET" && url.pathname === "/queue/status") {
			return this.handleQueueStatus(request);
		}

		if (
			(request.method === "DELETE" || request.method === "POST") &&
			url.pathname === "/queue/leave"
		) {
			return this.handleQueueLeave(request);
		}

		if (request.method === "GET" && url.pathname === "/events/wait") {
			const agentId = request.headers.get("x-agent-id");
			if (!agentId) {
				return Response.json(
					{ error: "Agent id is required." },
					{ status: 400 },
				);
			}

			const timeoutParam = url.searchParams.get("timeout");
			const timeoutSeconds = timeoutParam
				? Number.parseInt(timeoutParam, 10)
				: 30;
			const event = await this.waitForEvent(
				agentId,
				Number.isNaN(timeoutSeconds) ? 30 : timeoutSeconds,
			);
			return Response.json({ events: [event] });
		}

		if (request.method === "POST" && url.pathname === "/featured/ended") {
			const auth = this.requireRunnerKey(request);
			if (!auth.ok) return auth.response;

			const body: unknown = await request.json().catch(() => null);
			const matchId =
				isRecord(body) && typeof body.matchId === "string"
					? body.matchId
					: null;
			if (!matchId) {
				return Response.json(
					{ error: "matchId is required." },
					{ status: 400 },
				);
			}

			await this.rotateFeatured(matchId);
			await this.clearActiveMatchesForMatch(matchId);
			return Response.json({ ok: true });
		}

		if (request.method === "POST" && url.pathname === "/featured/queue") {
			const auth = this.requireRunnerKey(request);
			if (!auth.ok) return auth.response;

			const body: unknown = await request.json().catch(() => null);
			const matchId =
				isRecord(body) && typeof body.matchId === "string"
					? body.matchId
					: null;
			if (!matchId) {
				return Response.json(
					{ error: "matchId is required." },
					{ status: 400 },
				);
			}

			const players =
				isRecord(body) && Array.isArray(body.players)
					? body.players.filter((value: unknown) => typeof value === "string")
					: [];
			await this.enqueueFeaturedMatch(matchId, players);
			return Response.json({ ok: true });
		}

		if (request.method === "GET" && url.pathname === "/featured/queue") {
			const auth = this.requireRunnerKey(request);
			if (!auth.ok) return auth.response;

			const featured = await this.ctx.storage.get<string>(FEATURED_MATCH_KEY);
			const queue =
				(await this.ctx.storage.get<string[]>(FEATURED_QUEUE_KEY)) ?? [];
			return Response.json({ featured: featured ?? null, queue });
		}

		if (request.method === "GET" && url.pathname === "/featured") {
			const snapshot = await this.resolveFeatured({ verifyDo: true });
			return Response.json(snapshot);
		}

		if (request.method === "GET" && url.pathname === "/live") {
			const snapshot = await this.resolveFeatured({ verifyDo: true });
			if (!snapshot.matchId) {
				return Response.json({ matchId: null, state: null });
			}

			const id = this.env.MATCH.idFromName(snapshot.matchId);
			const stub = this.env.MATCH.get(id);
			const resp = await this.doFetchWithRetry(stub, "https://do/state");
			if (!resp.ok) {
				return Response.json({ matchId: snapshot.matchId, state: null });
			}

			const payload = (await resp.json()) as { state?: unknown };
			return Response.json({
				matchId: snapshot.matchId,
				state: payload.state ?? null,
			});
		}

		return new Response("Not found", { status: 404 });
	}

	private queueMutex: Promise<void> = Promise.resolve();

	private async withQueueMutex<T>(fn: () => Promise<T>): Promise<T> {
		const previous = this.queueMutex;
		let release: (() => void) | undefined;
		this.queueMutex = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await fn();
		} finally {
			release?.();
		}
	}

	private matchmakingEloRange() {
		const raw = this.env.MATCHMAKING_ELO_RANGE;
		const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
		if (Number.isNaN(parsed) || parsed <= 0) return ELO_RANGE_DEFAULT;
		return parsed;
	}

	private async loadQueuePruned(nowMs: number): Promise<QueueEntry[]> {
		const queue = (await this.ctx.storage.get<QueueEntry[]>(QUEUE_KEY)) ?? [];
		const pruned = queue.filter((entry) => {
			if (!entry || typeof entry !== "object") return false;
			if (typeof entry.agentId !== "string" || entry.agentId.length === 0) {
				return false;
			}
			if (typeof entry.matchId !== "string" || entry.matchId.length === 0) {
				return false;
			}
			if (typeof entry.rating !== "number" || !Number.isFinite(entry.rating)) {
				return false;
			}
			if (
				typeof entry.enqueuedAtMs !== "number" ||
				!Number.isFinite(entry.enqueuedAtMs)
			) {
				return false;
			}
			return nowMs - entry.enqueuedAtMs <= QUEUE_TTL_MS;
		});

		if (pruned.length !== queue.length) {
			await this.ctx.storage.put(QUEUE_KEY, pruned);
		}
		return pruned;
	}

	private async resolveActiveMatch(
		agentId: string,
	): Promise<ActiveMatchEntry | null> {
		const key = `${ACTIVE_MATCH_PREFIX}${agentId}`;
		const stored = await this.ctx.storage.get<ActiveMatchEntry>(key);
		if (
			!stored ||
			typeof stored.matchId !== "string" ||
			stored.matchId.length === 0 ||
			typeof stored.opponentId !== "string" ||
			stored.opponentId.length === 0
		) {
			if (stored) await this.ctx.storage.delete(key);
			return null;
		}

		const status = await this.getMatchStatus(stored.matchId);
		if (status !== "active") {
			await this.ctx.storage.delete(key);
			return null;
		}

		return stored;
	}

	private selectOpponent(
		candidates: QueueEntry[],
		rating: number,
	): QueueEntry | null {
		let best: QueueEntry | null = null;

		for (const candidate of candidates) {
			if (!best) {
				best = candidate;
				continue;
			}

			const diff = Math.abs(candidate.rating - rating);
			const bestDiff = Math.abs(best.rating - rating);
			if (diff < bestDiff) {
				best = candidate;
				continue;
			}
			if (diff > bestDiff) continue;

			if (candidate.enqueuedAtMs < best.enqueuedAtMs) {
				best = candidate;
				continue;
			}
			if (candidate.enqueuedAtMs > best.enqueuedAtMs) continue;

			if (candidate.agentId < best.agentId) {
				best = candidate;
			}
		}

		return best;
	}

	private async handleQueueJoin(request: Request): Promise<Response> {
		return this.withQueueMutex(async () => {
			const agentId = request.headers.get("x-agent-id");
			if (!agentId) {
				return Response.json(
					{ error: "Agent id is required." },
					{ status: 400 },
				);
			}

			const activeMatch = await this.resolveActiveMatch(agentId);
			if (activeMatch) {
				const response: QueueJoinResponse = {
					matchId: activeMatch.matchId,
					status: "ready",
					opponentId: activeMatch.opponentId,
				};
				return Response.json(response);
			}

			const nowMs = Date.now();
			let queue = await this.loadQueuePruned(nowMs);

			const existing = queue.find((entry) => entry.agentId === agentId);
			if (existing) {
				const response: QueueJoinResponse = {
					matchId: existing.matchId,
					status: "waiting",
				};
				return Response.json(response);
			}

			const rating = await this.getRating(agentId);
			const range = this.matchmakingEloRange();

			const eligible = queue.filter(
				(entry) =>
					entry.agentId !== agentId && Math.abs(entry.rating - rating) <= range,
			);

			let candidates = eligible;
			const lastOpponent = await this.ctx.storage.get<string>(
				`${RECENT_PREFIX}${agentId}`,
			);
			if (lastOpponent && candidates.length > 0) {
				const opponentRecents = await Promise.all(
					candidates.map(async (entry) => {
						return await this.ctx.storage.get<string>(
							`${RECENT_PREFIX}${entry.agentId}`,
						);
					}),
				);

				const preferred = candidates.filter(
					(entry, idx) =>
						entry.agentId !== lastOpponent && opponentRecents[idx] !== agentId,
				);
				if (preferred.length > 0) {
					candidates = preferred;
				}
			}

			const opponent = this.selectOpponent(candidates, rating);
			if (opponent) {
				queue = queue.filter((entry) => entry.agentId !== opponent.agentId);
				await this.ctx.storage.put(QUEUE_KEY, queue);

				const matchId = opponent.matchId;
				const players = [opponent.agentId, agentId];

				const id = this.env.MATCH.idFromName(matchId);
				const stub = this.env.MATCH.get(id);
				const initResp = await this.doFetchWithRetry(stub, "https://do/init", {
					method: "POST",
					body: JSON.stringify({
						players,
						seed: Math.floor(Math.random() * 1_000_000),
					}),
					headers: {
						"content-type": "application/json",
						"x-match-id": matchId,
					},
				});
				if (!initResp.ok) {
					// Best-effort recovery: re-add opponent to queue so they aren't lost.
					const restored: QueueEntry = {
						agentId: opponent.agentId,
						matchId: opponent.matchId,
						rating: opponent.rating,
						enqueuedAtMs: opponent.enqueuedAtMs,
					};
					const current =
						(await this.ctx.storage.get<QueueEntry[]>(QUEUE_KEY)) ?? [];
					if (!current.some((entry) => entry.agentId === restored.agentId)) {
						current.push(restored);
						await this.ctx.storage.put(QUEUE_KEY, current);
					}
					return Response.json(
						{ error: "Match initialization failed." },
						{ status: 503 },
					);
				}

				await this.recordMatch(matchId);
				await this.recordMatchPlayers(matchId, players);
				await this.enqueueFeaturedMatch(matchId, players);

				// Emit metrics for match creation and found
				emitMetric(this.env, "match_created", {
					scope: "matchmaker_do",
					matchId,
				});
				for (const playerId of players) {
					emitMetric(this.env, "match_found", {
						scope: "matchmaker_do",
						matchId,
						agentId: playerId,
					});
				}

				const recentAKey = `${RECENT_PREFIX}${opponent.agentId}`;
				const recentBKey = `${RECENT_PREFIX}${agentId}`;
				const activeAKey = `${ACTIVE_MATCH_PREFIX}${opponent.agentId}`;
				const activeBKey = `${ACTIVE_MATCH_PREFIX}${agentId}`;

				await this.ctx.storage.put(recentAKey, agentId);
				await this.ctx.storage.put(recentBKey, opponent.agentId);
				await this.ctx.storage.put(activeAKey, {
					matchId,
					opponentId: agentId,
					setAtMs: nowMs,
				} satisfies ActiveMatchEntry);
				await this.ctx.storage.put(activeBKey, {
					matchId,
					opponentId: opponent.agentId,
					setAtMs: nowMs,
				} satisfies ActiveMatchEntry);

				await this.enqueueEvent(
					opponent.agentId,
					buildMatchFoundEvent(matchId, agentId),
				);
				await this.enqueueEvent(
					agentId,
					buildMatchFoundEvent(matchId, opponent.agentId),
				);

				const response: QueueJoinResponse = {
					matchId,
					status: "ready",
					opponentId: opponent.agentId,
				};
				return Response.json(response);
			}

			const matchId = crypto.randomUUID();
			const entry: QueueEntry = {
				agentId,
				matchId,
				rating,
				enqueuedAtMs: nowMs,
			};
			queue = [...queue, entry];
			await this.ctx.storage.put(QUEUE_KEY, queue);

			// Emit queue_join metric
			emitMetric(this.env, "queue_join", {
				scope: "matchmaker_do",
				agentId,
			});

			const response: QueueJoinResponse = { matchId, status: "waiting" };
			return Response.json(response);
		});
	}

	private async handleQueueStatus(request: Request): Promise<Response> {
		return this.withQueueMutex(async () => {
			const agentId = request.headers.get("x-agent-id");
			if (!agentId) {
				return Response.json(
					{ error: "Agent id is required." },
					{ status: 400 },
				);
			}

			const activeMatch = await this.resolveActiveMatch(agentId);
			if (activeMatch) {
				const response: QueueStatusResponse = {
					status: "ready",
					matchId: activeMatch.matchId,
					opponentId: activeMatch.opponentId,
				};
				return Response.json(response);
			}

			const nowMs = Date.now();
			const queue = await this.loadQueuePruned(nowMs);
			const existing = queue.find((entry) => entry.agentId === agentId);
			if (existing) {
				const response: QueueStatusResponse = {
					status: "waiting",
					matchId: existing.matchId,
				};
				return Response.json(response);
			}

			const response: QueueStatusResponse = { status: "idle" };
			return Response.json(response);
		});
	}

	private async handleQueueLeave(request: Request): Promise<Response> {
		return this.withQueueMutex(async () => {
			const agentId = request.headers.get("x-agent-id");
			if (!agentId) {
				return Response.json(
					{ error: "Agent id is required." },
					{ status: 400 },
				);
			}

			const activeMatch = await this.resolveActiveMatch(agentId);
			if (activeMatch) {
				return Response.json(
					{ ok: false, error: "Already matched." },
					{ status: 409 },
				);
			}

			const nowMs = Date.now();
			const queue = await this.loadQueuePruned(nowMs);
			const next = queue.filter((entry) => entry.agentId !== agentId);
			if (next.length !== queue.length) {
				await this.ctx.storage.put(QUEUE_KEY, next);
			}

			return Response.json({ ok: true });
		});
	}

	private async clearActiveMatchesForMatch(matchId: string) {
		const players = await this.getMatchPlayers(matchId);
		if (!players || players.length === 0) return;

		const deletes: string[] = [];
		for (const agentId of players) {
			const key = `${ACTIVE_MATCH_PREFIX}${agentId}`;
			const stored = await this.ctx.storage.get<ActiveMatchEntry>(key);
			if (stored && stored.matchId === matchId) {
				deletes.push(key);
			}
		}
		if (deletes.length > 0) {
			await this.ctx.storage.delete(deletes);
		}
	}

	private async recordMatch(matchId: string) {
		try {
			await this.env.DB.prepare(
				"INSERT OR IGNORE INTO matches(id, status, created_at) VALUES (?, 'active', datetime('now'))",
			)
				.bind(matchId)
				.run();
		} catch (error) {
			console.error("Failed to record match", error);
		}
	}

	private async recordMatchPlayers(matchId: string, players: string[]) {
		try {
			const [playerA, playerB] = players;
			if (!playerA || !playerB) return;

			const ratings = await Promise.all(
				players.map((agentId) => this.getRating(agentId)),
			);
			const [ratingA, ratingB] = ratings;

			// Prompt locking rule (Workstream A): attach active prompt version at match creation time.
			const promptVersionByAgent = new Map<string, string>();
			try {
				const { results } = await this.env.DB.prepare(
					[
						"SELECT agent_id, prompt_version_id",
						"FROM agent_prompt_active",
						"WHERE game_type = ? AND agent_id IN (?, ?)",
					].join(" "),
				)
					.bind("hex_conquest", playerA, playerB)
					.all<{ agent_id: string; prompt_version_id: string }>();

				for (const row of results ?? []) {
					if (row.agent_id) {
						promptVersionByAgent.set(row.agent_id, row.prompt_version_id);
					}
				}
			} catch {
				// Best-effort: prompt versions are optional; never block matchmaking.
			}

			await this.env.DB.batch([
				this.env.DB.prepare(
					"INSERT OR IGNORE INTO match_players(match_id, agent_id, seat, starting_rating, prompt_version_id) VALUES (?, ?, ?, ?, ?)",
				).bind(
					matchId,
					playerA,
					0,
					ratingA,
					promptVersionByAgent.get(playerA) ?? null,
				),
				this.env.DB.prepare(
					"INSERT OR IGNORE INTO match_players(match_id, agent_id, seat, starting_rating, prompt_version_id) VALUES (?, ?, ?, ?, ?)",
				).bind(
					matchId,
					playerB,
					1,
					ratingB,
					promptVersionByAgent.get(playerB) ?? null,
				),
			]);
		} catch (error) {
			console.error("Failed to record match players", error);
		}
	}

	private async enqueueFeaturedMatch(matchId: string, players: string[]) {
		const current = await this.ctx.storage.get<string>(FEATURED_MATCH_KEY);
		if (current === matchId) return;

		const queue =
			(await this.ctx.storage.get<string[]>(FEATURED_QUEUE_KEY)) ?? [];
		if (queue.includes(matchId)) return;

		if (!current) {
			const snapshot: FeaturedCache = {
				matchId,
				status: "active",
				players: players.length > 0 ? players : null,
				checkedAt: Date.now(),
			};
			await this.ctx.storage.put(FEATURED_MATCH_KEY, matchId);
			await this.ctx.storage.put(FEATURED_CACHE_KEY, snapshot);
			return;
		}

		queue.push(matchId);
		await this.ctx.storage.put(FEATURED_QUEUE_KEY, queue);
	}

	private async getRating(agentId: string) {
		const row = await this.env.DB.prepare(
			"SELECT rating FROM leaderboard WHERE agent_id = ?",
		)
			.bind(agentId)
			.first<{ rating: number }>();
		return typeof row?.rating === "number" ? row.rating : ELO_START;
	}

	private requireRunnerKey(request: Request) {
		const expectedKey = this.env.INTERNAL_RUNNER_KEY;
		if (!expectedKey) {
			return {
				ok: false as const,
				response: Response.json(
					{
						error: "Internal auth not configured.",
						code: "internal_auth_not_configured",
					},
					{ status: 503 },
				),
			};
		}

		const providedKey = request.headers.get("x-runner-key");
		if (!providedKey || providedKey !== expectedKey) {
			return {
				ok: false as const,
				response: Response.json({ error: "Forbidden." }, { status: 403 }),
			};
		}

		return { ok: true as const };
	}

	private async resolveFeatured(options?: {
		force?: boolean;
		verifyDo?: boolean;
	}): Promise<FeaturedSnapshot> {
		const force = options?.force ?? false;
		const verifyDo = options?.verifyDo ?? true;
		const now = Date.now();

		if (!force) {
			const cached =
				await this.ctx.storage.get<FeaturedCache>(FEATURED_CACHE_KEY);
			if (cached && now - cached.checkedAt < FEATURED_CACHE_TTL_MS) {
				return {
					matchId: cached.matchId,
					status: cached.status,
					players: cached.players,
				};
			}
		}

		let matchId =
			(await this.ctx.storage.get<string>(FEATURED_MATCH_KEY)) ?? null;
		let status: FeaturedStatus | null = null;

		if (matchId) {
			status = await this.getMatchStatus(matchId);
			if (status !== "active") {
				matchId = null;
			} else if (verifyDo) {
				const available = await this.isMatchAvailable(matchId);
				if (!available) {
					matchId = null;
					status = null;
				}
			}
		}

		if (!matchId) {
			const next = await this.pickNextFeatured(verifyDo);
			matchId = next.matchId;
			status = next.status;
		}

		const snapshot = await this.buildFeaturedSnapshot(matchId, status);
		await this.ctx.storage.put(FEATURED_CACHE_KEY, {
			...snapshot,
			checkedAt: now,
		});
		return snapshot;
	}

	private async buildFeaturedSnapshot(
		matchId: string | null,
		status: FeaturedStatus | null,
	): Promise<FeaturedSnapshot> {
		if (!matchId || status !== "active") {
			return { matchId: null, status: null, players: null };
		}

		const players = await this.getMatchPlayers(matchId);
		return {
			matchId,
			status: "active",
			players: players && players.length > 0 ? players : null,
		};
	}

	private async pickNextFeatured(
		verifyDo: boolean,
	): Promise<{ matchId: string | null; status: FeaturedStatus | null }> {
		const queue =
			(await this.ctx.storage.get<string[]>(FEATURED_QUEUE_KEY)) ?? [];
		let selected: string | null = null;
		const remaining: string[] = [];

		for (const queuedId of queue) {
			if (selected) {
				remaining.push(queuedId);
				continue;
			}
			const status = await this.getMatchStatus(queuedId);
			if (status !== "active") {
				continue;
			}
			if (verifyDo) {
				const available = await this.isMatchAvailable(queuedId);
				if (!available) {
					continue;
				}
			}
			selected = queuedId;
		}

		await this.ctx.storage.put(FEATURED_QUEUE_KEY, remaining);

		if (selected) {
			await this.ctx.storage.put(FEATURED_MATCH_KEY, selected);
			return { matchId: selected, status: "active" };
		}

		await this.ctx.storage.delete(FEATURED_MATCH_KEY);
		return { matchId: null, status: null };
	}

	private async rotateFeatured(matchId: string) {
		const current = await this.ctx.storage.get<string>(FEATURED_MATCH_KEY);
		if (current !== matchId) return;
		await this.ctx.storage.delete(FEATURED_MATCH_KEY);
		await this.ctx.storage.delete(FEATURED_CACHE_KEY);
		await this.resolveFeatured({ force: true, verifyDo: true });
	}

	private async getMatchStatus(
		matchId: string,
	): Promise<FeaturedStatus | null> {
		const row = await this.env.DB.prepare(
			"SELECT status FROM matches WHERE id = ?",
		)
			.bind(matchId)
			.first<{ status: string | null }>();
		if (row?.status === "active" || row?.status === "ended") {
			return row.status;
		}
		return null;
	}

	private async getMatchPlayers(matchId: string): Promise<string[] | null> {
		const { results } = await this.env.DB.prepare(
			"SELECT agent_id FROM match_players WHERE match_id = ? ORDER BY seat ASC",
		)
			.bind(matchId)
			.all<{ agent_id: string }>();
		const players = (results ?? []).map((row) => row.agent_id).filter(Boolean);
		return players.length > 0 ? players : null;
	}

	private async isMatchAvailable(matchId: string): Promise<boolean> {
		try {
			const id = this.env.MATCH.idFromName(matchId);
			const stub = this.env.MATCH.get(id);
			const resp = await this.doFetchWithRetry(stub, "https://do/state");
			if (!resp.ok) return false;
			const payload = (await resp.json()) as { state?: unknown };
			return Boolean(payload?.state);
		} catch {
			return false;
		}
	}

	private async enqueueEvent(agentId: string, event: MatchmakerEvent) {
		const waiters = this.waiters.get(agentId);
		if (waiters && waiters.size > 0) {
			const [first] = waiters;
			if (first) {
				this.removeWaiter(agentId, first);
				first(event);
				return;
			}
		}

		const key = `${EVENT_BUFFER_PREFIX}${agentId}`;
		const events = (await this.ctx.storage.get<MatchmakerEvent[]>(key)) ?? [];
		events.push(event);
		if (events.length > EVENT_BUFFER_MAX) {
			events.splice(0, events.length - EVENT_BUFFER_MAX);
		}
		await this.ctx.storage.put(key, events);
	}

	private async waitForEvent(
		agentId: string,
		timeoutSeconds: number,
	): Promise<MatchmakerEvent> {
		const key = `${EVENT_BUFFER_PREFIX}${agentId}`;
		const events = (await this.ctx.storage.get<MatchmakerEvent[]>(key)) ?? [];
		if (events.length > 0) {
			const next = events[0];
			if (next) {
				await this.ctx.storage.put(key, events.slice(1));
				return next;
			}
		}

		return new Promise((resolve) => {
			const timeoutMs = Math.max(timeoutSeconds, 0) * 1000;
			let resolver: (event: MatchmakerEvent) => void;
			const timer = setTimeout(() => {
				this.removeWaiter(agentId, resolver);
				resolve(buildNoEventsEvent());
			}, timeoutMs);

			resolver = (event: MatchmakerEvent) => {
				clearTimeout(timer);
				this.removeWaiter(agentId, resolver);
				resolve(event);
			};

			const waiters = this.waiters.get(agentId) ?? new Set();
			waiters.add(resolver);
			this.waiters.set(agentId, waiters);
		});
	}

	private removeWaiter(
		agentId: string,
		resolver: (event: MatchmakerEvent) => void,
	) {
		const waiters = this.waiters.get(agentId);
		if (!waiters) return;
		waiters.delete(resolver);
		if (waiters.size === 0) {
			this.waiters.delete(agentId);
		}
	}
}
