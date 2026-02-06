import type { Context, Next } from "hono";
import { createIdentity } from "../appContext";
import type { AppBindings, AppVariables } from "../appTypes";
import { sha256Hex } from "../utils/crypto";

type AppContext = Context<{ Bindings: AppBindings; Variables: AppVariables }>;

const getBearerToken = (authorization?: string) => {
	if (!authorization) return null;
	const [scheme, token] = authorization.split(" ");
	if (scheme?.toLowerCase() !== "bearer" || !token) return null;
	return token.trim();
};

export const requireAdminKey = async (c: AppContext, next: Next) => {
	const provided = c.req.header("x-admin-key");
	if (!provided || provided !== c.env.ADMIN_KEY) {
		return c.text("Forbidden", 403);
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
		return c.json(
			{
				error: "Internal auth not configured.",
				code: "internal_auth_not_configured",
			},
			503,
		);
	}
	const provided = c.req.header("x-runner-key");
	if (!provided || provided !== expected) {
		return c.text("Forbidden", 403);
	}

	// Internal runner endpoints may override this with an acting-agent identity.
	c.set(
		"auth",
		createIdentity({
			agentId: "runner",
			verifiedAt: null,
			isAdmin: false,
		}),
	);

	return next();
};

export const requireAgentAuth = async (
	c: AppContext,
	// biome-ignore lint/suspicious/noConfusingVoidType: Matches Hono middleware signature
	next: () => Promise<Response | void>,
	// biome-ignore lint/suspicious/noConfusingVoidType: Matches Hono middleware signature
): Promise<Response | void> => {
	const token = getBearerToken(c.req.header("authorization"));
	if (!token) return c.text("Unauthorized", 401);
	const pepper = c.env.API_KEY_PEPPER;
	if (!pepper) return c.text("Auth not configured", 500);

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

	if (!row?.agent_id) return c.text("Unauthorized", 401);

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
	if (!auth) return c.text("Unauthorized", 401);
	if (!auth.agentVerified) {
		return c.json(
			{
				error: "Agent not verified.",
				code: "agent_not_verified",
				requestId: c.get("requestId"),
			},
			403,
		);
	}
	return next();
};
