import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { authHeader, createAgent, resetDb } from "../helpers";

beforeEach(async () => {
	await resetDb();
});

const setupMatch = async () => {
	const agentA = await createAgent("Alpha", "alpha-key");
	const agentB = await createAgent("Beta", "beta-key");

	const first = await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: authHeader(agentA.key),
	});
	const firstJson = (await first.json()) as { matchId: string };

	const second = await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: authHeader(agentB.key),
	});
	const secondJson = (await second.json()) as { matchId: string };

	return {
		matchId: secondJson.matchId ?? firstJson.matchId,
		agentA,
		agentB,
	};
};

it("forfeits on turn timeout via alarm", async () => {
	const { matchId } = await setupMatch();

	// @ts-expect-error MATCH is dynamic unless in your Env type
	const id = env.MATCH.idFromName(matchId);
	// @ts-expect-error MATCH is dynamic unless in your Env type
	const stub = env.MATCH.get(id);

	await runInDurableObject(stub, async (instance: unknown, state) => {
		const stored = await state.storage.get<Record<string, unknown>>("state");
		if (!stored) return new Response("missing state", { status: 500 });
		await state.storage.put("state", {
			...stored,
			turnExpiresAtMs: Date.now() - 1,
		});
		const anyInstance = instance as { alarm?: () => Promise<void> };
		await anyInstance.alarm?.();
		return new Response("ok");
	});

	const matchRow = await env.DB.prepare(
		"SELECT status, ended_at FROM matches WHERE id = ?",
	)
		.bind(matchId)
		.first<{ status: string | null; ended_at: string | null }>();

	expect(matchRow?.status).toBe("ended");
	expect(matchRow?.ended_at).not.toBeNull();

	const resultRow = await env.DB.prepare(
		"SELECT winner_agent_id, loser_agent_id, reason FROM match_results WHERE match_id = ?",
	)
		.bind(matchId)
		.first<{
			winner_agent_id: string | null;
			loser_agent_id: string | null;
			reason: string | null;
		}>();

	expect(resultRow?.reason).toBe("turn_timeout");
	expect(resultRow?.winner_agent_id).not.toBeNull();
	expect(resultRow?.loser_agent_id).not.toBeNull();
});

it("forfeits opportunistically on state fetch after timeout", async () => {
	const { matchId } = await setupMatch();

	// @ts-expect-error MATCH is dynamic unless in your Env type
	const id = env.MATCH.idFromName(matchId);
	// @ts-expect-error MATCH is dynamic unless in your Env type
	const stub = env.MATCH.get(id);

	await runInDurableObject(stub, async (_instance: unknown, state) => {
		const stored = await state.storage.get<Record<string, unknown>>("state");
		if (!stored) return new Response("missing state", { status: 500 });
		await state.storage.put("state", {
			...stored,
			turnExpiresAtMs: Date.now() - 1,
		});
		return new Response("ok");
	});

	const stateRes = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/state`,
	);
	expect(stateRes.status).toBe(200);
	const stateJson = (await stateRes.json()) as {
		state: { status?: string } | null;
	};
	expect(stateJson.state?.status).toBe("ended");

	const resultRow = await env.DB.prepare(
		"SELECT reason FROM match_results WHERE match_id = ?",
	)
		.bind(matchId)
		.first<{ reason: string | null }>();
	expect(resultRow?.reason).toBe("turn_timeout");
});
