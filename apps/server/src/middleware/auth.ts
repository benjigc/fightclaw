import type { Context, Next } from "hono";
import { createIdentity } from "../appContext";
import type { AppBindings, AppVariables } from "../appTypes";
import { sha256Hex } from "../utils/crypto";
import {
	badRequest,
	forbidden,
	internalServerError,
	serviceUnavailable,
	unauthorized,
} from "../utils/httpErrors";

type AppContext = Context<{ Bindings: AppBindings; Variables: AppVariables }>;

const getBearerToken = (authorization?: string) => {
	if (!authorization) return null;
	const [scheme, token] = authorization.split(" ");
	if (scheme?.toLowerCase() !== "bearer" || !token) return null;
	return token.trim();
};

const RUNNER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;

const readRunnerId = (raw?: string | null) => {
	const value = raw?.trim() ?? "";
	if (!value) return null;
	return RUNNER_ID_RE.test(value) ? value : null;
};

export const requireAdminKey = async (c: AppContext, next: Next) => {
	const provided = c.req.header("x-admin-key");
	if (!provided || provided !== c.env.ADMIN_KEY) {
		return forbidden(c);
	}

	// Provide a stable identity object for admin-authenticated requests.
	c.set(
		"auth",
		createIdentity({
			agentId: "admin",
			verifiedAt: null,
			isAdmin: true,
		}),
	);

	return next();
};

export const requireRunnerKey = async (c: AppContext, next: Next) => {
	const expected = c.env.INTERNAL_RUNNER_KEY;
	if (!expected) {
		return serviceUnavailable(c, "Internal auth not configured.", {
			code: "internal_auth_not_configured",
		});
	}
	const provided = c.req.header("x-runner-key");
	if (!provided || provided !== expected) {
		return forbidden(c);
	}
	const runnerId = readRunnerId(c.req.header("x-runner-id"));
	if (!runnerId) {
		return badRequest(c, "Valid x-runner-id is required.", {
			code: "invalid_runner_id",
		});
	}

	// Internal runner endpoints may override this with an acting-agent identity.
	c.set(
		"auth",
		createIdentity({
			agentId: `runner:${runnerId}`,
			verifiedAt: null,
			isAdmin: false,
		}),
	);
	c.set("runnerId", runnerId);

	return next();
};

export const requireAgentAuth = async (
	c: AppContext,
	// biome-ignore lint/suspicious/noConfusingVoidType: Matches Hono middleware signature
	next: () => Promise<Response | void>,
	// biome-ignore lint/suspicious/noConfusingVoidType: Matches Hono middleware signature
): Promise<Response | void> => {
	const token = getBearerToken(c.req.header("authorization"));
	if (!token) return unauthorized(c);
	const pepper = c.env.API_KEY_PEPPER;
	if (!pepper) return internalServerError(c, "Auth not configured");

	const hash = await sha256Hex(`${pepper}${token}`);
	const row = await c.env.DB.prepare(
		[
			"SELECT a.id as agent_id, k.id as api_key_id, a.verified_at as verified_at",
			"FROM api_keys k",
			"JOIN agents a ON a.id = k.agent_id",
			"WHERE k.key_hash = ? AND k.revoked_at IS NULL",
			"LIMIT 1",
		].join(" "),
	)
		.bind(hash)
		.first<{
			agent_id: string;
			api_key_id: string;
			verified_at: string | null;
		}>();

	if (!row?.agent_id) return unauthorized(c);

	const isAdmin = Boolean(
		c.req.header("x-admin-key") &&
			c.req.header("x-admin-key") === c.env.ADMIN_KEY,
	);

	c.set(
		"auth",
		createIdentity({
			agentId: row.agent_id,
			apiKeyId: row.api_key_id ?? undefined,
			verifiedAt: row.verified_at ?? null,
			isAdmin,
		}),
	);

	// Back-compat while handlers still read agentId directly.
	c.set("agentId", row.agent_id);

	return await next();
};

export const requireVerifiedAgent = async (c: AppContext, next: Next) => {
	const auth = c.get("auth");
	if (!auth) return unauthorized(c);
	if (!auth.agentVerified) {
		return c.json(
			{
				ok: false,
				error: "Agent not verified.",
				code: "agent_not_verified",
				requestId: c.get("requestId"),
			},
			403,
		);
	}
	return next();
};
