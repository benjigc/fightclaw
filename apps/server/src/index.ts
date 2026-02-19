import { env } from "@fightclaw/env/server";
import * as Sentry from "@sentry/cloudflare";
import { Hono } from "hono";
import { cors } from "hono/cors";

import type { AppBindings, AppVariables } from "./appTypes";
import { MatchDO as MatchDOBase } from "./do/MatchDO";
import { MatchmakerDO as MatchmakerDOBase } from "./do/MatchmakerDO";
import {
	requireAgentAuth,
	requireRunnerKey,
	requireVerifiedAgent,
} from "./middleware/auth";
import { requestContext } from "./middleware/requestContext";
import { requestLogger } from "./obs/requestLogger";
import { sentryOptions } from "./obs/sentry";
import { authRoutes } from "./routes/auth";
import { matchesRoutes } from "./routes/matches";
import { internalPromptsRoutes, promptsRoutes } from "./routes/prompts";
import { queueRoutes } from "./routes/queue";
import { systemRoutes } from "./routes/system";
import { sha256Hex } from "./utils/crypto";
import { doFetchWithRetry } from "./utils/durable";
import {
	badRequest,
	conflict,
	forbidden,
	notFound,
	serviceUnavailable,
	tooManyRequests,
	unauthorized,
	upgradeRequired,
} from "./utils/httpErrors";

const app = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

const getMatchmakerStub = (env: AppBindings) => {
	const id = env.MATCHMAKER.idFromName("global");
	return env.MATCHMAKER.get(id);
};

const getMatchStub = (env: AppBindings, matchId: string) => {
	const id = env.MATCH.idFromName(matchId);
	return env.MATCH.get(id);
};

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

const getAgentKey = async (c: {
	env: { API_KEY_PEPPER?: string };
	req: { header: (name: string) => string | undefined };
}) => {
	const agentId = c.req.header("x-agent-id");
	if (agentId) return `agent:${agentId}`;
	const auth = c.req.header("authorization");
	if (auth) {
		const pepper = c.env.API_KEY_PEPPER ?? "";
		const hash = await sha256Hex(`${pepper}${auth}`);
		return `auth:${hash.slice(0, 24)}`;
	}
	return getIpKey(c);
};

const isLocalHost = (host: string) => {
	return (
		host === "localhost" ||
		host.startsWith("localhost:") ||
		host === "127.0.0.1" ||
		host.startsWith("127.0.0.1:") ||
		host === "[::1]" ||
		host.startsWith("[::1]:")
	);
};

const isHttpsRequest = (c: {
	req: {
		url: string;
		header: (name: string) => string | undefined;
	};
}) => {
	const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
	if (proto?.toLowerCase() === "https") return true;
	try {
		return new URL(c.req.url).protocol === "https:";
	} catch {
		return false;
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

app.use("/*", async (c, next) => {
	if (c.env.TEST_MODE) return next();
	const host = c.req.header("host") ?? "";
	if (isLocalHost(host) || isHttpsRequest(c)) {
		return next();
	}
	return badRequest(c, "HTTPS is required.", { code: "https_required" });
});

app.options("/v1/internal/*", (c) => forbidden(c));

// Internal runner protection contract (PR0).
app.use("/v1/internal/*", requireRunnerKey);

app.use("/*", async (c, next) => {
	const isRead = readMethods.has(c.req.method);
	const limiter = isRead ? c.env.READ_LIMIT : c.env.MOVE_SUBMIT_LIMIT;
	if (!limiter) return next();

	const key = isRead ? getIpKey(c) : await getAgentKey(c);
	const outcome = await limiter.limit({ key });
	if (!outcome.success) return tooManyRequests(c);

	return next();
});

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

app.get("/ws", async (c) => {
	const authResponse = await requireAgentAuth(c, async () => {});
	if (authResponse) return authResponse;
	const verifiedResponse = await requireVerifiedAgent(c, async () => {});
	if (verifiedResponse) return verifiedResponse;

	if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
		return upgradeRequired(c, "Expected websocket upgrade.");
	}
	const agentId = c.get("agentId");
	if (!agentId) return unauthorized(c);

	const stub = getMatchmakerStub(c.env);
	const upstream = await stub.fetch(c.req.raw);
	if (upstream.status !== 101) {
		return serviceUnavailable(
			c,
			`WebSocket upgrade failed (${upstream.status}).`,
		);
	}

	return upstream;
});

app.get("/v1/matches/:id/ws", async (c) => {
	const verifiedResponse = await requireVerifiedAgent(c, async () => {});
	if (verifiedResponse) return verifiedResponse;

	if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
		return upgradeRequired(c, "Expected websocket upgrade.");
	}

	const agentId = c.get("agentId");
	const matchId = c.req.param("id");
	if (!agentId || !matchId) return unauthorized(c);

	const matchmakerStub = getMatchmakerStub(c.env);
	const queueStatusResp = await doFetchWithRetry(
		matchmakerStub,
		"https://do/queue/status",
		{
			headers: {
				"x-agent-id": agentId,
				"x-request-id": c.get("requestId"),
			},
		},
	);
	if (!queueStatusResp.ok) return forbidden(c);
	const queueStatus = (await queueStatusResp.json()) as {
		status?: string;
		matchId?: string;
	};
	if (queueStatus.status !== "ready" || queueStatus.matchId !== matchId) {
		return conflict(c, "Agent is not currently matched to this match.", {
			code: "agent_not_matched",
		});
	}

	const matchStub = getMatchStub(c.env, matchId);
	const stateResp = await doFetchWithRetry(matchStub, "https://do/state", {
		headers: {
			"x-match-id": matchId,
			"x-request-id": c.get("requestId"),
		},
	});
	if (!stateResp.ok) return notFound(c, "Match unavailable.");
	const statePayload = (await stateResp.json()) as {
		state?: { players?: string[] } | null;
	};
	const players = Array.isArray(statePayload.state?.players)
		? statePayload.state?.players
		: [];
	if (!players.includes(agentId)) {
		return forbidden(c);
	}

	const upstream = await matchStub.fetch(c.req.raw);
	if (upstream.status !== 101) {
		return serviceUnavailable(
			c,
			`WebSocket upgrade failed (${upstream.status}).`,
		);
	}

	return upstream;
});

// Workstream A routes.
app.route("/v1/auth", authRoutes);
app.route("/v1/agents", promptsRoutes);
// Internal runner prompt injection (Workstream A).
app.route("/v1/internal", internalPromptsRoutes);
app.route("/", queueRoutes);
app.route("/", matchesRoutes);
app.route("/", systemRoutes);

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
