import { type Context, Hono } from "hono";
import { z } from "zod";
import { createIdentity } from "../appContext";
import type { AppBindings, AppVariables } from "../appTypes";
import { requireAdminKey } from "../middleware/auth";
import { withRequestId } from "../middleware/requestContext";
import { parseBearerToken } from "../utils/auth";
import { sha256Hex } from "../utils/crypto";
import { doFetchWithRetry, isDurableObjectResetError } from "../utils/durable";
import {
	badRequest,
	forbidden,
	notFound,
	unauthorized,
} from "../utils/httpErrors";
import { parseUuidParam } from "../utils/params";
import { adaptDoErrorEnvelope } from "../utils/responseAdapters";

type AppContext = Context<{ Bindings: AppBindings; Variables: AppVariables }>;

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

const getMatchmakerStub = (c: { env: AppBindings }) => {
	const id = c.env.MATCHMAKER.idFromName("global");
	return c.env.MATCHMAKER.get(id);
};

const getMatchStub = (c: { env: AppBindings }, matchId: string) => {
	const id = c.env.MATCH.idFromName(matchId);
	return c.env.MATCH.get(id);
};

const submitMove = async (
	c: AppContext,
	agentId: string,
	options?: { telemetryHeaders?: Record<string, string> },
) => {
	const matchIdResult = parseUuidParam(c, "id", "Match id");
	if (!matchIdResult.ok) return matchIdResult.response;

	const jsonResult = await parseJson(c);
	if (!jsonResult.ok) {
		return badRequest(c, "Invalid JSON body.");
	}

	const payloadResult = movePayloadSchema.safeParse(jsonResult.data);
	if (!payloadResult.success) {
		return badRequest(c, "Invalid move payload.");
	}

	const stub = getMatchStub(c, matchIdResult.value);
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"x-agent-id": agentId,
		"x-match-id": matchIdResult.value,
		"x-request-id": c.get("requestId"),
	};
	if (options?.telemetryHeaders) {
		for (const [key, value] of Object.entries(options.telemetryHeaders)) {
			headers[key] = value;
		}
	}
	const response = await stub.fetch("https://do/move", {
		method: "POST",
		body: JSON.stringify(payloadResult.data),
		headers,
	});
	return adaptDoErrorEnvelope(response);
};

export const matchesRoutes = new Hono<{
	Bindings: AppBindings;
	Variables: AppVariables;
}>();

matchesRoutes.post("/v1/matches/:id/move", async (c) => {
	const agentId = c.get("agentId");
	if (!agentId) return unauthorized(c);
	return submitMove(c, agentId);
});

matchesRoutes.post("/v1/internal/matches/:id/move", async (c) => {
	const agentId = c.req.header("x-agent-id");
	if (!agentId) return badRequest(c, "Agent id is required.");
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

matchesRoutes.post("/v1/internal/__test__/reset", async (c) => {
	if (!c.env.TEST_MODE) return notFound(c, "Not found");
	const expected = c.env.INTERNAL_RUNNER_KEY;
	if (!expected) {
		return c.json({ ok: false, error: "Internal auth not configured." }, 503);
	}

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

matchesRoutes.post("/v1/matches/:id/finish", requireAdminKey, async (c) => {
	const matchIdResult = parseUuidParam(c, "id", "Match id");
	if (!matchIdResult.ok) return matchIdResult.response;

	let agentId = c.req.header("x-agent-id");
	if (!agentId) {
		const token = parseBearerToken(c.req.header("authorization"));
		if (token && c.env.API_KEY_PEPPER) {
			const hash = await sha256Hex(`${c.env.API_KEY_PEPPER}${token}`);
			const row = await c.env.DB.prepare(
				[
					"SELECT agent_id",
					"FROM api_keys",
					"WHERE key_hash = ? AND revoked_at IS NULL",
					"LIMIT 1",
				].join(" "),
			)
				.bind(hash)
				.first<{ agent_id: string | null }>();
			if (row?.agent_id) {
				agentId = row.agent_id;
			}
		}
	}
	if (!agentId) {
		return badRequest(
			c,
			"Either x-agent-id header or Bearer token in Authorization header is required.",
		);
	}

	const jsonResult = await parseJson(c);
	if (!jsonResult.ok) {
		return badRequest(c, "Invalid JSON body.");
	}

	const payloadResult = finishPayloadSchema.safeParse(jsonResult.data);
	if (!payloadResult.success) {
		return badRequest(c, "Invalid finish payload.");
	}

	const stub = getMatchStub(c, matchIdResult.value);
	const response = await stub.fetch("https://do/finish", {
		method: "POST",
		body: JSON.stringify(payloadResult.data),
		headers: {
			"content-type": "application/json",
			"x-agent-id": agentId,
			"x-match-id": matchIdResult.value,
			"x-request-id": c.get("requestId"),
		},
	});
	return adaptDoErrorEnvelope(response);
});

matchesRoutes.get("/v1/matches/:id/state", async (c) => {
	const matchIdResult = parseUuidParam(c, "id", "Match id");
	if (!matchIdResult.ok) return matchIdResult.response;

	const stub = getMatchStub(c, matchIdResult.value);
	const response = await stub.fetch("https://do/state", {
		headers: {
			"x-match-id": matchIdResult.value,
			"x-request-id": c.get("requestId"),
		},
	});
	return adaptDoErrorEnvelope(response);
});

matchesRoutes.get("/v1/matches/:id/log", async (c) => {
	const matchIdResult = parseUuidParam(c, "id", "Match id");
	if (!matchIdResult.ok) return matchIdResult.response;

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
		.bind(matchIdResult.value)
		.first<{ status: string | null }>();
	if (!matchRow?.status) {
		return notFound(c, "Match not found.");
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
					isPublic = featured.matchId === matchIdResult.value;
				}
			}
		} catch {
			// Treat featured lookup failure as non-public.
		}
	}

	if (!isPublic) {
		const provided = c.req.header("x-admin-key");
		if (!provided || provided !== c.env.ADMIN_KEY) {
			return forbidden(c);
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
		.bind(matchIdResult.value, Number.isFinite(afterId) ? afterId : 0, limit)
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

	return c.json({ matchId: matchIdResult.value, events });
});

matchesRoutes.get("/v1/matches/:id/stream", async (c) => {
	const matchIdResult = parseUuidParam(c, "id", "Match id");
	if (!matchIdResult.ok) return matchIdResult.response;

	const agentId = c.get("agentId");
	if (!agentId) return unauthorized(c);

	const stub = getMatchStub(c, matchIdResult.value);
	const response = await stub.fetch("https://do/stream", {
		signal: c.req.raw.signal,
		headers: {
			"x-agent-id": agentId,
			"x-match-id": matchIdResult.value,
			"x-request-id": c.get("requestId"),
		},
	});
	return adaptDoErrorEnvelope(response);
});

matchesRoutes.get("/v1/matches/:id/events", async (c) => {
	const matchIdResult = parseUuidParam(c, "id", "Match id");
	if (!matchIdResult.ok) return matchIdResult.response;

	const stub = getMatchStub(c, matchIdResult.value);
	const response = await stub.fetch("https://do/events", {
		signal: c.req.raw.signal,
		headers: {
			"x-match-id": matchIdResult.value,
			"x-request-id": c.get("requestId"),
		},
	});
	return adaptDoErrorEnvelope(response);
});

matchesRoutes.get("/v1/matches/:id/spectate", async (c) => {
	const matchIdResult = parseUuidParam(c, "id", "Match id");
	if (!matchIdResult.ok) return matchIdResult.response;

	const matchRow = await c.env.DB.prepare(
		"SELECT status FROM matches WHERE id = ? LIMIT 1",
	)
		.bind(matchIdResult.value)
		.first<{ status: string | null }>();

	// Keep unknown match ids public for compatibility; enforce visibility only
	// when we know a currently-active match exists.
	let isPublic = !matchRow?.status || matchRow.status === "ended";
	if (!isPublic && matchRow?.status === "active") {
		try {
			const matchmaker = getMatchmakerStub(c);
			const featuredResp = await doFetchWithRetry(
				matchmaker,
				"https://do/featured",
				{
					headers: { "x-request-id": c.get("requestId") },
				},
			);
			if (featuredResp.ok) {
				const featured = (await featuredResp.json()) as { matchId?: unknown };
				if (featured && typeof featured.matchId === "string") {
					isPublic = featured.matchId === matchIdResult.value;
				}
			}
		} catch {
			// Treat featured lookup failure as non-public.
		}
	}

	if (!isPublic) {
		const provided = c.req.header("x-admin-key");
		if (!provided || provided !== c.env.ADMIN_KEY) {
			return forbidden(c);
		}
	}

	const stub = getMatchStub(c, matchIdResult.value);
	const response = await stub.fetch("https://do/spectate", {
		signal: c.req.raw.signal,
		headers: {
			"x-match-id": matchIdResult.value,
			"x-request-id": c.get("requestId"),
		},
	});
	return adaptDoErrorEnvelope(response);
});
