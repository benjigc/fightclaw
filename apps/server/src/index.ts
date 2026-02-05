import { env } from "@fightclaw/env/server";
import { type Context, Hono, type Next } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { z } from "zod";

type RateLimitBinding = {
	limit: (params: { key: string }) => Promise<{ success: boolean }>;
};

type AppBindings = {
	DB: D1Database;
	CORS_ORIGIN: string;
	API_KEY_PEPPER: string;
	ADMIN_KEY: string;
	INTERNAL_RUNNER_KEY?: string;
	MATCHMAKING_ELO_RANGE?: string;
	TURN_TIMEOUT_SECONDS?: string;
	TEST_MODE?: string;
	MATCHMAKER: DurableObjectNamespace;
	MATCH: DurableObjectNamespace;
	MOVE_SUBMIT_LIMIT?: RateLimitBinding;
	READ_LIMIT?: RateLimitBinding;
};

type AppVariables = {
	agentId: string;
};

const app = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

app.use(logger());
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

const getBearerToken = (authorization?: string) => {
	if (!authorization) return null;
	const [scheme, token] = authorization.split(" ");
	if (scheme?.toLowerCase() !== "bearer" || !token) return null;
	return token.trim();
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

const sha256Hex = async (input: string) => {
	const data = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
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

app.use("/*", async (c, next) => {
	const isRead = readMethods.has(c.req.method);
	const limiter = isRead ? c.env.READ_LIMIT : c.env.MOVE_SUBMIT_LIMIT;
	if (!limiter) return next();

	const key = isRead ? getIpKey(c) : getAgentKey(c);
	const outcome = await limiter.limit({ key });
	if (!outcome.success) return c.text("Too Many Requests", 429);

	return next();
});

const requireAgent = async (
	c: Context<{ Bindings: AppBindings; Variables: AppVariables }>,
	next: Next,
) => {
	const token = getBearerToken(c.req.header("authorization"));
	if (!token) return c.text("Unauthorized", 401);
	const pepper = c.env.API_KEY_PEPPER;
	if (!pepper) return c.text("Auth not configured", 500);

	const hash = await sha256Hex(`${pepper}${token}`);
	const row = await c.env.DB.prepare(
		"SELECT id FROM agents WHERE api_key_hash = ?",
	)
		.bind(hash)
		.first<{ id: string }>();

	if (!row?.id) return c.text("Unauthorized", 401);
	c.set("agentId", row.id);
	return next();
};

const getRunnerAgentId = (
	c: Context<{ Bindings: AppBindings; Variables: AppVariables }>,
) => {
	const expected = c.env.INTERNAL_RUNNER_KEY;
	if (!expected) {
		return {
			ok: false as const,
			response: c.json(
				{
					error: "Internal auth not configured.",
					code: "internal_auth_not_configured",
				},
				503,
			),
		};
	}
	const provided = c.req.header("x-runner-key");
	if (!provided || provided !== expected) {
		return { ok: false as const, response: c.text("Forbidden", 403) };
	}
	const agentId = c.req.header("x-agent-id");
	if (!agentId) {
		return {
			ok: false as const,
			response: c.text("Agent id is required.", 400),
		};
	}
	return { ok: true as const, agentId };
};

const submitMove = async (
	c: Context<{ Bindings: AppBindings; Variables: AppVariables }>,
	agentId: string,
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
	return stub.fetch("https://do/move", {
		method: "POST",
		body: JSON.stringify(payloadResult.data),
		headers: {
			"content-type": "application/json",
			"x-agent-id": agentId,
			"x-match-id": matchIdResult.data,
		},
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
		},
	});
};

app.use("/v1/matches/*", async (c, next) => {
	const path = c.req.path;
	if (
		c.req.method === "GET" &&
		(path.endsWith("/state") ||
			path.endsWith("/spectate") ||
			path.endsWith("/events"))
	) {
		return next();
	}
	return requireAgent(c, next);
});

app.use("/v1/events/*", async (c, next) => {
	return requireAgent(c, next);
});

app.use("/v1/queue/*", async (c, next) => {
	return requireAgent(c, next);
});

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
	const stub = getMatchmakerStub(c);
	const timeout = c.req.query("timeout");
	const qs = timeout ? `?timeout=${encodeURIComponent(timeout)}` : "";
	return doFetchWithRetry(stub, `https://do/events/wait${qs}`, {
		headers: {
			"x-agent-id": c.get("agentId"),
		},
	});
});

app.get("/v1/featured", async (c) => {
	const stub = getMatchmakerStub(c);
	return doFetchWithRetry(stub, "https://do/featured");
});

app.post("/v1/matches/:id/move", async (c) => {
	const agentId = c.get("agentId");
	if (!agentId) return c.text("Unauthorized", 401);
	return submitMove(c, agentId);
});

app.post("/v1/internal/matches/:id/move", async (c) => {
	const runner = getRunnerAgentId(c);
	if (!runner.ok) return runner.response;
	return submitMove(c, runner.agentId);
});

app.post("/v1/internal/__test__/reset", async (c) => {
	if (!c.env.TEST_MODE) return c.text("Not found", 404);
	const expected = c.env.INTERNAL_RUNNER_KEY;
	if (!expected) return c.text("Internal auth not configured.", 503);
	const provided = c.req.header("x-runner-key");
	if (!provided || provided !== expected) return c.text("Forbidden", 403);

	for (let attempt = 1; attempt <= 10; attempt += 1) {
		try {
			const stub = getMatchmakerStub(c);
			const resp = await stub.fetch("https://do/__test__/reset", {
				method: "POST",
				headers: {
					"x-runner-key": expected,
				},
			});
			if (resp.ok) return c.json({ ok: true });
		} catch (error) {
			if (!isDurableObjectResetError(error)) throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
	}

	return c.json({ ok: false, error: "Reset unavailable." }, 503);
});

app.post("/v1/matches/:id/finish", async (c) => {
	const matchId = c.req.param("id");
	const matchIdResult = matchIdSchema.safeParse(matchId);
	if (!matchIdResult.success) {
		return c.json({ ok: false, error: "Match id must be a UUID." }, 400);
	}

	const adminKey = c.req.header("x-admin-key");
	if (!adminKey || adminKey !== c.env.ADMIN_KEY) {
		return c.text("Forbidden", 403);
	}

	const agentId = c.get("agentId") ?? c.req.header("x-agent-id");
	if (!agentId) {
		return c.text("Unauthorized", 401);
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
		},
	});
});

app.get("/v1/matches/:id/stream", async (c) => {
	const matchId = c.req.param("id");
	const matchIdResult = matchIdSchema.safeParse(matchId);
	if (!matchIdResult.success) {
		return c.json({ ok: false, error: "Match id must be a UUID." }, 400);
	}

	const stub = getMatchStub(c, matchIdResult.data);
	return stub.fetch("https://do/stream", {
		signal: c.req.raw.signal,
		headers: {
			"x-agent-id": c.get("agentId"),
			"x-match-id": matchIdResult.data,
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
	return doFetchWithRetry(stub, "https://do/live");
});

export { MatchDO } from "./do/MatchDO";
export { MatchmakerDO } from "./do/MatchmakerDO";

export default app;
