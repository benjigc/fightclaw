import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { createAgent, resetDb } from "../helpers";

beforeEach(async () => {
	await resetDb();
});

it("requires admin key to disable an agent", async () => {
	const agent = await createAgent("Alpha", "alpha-key");

	const res = await SELF.fetch(
		`https://example.com/v1/admin/agents/${agent.id}/disable`,
		{
			method: "POST",
		},
	);

	expect(res.status).toBe(403);
});

it("disables agent idempotently", async () => {
	const agent = await createAgent("Beta", "beta-key");

	const first = await SELF.fetch(
		`https://example.com/v1/admin/agents/${agent.id}/disable`,
		{
			method: "POST",
			headers: {
				"x-admin-key": env.ADMIN_KEY,
			},
		},
	);
	expect(first.status).toBe(200);
	const firstJson = (await first.json()) as {
		agentId: string;
		disabledAt: string | null;
	};
	expect(firstJson.agentId).toBe(agent.id);
	expect(typeof firstJson.disabledAt).toBe("string");

	const second = await SELF.fetch(
		`https://example.com/v1/admin/agents/${agent.id}/disable`,
		{
			method: "POST",
			headers: {
				"x-admin-key": env.ADMIN_KEY,
			},
		},
	);
	expect(second.status).toBe(200);
	const secondJson = (await second.json()) as {
		disabledAt: string | null;
	};
	expect(secondJson.disabledAt).toBe(firstJson.disabledAt);
});

it("returns 404 for unknown agent", async () => {
	const res = await SELF.fetch(
		`https://example.com/v1/admin/agents/${crypto.randomUUID()}/disable`,
		{
			method: "POST",
			headers: {
				"x-admin-key": env.ADMIN_KEY,
			},
		},
	);

	expect(res.status).toBe(404);
});
