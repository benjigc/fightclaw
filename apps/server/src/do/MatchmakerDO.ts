import { DurableObject } from "cloudflare:workers";
import {
	buildMatchFoundEvent,
	buildNoEventsEvent,
	type MatchFoundEvent,
	type NoEventsEvent,
} from "../protocol/events";

const LATEST_MATCH_KEY = "latestMatchId";
const PENDING_MATCH_KEY = "pendingMatchId";
const PENDING_AGENT_KEY = "pendingAgentId";
const FEATURED_MATCH_KEY = "featuredMatchId";
const FEATURED_QUEUE_KEY = "featuredQueue";
const FEATURED_CACHE_KEY = "featuredCache";
const FEATURED_CACHE_TTL_MS = 10_000;
const EVENT_BUFFER_PREFIX = "events:";
const EVENT_BUFFER_MAX = 25;
const ELO_START = 1500;

type MatchmakerEnv = {
	DB: D1Database;
	MATCH: DurableObjectNamespace;
	INTERNAL_RUNNER_KEY?: string;
};

type QueueResponse = { matchId: string; status: "waiting" | "ready" };
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

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "POST" && url.pathname === "/queue") {
			const agentId = request.headers.get("x-agent-id");
			if (!agentId) {
				return Response.json(
					{ error: "Agent id is required." },
					{ status: 400 },
				);
			}

			const pendingMatchId =
				await this.ctx.storage.get<string>(PENDING_MATCH_KEY);
			const pendingAgentId =
				await this.ctx.storage.get<string>(PENDING_AGENT_KEY);

			if (pendingMatchId && pendingAgentId) {
				if (pendingAgentId === agentId) {
					const response: QueueResponse = {
						matchId: pendingMatchId,
						status: "waiting",
					};
					return Response.json(response);
				}

				await this.ctx.storage.delete(PENDING_MATCH_KEY);
				await this.ctx.storage.delete(PENDING_AGENT_KEY);
				await this.ctx.storage.put(LATEST_MATCH_KEY, pendingMatchId);

				const players = [pendingAgentId, agentId];
				const id = this.env.MATCH.idFromName(pendingMatchId);
				const stub = this.env.MATCH.get(id);
				await stub.fetch("https://do/init", {
					method: "POST",
					body: JSON.stringify({
						players,
						seed: Math.floor(Math.random() * 1_000_000),
					}),
					headers: {
						"content-type": "application/json",
						"x-match-id": pendingMatchId,
					},
				});

				await this.recordMatchPlayers(pendingMatchId, players);
				await this.enqueueFeaturedMatch(pendingMatchId, players);
				await this.enqueueEvent(
					pendingAgentId,
					buildMatchFoundEvent(pendingMatchId, agentId),
				);
				await this.enqueueEvent(
					agentId,
					buildMatchFoundEvent(pendingMatchId, pendingAgentId),
				);

				const response: QueueResponse = {
					matchId: pendingMatchId,
					status: "ready",
				};
				return Response.json(response);
			}

			const matchId = crypto.randomUUID();
			await this.ctx.storage.put(PENDING_MATCH_KEY, matchId);
			await this.ctx.storage.put(PENDING_AGENT_KEY, agentId);
			await this.ctx.storage.put(LATEST_MATCH_KEY, matchId);
			await this.recordMatch(matchId);

			const response: QueueResponse = { matchId, status: "waiting" };
			return Response.json(response);
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

			const body = await request.json().catch(() => null);
			const matchId = typeof body?.matchId === "string" ? body.matchId : null;
			if (!matchId) {
				return Response.json(
					{ error: "matchId is required." },
					{ status: 400 },
				);
			}

			await this.rotateFeatured(matchId);
			return Response.json({ ok: true });
		}

		if (request.method === "POST" && url.pathname === "/featured/queue") {
			const auth = this.requireRunnerKey(request);
			if (!auth.ok) return auth.response;

			const body = await request.json().catch(() => null);
			const matchId = typeof body?.matchId === "string" ? body.matchId : null;
			if (!matchId) {
				return Response.json(
					{ error: "matchId is required." },
					{ status: 400 },
				);
			}

			const players = Array.isArray(body?.players)
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
			const resp = await stub.fetch("https://do/state");
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

	private async recordMatch(matchId: string) {
		try {
			await this.env.DB.prepare(
				"INSERT INTO matches(id, status, created_at) VALUES (?, 'active', datetime('now'))",
			)
				.bind(matchId)
				.run();
		} catch (error) {
			console.error("Failed to record match", error);
		}
	}

	private async recordMatchPlayers(matchId: string, players: string[]) {
		try {
			const ratings = await Promise.all(
				players.map((agentId) => this.getRating(agentId)),
			);
			await this.env.DB.batch([
				this.env.DB.prepare(
					"INSERT OR IGNORE INTO match_players(match_id, agent_id, seat, starting_rating, prompt_version_id) VALUES (?, ?, ?, ?, NULL)",
				).bind(matchId, players[0], 0, ratings[0]),
				this.env.DB.prepare(
					"INSERT OR IGNORE INTO match_players(match_id, agent_id, seat, starting_rating, prompt_version_id) VALUES (?, ?, ?, ?, NULL)",
				).bind(matchId, players[1], 1, ratings[1]),
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

		let matchId = await this.ctx.storage.get<string>(FEATURED_MATCH_KEY);
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
			const resp = await stub.fetch("https://do/state");
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
			const [next, ...rest] = events;
			await this.ctx.storage.put(key, rest);
			return next;
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
