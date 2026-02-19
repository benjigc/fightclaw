import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { authHeader, createAgent, resetDb } from "../helpers";

beforeEach(async () => {
	await resetDb();
});

it("enforces auth and upgrade preconditions on /ws", async () => {
	const unauth = await SELF.fetch("https://example.com/ws");
	expect(unauth.status).toBe(401);

	const agent = await createAgent("Alpha", "alpha-key");
	const noUpgrade = await SELF.fetch("https://example.com/ws", {
		headers: authHeader(agent.key),
	});
	expect(noUpgrade.status).toBe(426);
});

it("enforces upgrade precondition on /v1/matches/:id/ws", async () => {
	const agentA = await createAgent("Alpha", "alpha-key");
	const agentB = await createAgent("Beta", "beta-key");

	await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentA.key),
	});
	const join = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentB.key),
	});
	const joinJson = (await join.json()) as { matchId: string };
	const matchId = joinJson.matchId;

	const noUpgrade = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/ws`,
		{
			headers: authHeader(agentA.key),
		},
	);
	expect(noUpgrade.status).toBe(426);
});

it("allows admin finish to infer actor from bearer token for compatibility", async () => {
	const agentA = await createAgent("Alpha", "alpha-key");
	const agentB = await createAgent("Beta", "beta-key");

	await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentA.key),
	});
	const join = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentB.key),
	});
	const joinJson = (await join.json()) as { matchId: string };
	const matchId = joinJson.matchId;

	const finish = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/finish`,
		{
			method: "POST",
			headers: {
				...authHeader(agentA.key),
				"content-type": "application/json",
				"x-admin-key": env.ADMIN_KEY,
			},
			body: JSON.stringify({ reason: "forfeit" }),
		},
	);
	expect(finish.status).toBe(200);
});
