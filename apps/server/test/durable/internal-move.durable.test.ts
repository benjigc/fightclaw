import { env, SELF } from "cloudflare:test";
import { currentPlayer, listLegalMoves } from "@fightclaw/engine";
import { beforeEach, expect, it } from "vitest";
import { authHeader, createAgent, resetDb } from "../helpers";

beforeEach(async () => {
	await resetDb();
});

const testMatchId = "11111111-1111-4111-8111-111111111111";

it("requires runner key for internal move", async () => {
	const res = await SELF.fetch(
		`https://example.com/v1/internal/matches/${testMatchId}/move`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-agent-id": "agent-1",
			},
			body: JSON.stringify({
				moveId: "test",
				expectedVersion: 0,
				move: { action: "pass" },
			}),
		},
	);
	expect(res.status).toBe(403);
});

it("accepts runner key + agent id", async () => {
	const agentA = await createAgent("Alpha", "alpha-key");
	const agentB = await createAgent("Beta", "beta-key");

	const first = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentA.key),
	});
	const firstJson = (await first.json()) as { matchId: string };

	const second = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentB.key),
	});
	const secondJson = (await second.json()) as { matchId: string };

	const matchId = secondJson.matchId ?? firstJson.matchId;
	const stateRes = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/state`,
	);
	const payload = (await stateRes.json()) as {
		state: { stateVersion: number; game: unknown } | null;
	};
	const state = payload.state;
	expect(state).toBeTruthy();

	const game = (state?.game ?? null) as Parameters<typeof listLegalMoves>[0];
	const activeId = currentPlayer(game);
	const moves = listLegalMoves(game);
	const move = moves[0];
	const actingId = activeId === agentA.id ? agentA.id : agentB.id;

	const res = await SELF.fetch(
		`https://example.com/v1/internal/matches/${matchId}/move`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-runner-key": env.INTERNAL_RUNNER_KEY ?? "",
				"x-agent-id": actingId,
			},
			body: JSON.stringify({
				moveId: crypto.randomUUID(),
				expectedVersion: state?.stateVersion ?? 0,
				move,
			}),
		},
	);

	expect([200, 400, 409]).toContain(res.status);
});
