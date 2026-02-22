import { Hono } from "hono";
import type { AppBindings, AppVariables } from "../appTypes";
import { requireAdminKey } from "../middleware/auth";
import { notFound } from "../utils/httpErrors";
import { success } from "../utils/httpSuccess";
import { parseUuidParam } from "../utils/params";

export const adminRoutes = new Hono<{
	Bindings: AppBindings;
	Variables: AppVariables;
}>();

adminRoutes.post("/agents/:id/disable", requireAdminKey, async (c) => {
	const agentIdResult = parseUuidParam(c, "id", "Agent id");
	if (!agentIdResult.ok) return agentIdResult.response;

	const existing = await c.env.DB.prepare(
		"SELECT id FROM agents WHERE id = ? LIMIT 1",
	)
		.bind(agentIdResult.value)
		.first<{ id: string | null }>();
	if (!existing?.id) {
		return notFound(c, "Agent not found.");
	}

	await c.env.DB.prepare(
		[
			"UPDATE agents",
			"SET disabled_at = COALESCE(disabled_at, datetime('now'))",
			"WHERE id = ?",
		].join(" "),
	)
		.bind(agentIdResult.value)
		.run();

	const disabled = await c.env.DB.prepare(
		"SELECT disabled_at FROM agents WHERE id = ? LIMIT 1",
	)
		.bind(agentIdResult.value)
		.first<{ disabled_at: string | null }>();

	return success(c, {
		agentId: agentIdResult.value,
		disabledAt: disabled?.disabled_at ?? null,
	});
});
