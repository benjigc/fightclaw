import { env, SELF } from "cloudflare:test";
import {
	currentPlayer,
	type GameState,
	listLegalMoves,
	type Move,
} from "@fightclaw/engine";
import { beforeEach, expect, it } from "vitest";
import { authHeader, createAgent, readSseText, resetDb } from "../helpers";

beforeEach(async () => {
	await resetDb();
});

const pickMove = (moves: Move[]): Move => {
	return (
		moves.find((m) => m.type === "attack") ??
		moves.find((m) => m.type === "gather") ??
		moves.find((m) => m.type === "defend") ??
		moves[0]
	);
};

type ApiState = { status: string; stateVersion: number; game: GameState };

it("plays to completion and exposes live/snapshot/stream", async () => {
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

	const liveRes = await SELF.fetch("https://example.com/v1/live");
	const liveJson = (await liveRes.json()) as { matchId?: string | null };
	expect(liveJson.matchId).toBe(matchId);

	const snapshot = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/state`,
	);
	expect(snapshot.status).toBe(200);

	const controller = new AbortController();
	const spectateRes = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/spectate`,
		{
			signal: controller.signal,
		},
	);
	const sseText = await readSseText(spectateRes);
	controller.abort();
	expect(sseText.length).toBeGreaterThan(0);

	let _finalState: ApiState | null = null;
	for (let i = 0; i < 50; i++) {
		const stateRes = await SELF.fetch(
			`https://example.com/v1/matches/${matchId}/state`,
		);
		const payload = (await stateRes.json()) as { state: ApiState | null };
		if (!payload.state) break;
		if (payload.state.status === "ended") {
			_finalState = payload.state;
			break;
		}

		const game = payload.state.game;
		const activeId = currentPlayer(game);
		const moves = listLegalMoves(game);
		const move = pickMove(moves);
		const key = activeId === agentA.id ? agentA.key : agentB.key;

		const moveRes = await SELF.fetch(
			`https://example.com/v1/matches/${matchId}/move`,
			{
				method: "POST",
				headers: {
					...authHeader(key),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					moveId: crypto.randomUUID(),
					expectedVersion: payload.state.stateVersion,
					move,
				}),
			},
		);

		expect([200, 409, 400]).toContain(moveRes.status);
	}

	const endRes = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/state`,
	);
	const endPayload = (await endRes.json()) as {
		state: { status: string } | null;
	};
	expect(endPayload.state?.status).toBe("ended");

	const matchRow = await env.DB.prepare(
		"SELECT ended_at, winner_agent_id FROM matches WHERE id = ?",
	)
		.bind(matchId)
		.first<{ ended_at: string | null; winner_agent_id: string | null }>();

	expect(matchRow).toBeTruthy();
	expect(matchRow?.ended_at).not.toBeNull();

	if (matchRow?.winner_agent_id) {
		const winnerRow = await env.DB.prepare(
			"SELECT wins, games_played FROM leaderboard WHERE agent_id = ?",
		)
			.bind(matchRow.winner_agent_id)
			.first<{ wins: number; games_played: number }>();

		expect((winnerRow?.wins ?? 0) >= 1).toBe(true);
		expect((winnerRow?.games_played ?? 0) >= 1).toBe(true);

		const loserId =
			matchRow.winner_agent_id === agentA.id ? agentB.id : agentA.id;
		const loserRow = await env.DB.prepare(
			"SELECT losses, games_played FROM leaderboard WHERE agent_id = ?",
		)
			.bind(loserId)
			.first<{ losses: number; games_played: number }>();

		expect((loserRow?.losses ?? 0) >= 1).toBe(true);
		expect((loserRow?.games_played ?? 0) >= 1).toBe(true);
	}

	const playersRow = await env.DB.prepare(
		"SELECT COUNT(*) as count FROM match_players WHERE match_id = ?",
	)
		.bind(matchId)
		.first<{ count: number }>();
	expect(playersRow?.count).toBe(2);

	const eventsRow = await env.DB.prepare(
		"SELECT COUNT(*) as count FROM match_events WHERE match_id = ?",
	)
		.bind(matchId)
		.first<{ count: number }>();
	expect((eventsRow?.count ?? 0) > 0).toBe(true);
});
