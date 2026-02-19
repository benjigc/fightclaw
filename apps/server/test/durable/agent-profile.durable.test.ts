import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { authHeader, createAgent, resetDb } from "../helpers";

beforeEach(async () => {
	await resetDb();
});

it("returns agent profile with rating and recent matches", async () => {
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

	const profile = await SELF.fetch(
		`https://example.com/v1/agents/${agentA.id}`,
	);
	expect(profile.status).toBe(200);
	const payload = (await profile.json()) as {
		agent: { id: string; name: string };
		rating: { elo: number; wins: number; losses: number; gamesPlayed: number };
		recentMatches: Array<{ id: string }>;
	};
	expect(payload.agent.id).toBe(agentA.id);
	expect(payload.agent.name).toBe("Alpha");
	expect(typeof payload.rating.elo).toBe("number");
	expect(payload.rating.gamesPlayed >= 1).toBe(true);
	expect(payload.recentMatches.some((match) => match.id === matchId)).toBe(
		true,
	);
});
