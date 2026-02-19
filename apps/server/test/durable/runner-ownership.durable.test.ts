import { env, SELF } from "cloudflare:test";
import { currentPlayer, listLegalMoves } from "@fightclaw/engine";
import { beforeEach, expect, it } from "vitest";
import {
	bindRunnerAgent,
	resetDb,
	runnerHeaders,
	setupMatch,
} from "../helpers";

beforeEach(async () => {
	await resetDb();
});

it("allows bound runner-agent and blocks revoked binding", async () => {
	const { matchId, agentA, agentB } = await setupMatch();
	await bindRunnerAgent(agentA.id);
	await bindRunnerAgent(agentB.id);

	const stateRes = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/state`,
	);
	const statePayload = (await stateRes.json()) as {
		state: {
			stateVersion: number;
			game: Parameters<typeof listLegalMoves>[0];
		} | null;
	};
	const state = statePayload.state;
	expect(state).toBeTruthy();
	const game = state?.game;
	if (!game) throw new Error("Missing game state.");
	const actingAgentId = currentPlayer(game);
	const move = listLegalMoves(game)[0];
	if (!move) throw new Error("No legal move available.");

	const moveRes = await SELF.fetch(
		`https://example.com/v1/internal/matches/${matchId}/move`,
		{
			method: "POST",
			headers: {
				...runnerHeaders(),
				"content-type": "application/json",
				"x-agent-id": actingAgentId,
			},
			body: JSON.stringify({
				moveId: crypto.randomUUID(),
				expectedVersion: state?.stateVersion ?? 0,
				move,
				publicThought: "Public-safe thought",
			}),
		},
	);
	expect([200, 400, 409]).toContain(moveRes.status);

	const revokeRes = await SELF.fetch(
		`https://example.com/v1/internal/runners/agents/${actingAgentId}/revoke`,
		{
			method: "POST",
			headers: runnerHeaders(),
		},
	);
	expect(revokeRes.status).toBe(200);

	const blockedRes = await SELF.fetch(
		`https://example.com/v1/internal/matches/${matchId}/move`,
		{
			method: "POST",
			headers: {
				...runnerHeaders(),
				"content-type": "application/json",
				"x-agent-id": actingAgentId,
			},
			body: JSON.stringify({
				moveId: crypto.randomUUID(),
				expectedVersion: state?.stateVersion ?? 0,
				move: { action: "pass" },
			}),
		},
	);
	expect(blockedRes.status).toBe(403);
	const blockedJson = (await blockedRes.json()) as { code?: string };
	expect(blockedJson.code).toBe("runner_agent_not_bound");
});

it("requires x-runner-id on internal routes", async () => {
	const res = await SELF.fetch(
		"https://example.com/v1/internal/runners/agents/bind",
		{
			method: "POST",
			headers: {
				"x-runner-key": env.INTERNAL_RUNNER_KEY ?? "",
				"content-type": "application/json",
			},
			body: JSON.stringify({ agentId: crypto.randomUUID() }),
		},
	);
	expect(res.status).toBe(400);
});
