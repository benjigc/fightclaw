import { env } from "@fightclaw/env/server";
import * as Sentry from "@sentry/cloudflare";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

import { createIdentity } from "./appContext";
import type { AppBindings, AppVariables } from "./appTypes";
import { MatchDO as MatchDOBase } from "./do/MatchDO";
import { MatchmakerDO as MatchmakerDOBase } from "./do/MatchmakerDO";
import {
	requireAdminKey,
	requireAgentAuth,
	requireRunnerKey,
	requireVerifiedAgent,
} from "./middleware/auth";
import { requestContext, withRequestId } from "./middleware/requestContext";
import { requestLogger } from "./obs/requestLogger";
import { sentryOptions } from "./obs/sentry";
import { authRoutes } from "./routes/auth";
import { internalPromptsRoutes, promptsRoutes } from "./routes/prompts";

const app = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

// Shared contracts (PR0): requestId + structured logs.
app.use("/*", requestContext);
app.use("/*", requestLogger);

app.onError((err, c) => {
	console.error("Unhandled error", err);
	const requestId = c.get("requestId") ?? crypto.randomUUID();
	const agentId = c.get("agentId");
	Sentry.captureException(err, {
		tags: {
			request_id: requestId,
			...(agentId ? { agent_id: agentId } : {}),
		},
	});
	c.header("x-request-id", requestId);
	return c.json({ ok: false, error: "Internal error.", requestId }, 500);
});
const allowedOrigins = (env.CORS_ORIGIN ?? "")
	.split(",")
	.map((origin) => origin.trim())
	.filter(Boolean);

const readMethods = new Set(["GET", "HEAD"]);

const getIpKey = (c: {
	req: { header: (name: string) => string | undefined };
}) => {
	const ip =
		c.req.header("cf-connecting-ip") ??
		c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
	return `ip:${ip ?? "unknown"}`;
};

const getAgentKey = (c: {
	req: { header: (name: string) => string | undefined };
}) => {
	const agentId = c.req.header("x-agent-id");
	if (agentId) return `agent:${agentId}`;
	const auth = c.req.header("authorization");
	if (auth) return `auth:${auth}`;
	return getIpKey(c);
};

const getMatchmakerStub = (c: { env: AppBindings }) => {
	const id = c.env.MATCHMAKER.idFromName("global");
	return c.env.MATCHMAKER.get(id);
};

const getMatchStub = (c: { env: AppBindings }, matchId: string) => {
	const id = c.env.MATCH.idFromName(matchId);
	return c.env.MATCH.get(id);
};

const matchIdSchema = z.string().uuid();

const movePayloadSchema = z
	.object({
		moveId: z.string().min(1),
		expectedVersion: z.number().int(),
		move: z.unknown(),
	})
	.strict();

const finishPayloadSchema = z
	.object({
		reason: z.literal("forfeit").optional(),
	})
	.strict();

const parseJson = async (c: { req: { json: () => Promise<unknown> } }) => {
	try {
		return { ok: true as const, data: await c.req.json() };
	} catch {
		return { ok: false as const, data: null };
	}
};

const isDurableObjectResetError = (error: unknown) => {
	if (!error || typeof error !== "object") return false;
	const anyErr = error as { message?: unknown; durableObjectReset?: unknown };
	if (anyErr.durableObjectReset === true) return true;
	const message = typeof anyErr.message === "string" ? anyErr.message : "";
	return message.includes("invalidating this Durable Object");
};

const doFetchWithRetry = async (
	stub: { fetch: (input: string, init?: RequestInit) => Promise<Response> },
	input: string,
	init?: RequestInit,
	retries = 2,
) => {
	let attempt = 0;
	for (;;) {
		try {
			return await stub.fetch(input, init);
		} catch (error) {
			if (attempt >= retries || !isDurableObjectResetError(error)) throw error;
			attempt += 1;
			await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
		}
	}
};

const corsMiddleware = cors({
	origin: (origin) => {
		if (!origin) return undefined;
		return allowedOrigins.includes(origin) ? origin : undefined;
	},
	allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
});

app.use("/*", async (c, next) => {
	if (c.req.path.startsWith("/v1/internal/")) {
		return next();
	}
	return corsMiddleware(c, next);
});

app.options("/v1/internal/*", (c) => c.text("Forbidden", 403));

// Internal runner protection contract (PR0).
app.use("/v1/internal/*", requireRunnerKey);

app.use("/*", async (c, next) => {
	const isRead = readMethods.has(c.req.method);
	const limiter = isRead ? c.env.READ_LIMIT : c.env.MOVE_SUBMIT_LIMIT;
	if (!limiter) return next();

	const key = isRead ? getIpKey(c) : getAgentKey(c);
	const outcome = await limiter.limit({ key });
	if (!outcome.success) return c.text("Too Many Requests", 429);

	return next();
});

const submitMove = async (
	c: Context<{ Bindings: AppBindings; Variables: AppVariables }>,
	agentId: string,
	options?: { telemetryHeaders?: Record<string, string> },
) => {
	const matchId = c.req.param("id");
	const matchIdResult = matchIdSchema.safeParse(matchId);
	if (!matchIdResult.success) {
		return c.json({ ok: false, error: "Match id must be a UUID." }, 400);
	}

	const jsonResult = await parseJson(c);
	if (!jsonResult.ok) {
		return c.json({ ok: false, error: "Invalid JSON body." }, 400);
	}

	const payloadResult = movePayloadSchema.safeParse(jsonResult.data);
	if (!payloadResult.success) {
		return c.json({ ok: false, error: "Invalid move payload." }, 400);
	}

	const stub = getMatchStub(c, matchIdResult.data);
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"x-agent-id": agentId,
		"x-match-id": matchIdResult.data,
		"x-request-id": c.get("requestId"),
	};
	if (options?.telemetryHeaders) {
		for (const [key, value] of Object.entries(options.telemetryHeaders)) {
			headers[key] = value;
		}
	}
	return stub.fetch("https://do/move", {
		method: "POST",
		body: JSON.stringify(payloadResult.data),
		headers,
	});
};

const queueJoin = async (
	c: Context<{ Bindings: AppBindings; Variables: AppVariables }>,
) => {
	const agentId = c.get("agentId");
	if (!agentId) return c.text("Unauthorized", 401);

	const stub = getMatchmakerStub(c);
	return doFetchWithRetry(stub, "https://do/queue/join", {
		method: "POST",
		headers: {
			"x-agent-id": agentId,
			"x-request-id": c.get("requestId"),
		},
	});
};

const queueStatus = async (
	c: Context<{ Bindings: AppBindings; Variables: AppVariables }>,
) => {
	const agentId = c.get("agentId");
	if (!agentId) return c.text("Unauthorized", 401);

	const stub = getMatchmakerStub(c);
	return doFetchWithRetry(stub, "https://do/queue/status", {
		headers: {
			"x-agent-id": agentId,
			"x-request-id": c.get("requestId"),
		},
	});
};

const queueLeave = async (
	c: Context<{ Bindings: AppBindings; Variables: AppVariables }>,
) => {
	const agentId = c.get("agentId");
	if (!agentId) return c.text("Unauthorized", 401);

	const stub = getMatchmakerStub(c);
	return doFetchWithRetry(stub, "https://do/queue/leave", {
		method: "DELETE",
		headers: {
			"x-agent-id": agentId,
			"x-request-id": c.get("requestId"),
		},
	});
};

app.use("/v1/matches/*", async (c, next) => {
	const path = c.req.path;
	if (
		c.req.method === "GET" &&
		(path.endsWith("/state") ||
			path.endsWith("/spectate") ||
			path.endsWith("/events") ||
			path.endsWith("/log"))
	) {
		return next();
	}
	// Admin-only match finalization should not require agent auth.
	if (path.endsWith("/finish")) return next();

	return requireAgentAuth(c, async () => {
		if (
			path.startsWith("/v1/matches/queue") ||
			(c.req.method === "POST" && path.endsWith("/move")) ||
			(c.req.method === "GET" && path.endsWith("/stream"))
		) {
			return requireVerifiedAgent(c, next);
		}
		return next();
	});
});

app.use("/v1/events/*", async (c, next) => {
	return requireAgentAuth(c, async () => {
		return requireVerifiedAgent(c, next);
	});
});

app.use("/v1/queue/*", async (c, next) => {
	return requireAgentAuth(c, async () => {
		return requireVerifiedAgent(c, next);
	});
});

// Workstream A routes.
app.route("/v1/auth", authRoutes);
app.route("/v1/agents", promptsRoutes);
// Internal runner prompt injection (Workstream A).
app.route("/v1/internal", internalPromptsRoutes);

app.get("/", (c) => {
	return c.text("OK");
});

app.get("/health", (c) => {
	return c.text("OK");
});

app.post("/v1/queue/join", async (c) => {
	return queueJoin(c);
});

app.get("/v1/queue/status", async (c) => {
	return queueStatus(c);
});

app.delete("/v1/queue/leave", async (c) => {
	return queueLeave(c);
});

app.post("/v1/matches/queue", async (c) => {
	return queueJoin(c);
});

app.get("/v1/matches/queue/status", async (c) => {
	return queueStatus(c);
});

app.post("/v1/matches/queue/leave", async (c) => {
	return queueLeave(c);
});

app.get("/v1/events/wait", async (c) => {
	const agentId = c.get("agentId");
	if (!agentId) return c.text("Unauthorized", 401);

	const stub = getMatchmakerStub(c);
	const timeout = c.req.query("timeout");
	const qs = timeout ? `?timeout=${encodeURIComponent(timeout)}` : "";
	return doFetchWithRetry(stub, `https://do/events/wait${qs}`, {
		headers: {
			"x-agent-id": agentId,
			"x-request-id": c.get("requestId"),
		},
	});
});

app.get("/v1/featured", async (c) => {
	const stub = getMatchmakerStub(c);
	return doFetchWithRetry(stub, "https://do/featured", {
		headers: {
			"x-request-id": c.get("requestId"),
		},
	});
});

app.post("/v1/matches/:id/move", async (c) => {
	const agentId = c.get("agentId");
	if (!agentId) return c.text("Unauthorized", 401);
	return submitMove(c, agentId);
});

app.post("/v1/internal/matches/:id/move", async (c) => {
	const agentId = c.req.header("x-agent-id");
	if (!agentId) return c.text("Agent id is required.", 400);
	// Internal runner calls aren't bearer-auth; set for correlation/logging.
	c.set("agentId", agentId);
	c.set("auth", createIdentity({ agentId }));

	const telemetryHeaders: Record<string, string> = {};
	for (const key of [
		"x-fc-model-provider",
		"x-fc-model-id",
		"x-fc-prompt-version-id",
		"x-fc-inference-ms",
		"x-fc-tokens-in",
		"x-fc-tokens-out",
	]) {
		const value = c.req.header(key);
		if (value) telemetryHeaders[key] = value;
	}

	return submitMove(c, agentId, { telemetryHeaders });
});

app.post("/v1/internal/__test__/reset", async (c) => {
	if (!c.env.TEST_MODE) return c.text("Not found", 404);
	const expected = c.env.INTERNAL_RUNNER_KEY;
	if (!expected) return c.text("Internal auth not configured.", 503);

	for (let attempt = 1; attempt <= 10; attempt += 1) {
		try {
			const stub = getMatchmakerStub(c);
			const resp = await stub.fetch("https://do/__test__/reset", {
				method: "POST",
				headers: withRequestId(c, { "x-runner-key": expected }),
			});
			if (resp.ok) return c.json({ ok: true });
		} catch (error) {
			if (!isDurableObjectResetError(error)) throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
	}

	return c.json({ ok: false, error: "Reset unavailable." }, 503);
});

app.post("/v1/matches/:id/finish", requireAdminKey, async (c) => {
	const matchId = c.req.param("id");
	const matchIdResult = matchIdSchema.safeParse(matchId);
	if (!matchIdResult.success) {
		return c.json({ ok: false, error: "Match id must be a UUID." }, 400);
	}

	const agentId = c.req.header("x-agent-id");
	if (!agentId) {
		return c.json({ ok: false, error: "x-agent-id header is required." }, 400);
	}

	const jsonResult = await parseJson(c);
	if (!jsonResult.ok) {
		return c.json({ ok: false, error: "Invalid JSON body." }, 400);
	}

	const payloadResult = finishPayloadSchema.safeParse(jsonResult.data);
	if (!payloadResult.success) {
		return c.json({ ok: false, error: "Invalid finish payload." }, 400);
	}

	const stub = getMatchStub(c, matchIdResult.data);
	return stub.fetch("https://do/finish", {
		method: "POST",
		body: JSON.stringify(payloadResult.data),
		headers: {
			"content-type": "application/json",
			"x-agent-id": agentId,
			"x-match-id": matchIdResult.data,
			"x-request-id": c.get("requestId"),
		},
	});
});

app.get("/v1/matches/:id/state", async (c) => {
	const matchId = c.req.param("id");
	const matchIdResult = matchIdSchema.safeParse(matchId);
	if (!matchIdResult.success) {
		return c.json({ ok: false, error: "Match id must be a UUID." }, 400);
	}

	const stub = getMatchStub(c, matchIdResult.data);
	return stub.fetch("https://do/state", {
		headers: {
			"x-match-id": matchIdResult.data,
			"x-request-id": c.get("requestId"),
		},
	});
});

app.get("/v1/matches/:id/log", async (c) => {
	const matchId = c.req.param("id");
	const matchIdResult = matchIdSchema.safeParse(matchId);
	if (!matchIdResult.success) {
		return c.json({ ok: false, error: "Match id must be a UUID." }, 400);
	}

	const afterIdRaw = c.req.query("afterId");
	const limitRaw = c.req.query("limit");
	const afterId = afterIdRaw ? Number.parseInt(afterIdRaw, 10) : 0;
	const requestedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : 500;
	const limit =
		Number.isFinite(requestedLimit) && requestedLimit > 0
			? Math.min(requestedLimit, 5000)
			: 500;

	const matchRow = await c.env.DB.prepare(
		"SELECT status FROM matches WHERE id = ? LIMIT 1",
	)
		.bind(matchIdResult.data)
		.first<{ status: string | null }>();
	if (!matchRow?.status) {
		return c.json({ ok: false, error: "Match not found." }, 404);
	}

	let isPublic = matchRow.status === "ended";
	if (!isPublic && matchRow.status === "active") {
		try {
			const stub = getMatchmakerStub(c);
			const featuredResp = await doFetchWithRetry(stub, "https://do/featured", {
				headers: { "x-request-id": c.get("requestId") },
			});
			if (featuredResp.ok) {
				const featured = (await featuredResp.json()) as { matchId?: unknown };
				if (featured && typeof featured.matchId === "string") {
					isPublic = featured.matchId === matchIdResult.data;
				}
			}
		} catch {
			// Treat featured lookup failure as non-public.
		}
	}

	if (!isPublic) {
		const provided = c.req.header("x-admin-key");
		if (!provided || provided !== c.env.ADMIN_KEY) {
			return c.text("Forbidden", 403);
		}
	}

	const { results } = await c.env.DB.prepare(
		[
			"SELECT id, match_id, turn, ts, event_type, payload_json",
			"FROM match_events",
			"WHERE match_id = ? AND id > ?",
			"ORDER BY id ASC",
			"LIMIT ?",
		].join(" "),
	)
		.bind(matchIdResult.data, Number.isFinite(afterId) ? afterId : 0, limit)
		.all<{
			id: number;
			match_id: string;
			turn: number;
			ts: string;
			event_type: string;
			payload_json: string;
		}>();

	const events = (results ?? []).map((row) => {
		let payload: unknown | null = null;
		let payloadParseError: true | undefined;
		try {
			payload = JSON.parse(row.payload_json);
		} catch {
			payload = null;
			payloadParseError = true;
		}
		return {
			id: row.id,
			matchId: row.match_id,
			turn: row.turn,
			ts: row.ts,
			eventType: row.event_type,
			payload,
			...(payloadParseError ? { payloadParseError } : {}),
		};
	});

	return c.json({ matchId: matchIdResult.data, events });
});

app.get("/v1/matches/:id/stream", async (c) => {
	const matchId = c.req.param("id");
	const matchIdResult = matchIdSchema.safeParse(matchId);
	if (!matchIdResult.success) {
		return c.json({ ok: false, error: "Match id must be a UUID." }, 400);
	}

	const agentId = c.get("agentId");
	if (!agentId) return c.text("Unauthorized", 401);

	const stub = getMatchStub(c, matchIdResult.data);
	return stub.fetch("https://do/stream", {
		signal: c.req.raw.signal,
		headers: {
			"x-agent-id": agentId,
			"x-match-id": matchIdResult.data,
			"x-request-id": c.get("requestId"),
		},
	});
});

app.get("/v1/matches/:id/events", async (c) => {
	const matchId = c.req.param("id");
	const matchIdResult = matchIdSchema.safeParse(matchId);
	if (!matchIdResult.success) {
		return c.json({ ok: false, error: "Match id must be a UUID." }, 400);
	}

	const stub = getMatchStub(c, matchIdResult.data);
	return stub.fetch("https://do/events", {
		signal: c.req.raw.signal,
		headers: {
			"x-match-id": matchIdResult.data,
			"x-request-id": c.get("requestId"),
		},
	});
});

app.get("/v1/matches/:id/spectate", async (c) => {
	const matchId = c.req.param("id");
	const matchIdResult = matchIdSchema.safeParse(matchId);
	if (!matchIdResult.success) {
		return c.json({ ok: false, error: "Match id must be a UUID." }, 400);
	}

	const stub = getMatchStub(c, matchIdResult.data);
	return stub.fetch("https://do/spectate", {
		signal: c.req.raw.signal,
		headers: {
			"x-match-id": matchIdResult.data,
			"x-request-id": c.get("requestId"),
		},
	});
});

app.get("/v1/leaderboard", async (c) => {
	try {
		const { results } = await c.env.DB.prepare(
			"SELECT agent_id, rating, wins, losses, games_played, updated_at FROM leaderboard ORDER BY rating DESC LIMIT 100",
		).all();
		return c.json({ leaderboard: results ?? [] });
	} catch (error) {
		console.error("Failed to load leaderboard", error);
		return c.json({ error: "Leaderboard unavailable" }, 500);
	}
});

app.get("/v1/live", async (c) => {
	const stub = getMatchmakerStub(c);
	return doFetchWithRetry(stub, "https://do/live", {
		headers: {
			"x-request-id": c.get("requestId"),
		},
	});
});

// Type assertions needed because Sentry wrapper expects exact SentryEnv,
// but our DO envs extend it with additional bindings (DB, MATCH, etc.)
export const MatchDO = Sentry.instrumentDurableObjectWithSentry(
	sentryOptions,
	// biome-ignore lint/suspicious/noExplicitAny: Sentry wrapper type mismatch
	MatchDOBase as any,
);
export const MatchmakerDO = Sentry.instrumentDurableObjectWithSentry(
	sentryOptions,
	// biome-ignore lint/suspicious/noExplicitAny: Sentry wrapper type mismatch
	MatchmakerDOBase as any,
);

export default Sentry.withSentry(sentryOptions, app);
