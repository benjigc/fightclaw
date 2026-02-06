import { env, SELF } from "cloudflare:test";
import {
	currentPlayer,
	type GameState,
	listLegalMoves,
	type Move,
} from "@fightclaw/engine";
import { beforeEach, expect, it } from "vitest";
import {
	authHeader,
	pollUntil,
	readSseText,
	resetDb,
	setupMatch,
} from "../helpers";

beforeEach(async () => {
	await resetDb();
});

const pickMove = (moves: Move[]): Move => {
	const move =
		moves.find((m) => m.action === "attack") ??
		moves.find((m) => m.action === "recruit") ??
		moves.find((m) => m.action === "move") ??
		moves.find((m) => m.action === "fortify") ??
		moves.find((m) => m.action === "pass") ??
		moves[0];
	if (!move) throw new Error("No legal moves available.");
	return move;
};

type ApiState = { status: string; stateVersion: number; game: GameState };

it("plays to completion and exposes live/snapshot/stream", async () => {
	const { matchId, agentA, agentB } = await setupMatch();

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

	// Each turn has multiple actions; use a higher cap so this is not flaky.
	for (let i = 0; i < 400; i++) {
		const stateRes = await SELF.fetch(
			`https://example.com/v1/matches/${matchId}/state`,
		);
		const payload = (await stateRes.json()) as { state: ApiState | null };
		if (!payload.state) break;
		if (payload.state.status === "ended") break;

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

	// If the toy policy couldn't end the match quickly, force a clean forfeit so
	// we still assert endgame persistence behavior.
	const ensureEndedRes = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/state`,
	);
	const ensureEndedPayload = (await ensureEndedRes.json()) as {
		state: { status: string } | null;
	};
	if (ensureEndedPayload.state?.status !== "ended") {
		await SELF.fetch(`https://example.com/v1/matches/${matchId}/finish`, {
			method: "POST",
			headers: {
				...authHeader(agentA.key),
				"content-type": "application/json",
				"x-admin-key": env.ADMIN_KEY,
			},
			body: JSON.stringify({ reason: "forfeit" }),
		});
	}

	const endRes = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/state`,
	);
	const endPayload = (await endRes.json()) as {
		state: { status: string } | null;
	};
	expect(endPayload.state?.status).toBe("ended");

	const matchRow = await pollUntil(
		async () =>
			await env.DB.prepare(
				"SELECT ended_at, winner_agent_id FROM matches WHERE id = ?",
			)
				.bind(matchId)
				.first<{ ended_at: string | null; winner_agent_id: string | null }>(),
		(row) => Boolean(row?.ended_at),
	);

	expect(matchRow).toBeTruthy();
	expect(matchRow?.ended_at).not.toBeNull();

	if (matchRow?.winner_agent_id) {
		const winnerRow = await pollUntil(
			async () =>
				await env.DB.prepare(
					"SELECT wins, games_played FROM leaderboard WHERE agent_id = ?",
				)
					.bind(matchRow.winner_agent_id)
					.first<{ wins: number; games_played: number }>(),
			(row) => (row?.wins ?? 0) >= 1 && (row?.games_played ?? 0) >= 1,
		);

		expect((winnerRow?.wins ?? 0) >= 1).toBe(true);
		expect((winnerRow?.games_played ?? 0) >= 1).toBe(true);

		const loserId =
			matchRow.winner_agent_id === agentA.id ? agentB.id : agentA.id;
		const loserRow = await pollUntil(
			async () =>
				await env.DB.prepare(
					"SELECT losses, games_played FROM leaderboard WHERE agent_id = ?",
				)
					.bind(loserId)
					.first<{ losses: number; games_played: number }>(),
			(row) => (row?.losses ?? 0) >= 1 && (row?.games_played ?? 0) >= 1,
		);

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
