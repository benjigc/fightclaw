import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings, AppVariables } from "../appTypes";
import { badRequest, notFound, unauthorized } from "../utils/httpErrors";
import { parseUuidParam } from "../utils/params";

const bindPayloadSchema = z
	.object({
		agentId: z.string().uuid(),
	})
	.strict();

export const internalRunnerRoutes = new Hono<{
	Bindings: AppBindings;
	Variables: AppVariables;
}>();

internalRunnerRoutes.post("/runners/agents/bind", async (c) => {
	const runnerId = c.get("runnerId");
	if (!runnerId) return unauthorized(c);

	const json = await c.req.json().catch(() => null);
	const parsed = bindPayloadSchema.safeParse(json);
	if (!parsed.success) {
		return badRequest(c, "Invalid runner binding payload.");
	}

	const agent = await c.env.DB.prepare(
		"SELECT id FROM agents WHERE id = ? LIMIT 1",
	)
		.bind(parsed.data.agentId)
		.first<{ id: string | null }>();
	if (!agent?.id) {
		return notFound(c, "Agent not found.");
	}

	await c.env.DB.prepare(
		[
			"INSERT INTO runner_agent_ownership",
			"(runner_id, agent_id, created_at, revoked_at)",
			"VALUES (?, ?, datetime('now'), NULL)",
			"ON CONFLICT(runner_id, agent_id) DO UPDATE SET",
			"created_at=datetime('now'),",
			"revoked_at=NULL",
		].join(" "),
	)
		.bind(runnerId, parsed.data.agentId)
		.run();

	return c.json({
		ok: true,
		binding: {
			runnerId,
			agentId: parsed.data.agentId,
			revokedAt: null,
		},
	});
});

internalRunnerRoutes.post("/runners/agents/:agentId/revoke", async (c) => {
	const runnerId = c.get("runnerId");
	if (!runnerId) return unauthorized(c);
	const agentResult = parseUuidParam(c, "agentId", "Agent id");
	if (!agentResult.ok) return agentResult.response;

	await c.env.DB.prepare(
		[
			"UPDATE runner_agent_ownership",
			"SET revoked_at = datetime('now')",
			"WHERE runner_id = ? AND agent_id = ? AND revoked_at IS NULL",
		].join(" "),
	)
		.bind(runnerId, agentResult.value)
		.run();

	const row = await c.env.DB.prepare(
		[
			"SELECT revoked_at",
			"FROM runner_agent_ownership",
			"WHERE runner_id = ? AND agent_id = ?",
			"LIMIT 1",
		].join(" "),
	)
		.bind(runnerId, agentResult.value)
		.first<{ revoked_at: string | null }>();

	return c.json({
		ok: true,
		binding: {
			runnerId,
			agentId: agentResult.value,
			revokedAt: row?.revoked_at ?? null,
		},
	});
});
