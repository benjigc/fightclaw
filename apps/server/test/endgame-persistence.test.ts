import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { authHeader, createAgent, resetDb } from "./helpers";

beforeEach(async () => {
	await resetDb();
});

const pollUntil = async <T>(
	fn: () => Promise<T>,
	predicate: (value: T) => boolean,
	timeoutMs = 2000,
	intervalMs = 50,
): Promise<T> => {
	const endAt = Date.now() + timeoutMs;
	let last = await fn();
	while (Date.now() < endAt) {
		if (predicate(last)) return last;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
		last = await fn();
	}
	return last;
};

it("finalizes match persistence after finish (no SSE)", async () => {
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

	await SELF.fetch(`https://example.com/v1/matches/${matchId}/finish`, {
		method: "POST",
		headers: {
			...authHeader(agentA.key),
			"content-type": "application/json",
			"x-admin-key": env.ADMIN_KEY,
		},
		body: JSON.stringify({ reason: "forfeit" }),
	});

	const stateJson = await pollUntil(
		async () => {
			const stateRes = await SELF.fetch(
				`https://example.com/v1/matches/${matchId}/state`,
			);
			return (await stateRes.json()) as { state: { status: string } | null };
		},
		(payload) => payload.state?.status === "ended",
	);
	expect(stateJson.state?.status).toBe("ended");

	const matchRow = await pollUntil(
		async () =>
			await env.DB.prepare(
				"SELECT status, ended_at, winner_agent_id FROM matches WHERE id = ?",
			)
				.bind(matchId)
				.first<{
					status: string | null;
					ended_at: string | null;
					winner_agent_id: string | null;
				}>(),
		(row) => Boolean(row?.ended_at),
	);

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
	expect(resultRow?.reason).toBe("forfeit");
	expect(resultRow?.winner_agent_id).not.toBeNull();
	expect(resultRow?.loser_agent_id).not.toBeNull();

	if (resultRow?.winner_agent_id) {
		const winnerRow = await env.DB.prepare(
			"SELECT wins, games_played FROM leaderboard WHERE agent_id = ?",
		)
			.bind(resultRow.winner_agent_id)
			.first<{ wins: number; games_played: number }>();
		expect((winnerRow?.games_played ?? 0) >= 1).toBe(true);
		expect((winnerRow?.wins ?? 0) >= 1).toBe(true);
	}
	if (resultRow?.loser_agent_id) {
		const loserRow = await env.DB.prepare(
			"SELECT losses, games_played FROM leaderboard WHERE agent_id = ?",
		)
			.bind(resultRow.loser_agent_id)
			.first<{ losses: number; games_played: number }>();
		expect((loserRow?.games_played ?? 0) >= 1).toBe(true);
		expect((loserRow?.losses ?? 0) >= 1).toBe(true);
	}
});
