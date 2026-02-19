import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { authHeader, pollUntil, resetDb, setupMatch } from "../helpers";

beforeEach(async () => {
	await resetDb();
});

it("finalizes match persistence after finish (no SSE)", async () => {
	const { matchId, agentA } = await setupMatch();

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
				"SELECT status, ended_at, winner_agent_id, end_reason, final_state_version, mode FROM matches WHERE id = ?",
			)
				.bind(matchId)
				.first<{
					status: string | null;
					ended_at: string | null;
					winner_agent_id: string | null;
					end_reason: string | null;
					final_state_version: number | null;
					mode: string | null;
				}>(),
		(row) => Boolean(row?.ended_at),
	);

	expect(matchRow?.status).toBe("ended");
	expect(matchRow?.ended_at).not.toBeNull();
	expect(matchRow?.end_reason).toBe("forfeit");
	expect(typeof matchRow?.final_state_version).toBe("number");
	expect(matchRow?.mode).toBe("ranked");

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

	const endedEvents = await env.DB.prepare(
		"SELECT COUNT(*) as count FROM match_events WHERE match_id = ? AND event_type = 'match_ended'",
	)
		.bind(matchId)
		.first<{ count: number }>();
	expect(endedEvents?.count).toBe(1);
});
